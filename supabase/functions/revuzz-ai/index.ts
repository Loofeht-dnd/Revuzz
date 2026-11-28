/* ============================================================
   revuzz-ai - Supabase Edge Function
   ============================================================
   Turns a student's handout into a summary, quiz questions or an
   answer about the notes.

   The model key lives ONLY here, in Supabase secrets. The browser
   never sees it and cannot call the provider directly:

     browser  --JWT-->  revuzz-ai  --AI_API_KEY-->  provider

   Actions
     status     { }                        -> is AI configured, how much quota is left
     summary    { lesson_id | text }       -> short summary + key terms
     questions  { lesson_id | text, count, types } -> ready-to-play questions
     ask        { lesson_id | text, question }      -> answer + quoted sentences

   Secrets (Project Settings -> Edge Functions -> Secrets):
     AI_PROVIDER     none | mock | openai          (default none)
     AI_BASE_URL     https://api.groq.com/openai/v1
     AI_MODEL        openai/gpt-oss-20b
     AI_API_KEY      <key>
     AI_TIMEOUT_MS   60000      optional
     AI_MAX_CHARS    14000      optional, lesson text sent to the model
     AI_GLOBAL_DAILY 400        optional, calls per day across the whole class
     AI_ALLOWED_ORIGIN *        optional, lock CORS to your site

   "mock" is a clearly-labelled stand-in: it builds questions from the
   text with simple rules so the whole pipeline can be tested without
   a key. It is never presented as a real model.
   ============================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const PROVIDER = (Deno.env.get('AI_PROVIDER') ?? 'none').trim().toLowerCase()
const BASE_URL = (Deno.env.get('AI_BASE_URL') ?? '').trim().replace(/\/+$/, '')
const MODEL = (Deno.env.get('AI_MODEL') ?? '').trim()
const AI_KEY = (Deno.env.get('AI_API_KEY') ?? '').trim()
const TIMEOUT_MS = intEnv('AI_TIMEOUT_MS', 60000, 5000, 120000)
const MAX_CHARS = intEnv('AI_MAX_CHARS', 14000, 2000, 40000)
const GLOBAL_DAILY = intEnv('AI_GLOBAL_DAILY', 400, 0, 100000)
const MAX_QUESTIONS = intEnv('AI_MAX_QUESTIONS', 20, 1, 40)
const ALLOWED_ORIGIN = (Deno.env.get('AI_ALLOWED_ORIGIN') ?? '*').trim()

/* Mirrors the constants in revuzz_ai_reserve() so "x of 30 left" is
   truthful. If you change one, change the other. */
const CAP_CALLS = 30
const CAP_QUESTIONS = 300

const MOCK = PROVIDER === 'mock'
const OPENAI = PROVIDER === 'openai' && !!BASE_URL && !!MODEL && !!AI_KEY
const CONFIGURED = MOCK || OPENAI

const TYPES = ['mc', 'tf', 'id', 'en'] as const
type QType = typeof TYPES[number]

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(Deno.env.get(name) ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(Math.round(raw), min), max)
}

function cors(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    ...extra,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }),
  })
}

function fail(error: string, status: number, message?: string, extra: Record<string, unknown> = {}) {
  return json({ ok: false, error, message: message ?? error, ...extra }, status)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/* ---------------- request handling ---------------- */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() })
  if (req.method !== 'POST') return fail('method_not_allowed', 405)

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > 400_000) return fail('payload_too_large', 413, 'That file is too big for one request.')

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('bad_request', 400, 'Send a JSON body.')
  }
  const action = String(body.action ?? '').trim()

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return fail('not_signed_in', 401, 'Log in first.')

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let uid = ''
  try {
    const { data, error } = await userClient.auth.getUser(token)
    if (error || !data?.user) return fail('not_signed_in', 401, 'Your session expired. Log in again.')
    uid = data.user.id
  } catch {
    return fail('not_signed_in', 401, 'Your session expired. Log in again.')
  }

  try {
    switch (action) {
      case 'status': return await status(userClient)
      case 'summary':
      case 'questions':
      case 'ask': break
      default: return fail('bad_request', 400, 'Unknown action.')
    }

    if (!CONFIGURED) {
      return fail('ai_not_configured', 503,
        'AI is not configured yet. Ask the admin to add an AI key in Supabase.')
    }

    const lesson = await loadLesson(userClient, body)
    if ('error' in lesson) return fail(lesson.error, lesson.status, lesson.message)

    if (GLOBAL_DAILY > 0) {
      const used = await globalCallsToday(userClient)
      if (used >= GLOBAL_DAILY) {
        return fail('global_limit', 429,
          'The class AI budget for today is used up. Try again tomorrow.')
      }
    }

    const count = action === 'questions'
      ? Math.min(Math.max(Number(body.count) || 8, 1), MAX_QUESTIONS)
      : 0
    const types = action === 'questions' ? pickTypes(body.types) : []

    /* Charge before the call: a request the provider rejects still cost a
       round trip, and charging first means two tabs cannot spend 2x. A
       failed provider call is refunded below. */
    const quota = await reserve(userClient, 1, count)
    if (!quota.ok) {
      return fail('daily_limit', 429,
        'That is all the AI help for today. It resets at midnight Manila time.',
        { quota: quotaView(quota) })
    }

    let payload: Record<string, unknown>
    try {
      if (action === 'summary') payload = await doSummary(lesson)
      else if (action === 'questions') payload = await doQuestions(lesson, count, types)
      else payload = await doAsk(lesson, String(body.question ?? ''))
    } catch (e) {
      await refund(uid, 1, count)
      const msg = String((e as Error)?.message ?? e)
      console.error('[revuzz-ai] provider failed:', msg)
      if (/timeout|aborted/i.test(msg)) {
        return fail('provider_timeout', 504, 'The AI took too long to answer. Try again.')
      }
      return fail('provider_error', 502, 'The AI service did not answer. Try again in a minute.')
    }

    return json({
      ok: true,
      mode: MOCK ? 'demo' : 'live',
      ...payload,
      quota: quotaView(quota),
    })
  } catch (e) {
    console.error('[revuzz-ai] unhandled:', e)
    return fail('server_error', 500, 'Something went wrong on the server.')
  }
})

/* ---------------- auth / quota ---------------- */

type QuotaRow = {
  ok: boolean
  reason?: string
  used?: number
  used_questions?: number
  left?: number
  cap?: number
  cap_questions?: number
}

function quotaView(q: QuotaRow) {
  const used = Number(q.used ?? 0)
  const cap = Number(q.cap ?? CAP_CALLS)
  return {
    used,
    cap,
    left: Math.max(0, cap - used),
    questions_used: Number(q.used_questions ?? 0),
    questions_cap: Number(q.cap_questions ?? CAP_QUESTIONS),
  }
}

async function reserve(
  userClient: ReturnType<typeof createClient>,
  calls: number,
  questions: number,
): Promise<QuotaRow> {
  /* Runs as the signed-in student (auth.uid()), so the counter is theirs.
     The caps are constants inside the SQL function - see the comment there
     about why they cannot be parameters. */
  const { data, error } = await userClient.rpc('revuzz_ai_reserve', {
    p_calls: calls,
    p_questions: questions,
  })
  if (error) throw error
  return (data ?? { ok: false, reason: 'quota_unavailable' }) as QuotaRow
}

async function refund(uid: string, calls: number, questions: number) {
  try {
    await admin.rpc('revuzz_ai_refund', { p_user: uid, p_calls: calls, p_questions: questions })
  } catch { /* quota is best-effort; never fail the request for it */ }
}

async function globalCallsToday(userClient: ReturnType<typeof createClient>): Promise<number> {
  const { data, error } = await userClient.rpc('revuzz_ai_class_used')
  if (error) {
    console.error('[revuzz-ai] class usage read failed:', error.message)
    return 0
  }
  return Number(data ?? 0)
}

/* Quota is read through a security-definer RPC with the student's JWT, so the
   function needs no service-role key for a plain status check. */
async function quotaNow(userClient: ReturnType<typeof createClient>) {
  const { data } = await userClient.rpc('revuzz_ai_quota')
  const row = (data ?? {}) as { used?: number; questions?: number }
  const used = Number(row.used ?? 0)
  return {
    used,
    cap: CAP_CALLS,
    left: Math.max(0, CAP_CALLS - used),
    questions_used: Number(row.questions ?? 0),
    questions_cap: CAP_QUESTIONS,
  }
}

async function status(userClient: ReturnType<typeof createClient>) {
  const quota = await quotaNow(userClient)
  let globalUsed = 0
  if (GLOBAL_DAILY > 0) globalUsed = await globalCallsToday(userClient)
  return json({
    ok: true,
    configured: CONFIGURED,
    mode: MOCK ? 'demo' : OPENAI ? 'live' : 'off',
    provider: MOCK ? 'mock' : OPENAI ? 'openai' : 'none',
    model: OPENAI ? MODEL : null,
    limits: {
      questions_per_request: MAX_QUESTIONS,
      lesson_chars: MAX_CHARS,
    },
    quota,
    class_quota: GLOBAL_DAILY > 0
      ? { used: globalUsed, cap: GLOBAL_DAILY, left: Math.max(0, GLOBAL_DAILY - globalUsed) }
      : null,
  })
}

/* ---------------- lesson text ---------------- */

type Lesson = { title: string; text: string; truncated: boolean }

async function loadLesson(
  userClient: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
): Promise<Lesson | { error: string; status: number; message: string }> {
  const id = String(body.lesson_id ?? '').trim()
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return { error: 'bad_request', status: 400, message: 'Unknown lesson.' }
    }
    /* Read with the student's own token: row level security is the check
       that this lesson belongs to them. */
    const { data, error } = await userClient
      .from('lessons')
      .select('title,body')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return { error: 'lesson_not_found', status: 404, message: 'That handout is not yours, or was deleted.' }
    return clip(String(data.title ?? 'Lesson'), String(data.body ?? ''))
  }

  const text = String(body.text ?? '').trim()
  if (text.length < 40) {
    return { error: 'missing_text', status: 400, message: 'Upload a handout or paste at least a paragraph.' }
  }
  if (text.length > 20000) {
    return { error: 'text_too_long', status: 413, message: 'Paste up to 20,000 characters, or upload the file.' }
  }
  return clip(String(body.title ?? 'Pasted notes'), text)
}

function clip(title: string, text: string): Lesson {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  return {
    title: title.slice(0, 120),
    text: clean.slice(0, MAX_CHARS),
    truncated: clean.length > MAX_CHARS,
  }
}

/* ---------------- provider ---------------- */

const SYSTEM = [
  'You are a careful quiz writer for Revuzz, a Philippine high-school review game.',
  'You work only from the lesson text the user provides.',
  'Never add facts that are not in the text, and never guess an answer.',
  'If the text is too short or does not contain the requested material, say so in the JSON instead of inventing it.',
  'Write in the same language as the lesson (English, Filipino or Taglish).',
  'Reply with JSON only - no markdown, no commentary.',
].join(' ')

async function chat(messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.4,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: ctrl.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        /* 429 and 5xx are worth one retry; 4xx (bad key, bad model) is not. */
        const retryable = res.status === 429 || res.status >= 500
        lastErr = new Error(`provider ${res.status}: ${raw.slice(0, 300)}`)
        if (!retryable) throw lastErr
      } else {
        const parsed = JSON.parse(raw) as {
          choices?: Array<{ message?: { content?: string } }>
          error?: { message?: string }
        }
        if (parsed.error?.message) throw new Error(parsed.error.message)
        const content = parsed.choices?.[0]?.message?.content
        if (!content) throw new Error('provider returned an empty message')
        return content
      }
    } catch (e) {
      lastErr = e as Error
      if (/aborted|timeout/i.test(lastErr.message)) throw lastErr
    } finally {
      clearTimeout(timer)
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  throw lastErr ?? new Error('provider failed')
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  let t = String(raw ?? '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  const tries = [t, t.replace(/,\s*([}\]])/g, '$1')]
  for (const candidate of tries) {
    try {
      const v = JSON.parse(candidate)
      if (v && typeof v === 'object') return v as Record<string, unknown>
    } catch { /* next */ }
  }
  return null
}

/* ---------------- actions ---------------- */

async function doSummary(lesson: Lesson): Promise<Record<string, unknown>> {
  if (MOCK) return mockSummary(lesson)
  const raw = await chat([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Summarise this lesson for a student revising for a quiz.\n\n` +
        `Return JSON: {"summary":"3-5 sentences","key_terms":[{"term":"...","definition":"one sentence"}]}\n` +
        `Give 4-8 key terms, each defined using only the lesson text.\n\n` +
        `LESSON TITLE: ${lesson.title}\n\nLESSON TEXT:\n${lesson.text}`,
    },
  ], 900)

  const data = parseJsonLoose(raw)
  const summary = clean(String(data?.summary ?? ''), 1200)
  if (!summary) throw new Error('model returned no summary')
  const keyTerms = Array.isArray(data?.key_terms)
    ? (data!.key_terms as unknown[])
        .map((t) => {
          const o = (t ?? {}) as Record<string, unknown>
          return { term: clean(String(o.term ?? ''), 60), definition: clean(String(o.definition ?? ''), 200) }
        })
        .filter((t) => t.term && t.definition)
        .slice(0, 8)
    : []
  return { summary, key_terms: keyTerms, truncated: lesson.truncated }
}

async function doQuestions(lesson: Lesson, count: number, types: QType[]): Promise<Record<string, unknown>> {
  if (MOCK) return mockQuestions(lesson, count, types)

  const raw = await chat([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Write ${count} quiz questions from this lesson.\n\n` +
        `Allowed types: ${types.join(', ')}.\n` +
        `Return JSON exactly like this:\n` +
        `{"questions":[` +
        `{"type":"mc","prompt":"...","choices":["correct answer","wrong","wrong","wrong"],"answer":"correct answer","topic":"..."},` +
        `{"type":"tf","prompt":"...","answer":true,"topic":"..."},` +
        `{"type":"id","prompt":"...","answer":["accepted answer"],"topic":"..."},` +
        `{"type":"en","prompt":"Name the two ...","answer":["item one","item two"],"topic":"..."}]}\n\n` +
        `Rules:\n` +
        `- mc: exactly 4 choices, only one correct, "answer" must be one of the choices, wrong choices must be plausible but clearly wrong.\n` +
        `- tf: a single statement, answer true or false.\n` +
        `- id: one short answer, up to 3 accepted spellings in "answer".\n` +
        `- en: the question must ask for 2-4 specific items; "answer" lists exactly those items.\n` +
        `- Spread the questions across the whole lesson, not just the first paragraph.\n` +
        `- Do not repeat a question. Do not use "all of the above".\n\n` +
        `LESSON TITLE: ${lesson.title}\n\nLESSON TEXT:\n${lesson.text}`,
    },
  ], Math.min(3500, 220 * count + 400))

  const data = parseJsonLoose(raw)
  const list = Array.isArray(data?.questions) ? (data!.questions as unknown[]) : []
  const rows = normalizeAll(list, types, count)
  if (!rows.length) throw new Error('model returned no usable questions')
  return { questions: rows, requested: count, truncated: lesson.truncated }
}

async function doAsk(lesson: Lesson, question: string): Promise<Record<string, unknown>> {
  const qText = clean(question, 400)
  if (qText.length < 3) throw new Error('empty question')
  if (MOCK) return mockAsk(lesson, qText)

  const raw = await chat([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Answer the student's question using only this lesson.\n\n` +
        `Return JSON: {"answer":"2-4 sentences","sources":["short quote from the lesson"]}\n` +
        `If the lesson does not cover it, answer exactly: "That is not in your notes for this lesson." and leave sources empty.\n\n` +
        `QUESTION: ${qText}\n\nLESSON TITLE: ${lesson.title}\n\nLESSON TEXT:\n${lesson.text}`,
    },
  ], 700)

  const data = parseJsonLoose(raw)
  const answer = clean(String(data?.answer ?? ''), 1200)
  if (!answer) throw new Error('model returned no answer')
  const sources = Array.isArray(data?.sources)
    ? (data!.sources as unknown[]).map((s) => clean(String(s), 260)).filter(Boolean).slice(0, 3)
    : []
  return { answer, sources, question: qText }
}

/* ---------------- validation ---------------- */

function clean(s: string, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function pickTypes(raw: unknown): QType[] {
  const list = Array.isArray(raw) ? raw.map((t) => String(t)) : []
  const picked = list.filter((t): t is QType => (TYPES as readonly string[]).includes(t))
  return picked.length ? Array.from(new Set(picked)) : ['mc', 'tf']
}

type Row = {
  type: QType
  prompt: string
  choices: string[]
  answer: unknown
  topic: string
}

function normalizeAll(raw: unknown[], types: QType[], count: number): Row[] {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const item of raw) {
    const row = normalizeQuestion(item, types)
    if (!row) continue
    const key = row.prompt.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
    if (out.length >= count) break
  }
  return out
}

function normalizeQuestion(raw: unknown, types: QType[]): Row | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const type = String(o.type ?? '').toLowerCase() as QType
  if (!types.includes(type)) return null
  const prompt = clean(String(o.prompt ?? ''), 280)
  if (prompt.length < 8) return null
  const topic = clean(String(o.topic ?? ''), 60)

  if (type === 'mc') {
    const choices = Array.isArray(o.choices)
      ? (o.choices as unknown[]).map((c) => clean(String(c), 120)).filter(Boolean)
      : []
    const uniq: string[] = []
    for (const c of choices) {
      if (!uniq.some((u) => u.toLowerCase() === c.toLowerCase())) uniq.push(c)
    }
    if (uniq.length !== 4) return null
    const answer = clean(String(o.answer ?? ''), 120)
    const correct = uniq.find((c) => c.toLowerCase() === answer.toLowerCase())
    if (!correct) return null
    /* The game treats a[0] as the correct option. */
    return { type, prompt, choices: [correct, ...uniq.filter((c) => c !== correct)], answer: null, topic }
  }

  if (type === 'tf') {
    const bool = typeof o.answer === 'boolean'
      ? o.answer
      : /^(true|yes|1)$/i.test(String(o.answer ?? '').trim())
    return { type, prompt, choices: [], answer: bool, topic }
  }

  const answers = Array.isArray(o.answer)
    ? (o.answer as unknown[]).map((a) => clean(String(a), 80)).filter(Boolean)
    : [clean(String(o.answer ?? ''), 80)].filter(Boolean)
  const uniq = Array.from(new Set(answers.map((a) => a.toLowerCase())))
  if (type === 'id') {
    if (!uniq.length || uniq.length > 3) return null
    return { type, prompt, choices: [], answer: uniq, topic }
  }
  if (uniq.length < 2 || uniq.length > 4) return null
  return { type, prompt, choices: [], answer: uniq, topic }
}

/* ---------------- demo ("mock") mode ----------------
   No model is called. These rules make plausible-looking questions from
   the student's own text so the upload -> save -> generate -> play path
   can be tested end to end. The response says mode:"demo" and the app
   labels every card "Demo AI". */

const STOP = new Set(('about above after again against almost along also although always among another answer ' +
  'around because been before being below between both cannot could does doing down during each either ' +
  'every first from further have having here into itself just last many might more most much must ' +
  'never only other ought over same should since some such than that their them then there these ' +
  'they this those through under until very were what when where which while will with would your ' +
  'yours about above across actually also because before being between could different every example ' +
  'following however important includes including information mainly might other people please ' +
  'process really school should simple simply something sometimes student students teacher their ' +
  'there these thing things those through usually various which while within without').split(' '))

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 45 && s.length <= 260 && /[a-zA-Z]{4}/.test(s))
}

function terms(text: string): string[] {
  const freq = new Map<string, number>()
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z-]{4,}\b/g)) {
    const w = m[0]
    const key = w.toLowerCase()
    if (STOP.has(key)) continue
    freq.set(w, (freq.get(w) ?? 0) + (w[0] === w[0].toUpperCase() ? 2 : 1))
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w)
}

function mockSummary(lesson: Lesson): Record<string, unknown> {
  const sents = sentences(lesson.text)
  const top = terms(lesson.text).slice(0, 6)
  return {
    summary: (sents.slice(0, 3).join(' ') || clean(lesson.text, 600)).slice(0, 1200),
    key_terms: top.map((t) => ({ term: t, definition: 'Key term that appears in your notes.' })),
    demo: true,
    note: 'Demo mode: this summary is the first sentences of your notes, not a model output.',
    truncated: lesson.truncated,
  }
}

function mockQuestions(lesson: Lesson, count: number, types: QType[]): Record<string, unknown> {
  const sents = sentences(lesson.text)
  const vocab = terms(lesson.text).filter((t) => t.length >= 5)
  if (!sents.length || vocab.length < 5) {
    throw new Error('the text is too short to build questions')
  }
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length]
    const sent = sents[i % sents.length]
    const words = sent.match(/\b[A-Za-z][A-Za-z-]{4,}\b/g) ?? []
    const inSent = words.filter((w) => vocab.some((v) => v.toLowerCase() === w.toLowerCase()))
    const target = inSent[0] ?? words[0] ?? vocab[i % vocab.length]
    const distractors = vocab.filter((v) => v.toLowerCase() !== target.toLowerCase()).slice(i, i + 3)
    while (distractors.length < 3) distractors.push(vocab[(i + distractors.length + 3) % vocab.length])

    if (type === 'mc') {
      rows.push({
        type, prompt: sent.replace(target, '_____') + ' Which word completes the sentence?',
        choices: [target, ...distractors.slice(0, 3)], answer: null, topic: lesson.title,
      })
    } else if (type === 'tf') {
      const makeFalse = i % 2 === 1
      rows.push({
        type,
        prompt: makeFalse ? 'It is not true that ' + sent.charAt(0).toLowerCase() + sent.slice(1) : sent,
        choices: [], answer: !makeFalse, topic: lesson.title,
      })
    } else if (type === 'id') {
      rows.push({
        type, prompt: 'Which word is missing? ' + sent.replace(target, '_____'),
        choices: [], answer: [target], topic: lesson.title,
      })
    } else {
      const pair = vocab.filter((v) => v !== target).slice(i, i + 2)
      while (pair.length < 2) pair.push(vocab[(i + pair.length + 1) % vocab.length])
      rows.push({
        type, prompt: `Name two key terms used in this lesson. (Hint: one starts with "${pair[0][0]}".)`,
        choices: [], answer: pair.map((p) => p.toLowerCase()), topic: lesson.title,
      })
    }
  }
  return {
    questions: rows.slice(0, count),
    requested: count,
    demo: true,
    note: 'Demo mode: questions are built from your text with simple rules, not by a model.',
    truncated: lesson.truncated,
  }
}

function mockAsk(lesson: Lesson, question: string): Record<string, unknown> {
  const keys = (question.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w))
  const sents = sentences(lesson.text)
  const hits = sents.filter((s) => {
    const l = s.toLowerCase()
    return keys.some((k) => l.includes(k))
  })
  return {
    answer: hits.length
      ? hits.slice(0, 3).join(' ')
      : 'That is not in your notes for this lesson.',
    sources: hits.slice(0, 3),
    question,
    demo: true,
    note: 'Demo mode: keyword search in your notes, not a model answer.',
  }
}
