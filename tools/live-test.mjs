/* ============================================================
   Revuzz live database test
   Runs the real game flow against your Supabase project using
   only the PUBLISHABLE key - i.e. exactly what the browser can
   do. Verifies the schema, the RPCs, the anti-cheat rules and
   row-level security.

   Usage (from the revuzz-online folder):
     node tools/live-test.mjs

   It reads the url + key from config.js. Override with:
     SUPABASE_URL=... SUPABASE_KEY=... node tools/live-test.mjs

   Creates two throwaway students ("test_xxxxxx"). Delete them in
   Authentication -> Users afterwards if you like.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function readConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) return { url: url.replace(/\/+$/, ''), key };
  const file = path.join(ROOT, 'config.js');
  const src = fs.readFileSync(file, 'utf8');
  const grab = re => (src.match(re) || [])[1] || '';
  return {
    url: grab(/url:\s*'([^']+)'/).replace(/\/+$/, ''),
    key: grab(/anonKey:\s*'([^']+)'/)
  };
}

const CFG = readConfig();
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  if (!ok) failed++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -  ' + detail : ''}`);
  return ok;
}

async function call(pathname, { method = 'GET', body, token, apikey = CFG.key, headers = {} } = {}) {
  const res = await fetch(CFG.url + pathname, {
    method,
    headers: {
      apikey,
      Authorization: 'Bearer ' + (token || apikey),
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

const rpc = (name, args, token) => call('/rest/v1/rpc/' + name, { method: 'POST', body: args, token });
const errOf = r => String((r.data && (r.data.message || r.data.msg || r.data.hint)) || r.data || '');

function rand(n) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const stamp = rand(5);
const studentA = { sn: '99' + String(Date.now()).slice(-6), user: 'test_' + stamp };
const studentB = { sn: '98' + String(Date.now()).slice(-6), user: 'peer_' + stamp };
const emailOf = sn => sn + '@students.revuzz.app';
const PW = 'Revuzz-test-' + stamp;
const today = new Date().toISOString().slice(0, 10);

async function signUp(s) {
  return call('/auth/v1/signup', {
    method: 'POST',
    body: {
      email: emailOf(s.sn),
      password: PW,
      data: {
        student_number: s.sn,
        username: s.user,
        first_name: 'Test',
        middle_name: '',
        last_name: 'Student',
        email: '',
        grade: '11',
        strand: 'STEM',
        school_year: '2026-2027',
        avatar: { c: 1, e: 0, h: 0, g: 0, x: 0 }
      }
    }
  });
}

console.log('Revuzz live test');
console.log('  project :', CFG.url);
console.log('  key     :', CFG.key.slice(0, 14) + '...' + (CFG.key.length > 20 ? ` (${CFG.key.length} chars)` : ''));

if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(CFG.url)) {
  console.error('\nconfig.js has no real project URL. Fill it in first.');
  process.exit(2);
}
if (/^sb_secret_/.test(CFG.key) || /^sbp_/.test(CFG.key)) {
  console.error('\nThat is a SECRET key. This test must run with the publishable key.');
  process.exit(2);
}
if (/YOUR-/.test(CFG.key)) {
  console.error('\nconfig.js still has the placeholder key. Fill it in first.');
  process.exit(2);
}

/* ---------- 1. catalogs exist and are seeded ---------- */
{
  const t = await call('/rest/v1/themes?select=id&limit=20');
  check('themes table readable', t.ok, `HTTP ${t.status}`);
  check('themes seeded', Array.isArray(t.data) && t.data.length === 6, `${Array.isArray(t.data) ? t.data.length : '?'} rows`);

  const b = await call('/rest/v1/badges?select=id&limit=20');
  check('badges seeded', Array.isArray(b.data) && b.data.length === 10, `${Array.isArray(b.data) ? b.data.length : '?'} rows`);

  const a = await call('/rest/v1/accessories?select=key&limit=20');
  check('accessories seeded', Array.isArray(a.data) && a.data.length === 7, `${Array.isArray(a.data) ? a.data.length : '?'} rows`);

  const ident = await rpc('revuzz_check_identity', { p_student_number: '000000' });
  check('revuzz_check_identity callable by anon', ident.ok && ident.data && ident.data.exists === false, `HTTP ${ident.status}`);

  const anonGame = await rpc('revuzz_record_game', { p: { pos: 1, score: 1 } });
  check('anon cannot record a match', !anonGame.ok, `HTTP ${anonGame.status}`);
}

/* ---------- 2. sign up player A (trigger builds the profile) ---------- */
const upA = await signUp(studentA);
if (!upA.ok) {
  console.error('\nSign-up failed:', upA.status, JSON.stringify(upA.data));
  if (/confirm|email_address_invalid/i.test(JSON.stringify(upA.data) || '')) {
    console.error('Turn OFF Authentication -> Providers -> Email -> Confirm email, then rerun.');
  }
  process.exit(1);
}
const tokenA = upA.data?.access_token;
const idA = upA.data?.user?.id;
check('sign-up returned a session', !!tokenA, tokenA ? 'session issued' : 'no session (confirm email is probably on)');
if (!tokenA) process.exit(1);

{
  const p = await call(`/rest/v1/profiles?select=*&id=eq.${idA}`, { token: tokenA });
  const row = Array.isArray(p.data) ? p.data[0] : null;
  check('handle_new_user created the profile', !!row, `HTTP ${p.status}`);
  if (row) {
    check('student number stored', row.student_number === studentA.sn, row.student_number);
    check('username stored', row.username === studentA.user, row.username);
    check('new account starts as student', row.role === 'student', row.role);
    check('starter theme is cosmic', row.active_theme === 'cosmic', row.active_theme);
    check('new account starts at level 1 / 0 coins', row.level === 1 && row.coins === 0, `lvl ${row.level}, ${row.coins} coins`);
  }
}

/* ---------- 3. cosmetic snapshot (no money in it any more) ---------- */
const snapshot = {
  username: studentA.user,
  first_name: 'Test', middle_name: '', last_name: 'Student',
  grade: '11', strand: 'STEM', school_year: '2026-2027',
  avatar: { c: 2, e: 1, h: 0, g: 0, x: 0 },
  active_theme: 'cosmic',
  streak: 3,
  last_played_on: today,
  last_result: { mode: 'Classic', score: 900, pos: 2 },
  inventory: { f: 1, t: 0, s: 0 },
  preferences: { noVib: 1, ts: 0, rm: 0, hc: 1 },
  tour_done: true,
  /* the cheater's payload: these must all be ignored */
  xp: 999999, level: 99, coins: 999999, total_correct: 999,
  badges: ['win', 'fire', 'not_a_real_badge'],
  accessories: ['h5'],
  themes: ['cosmic', 'ocean'],
  modes: ['Classic', 'Quiz Royale'],
  today: { date: today, correct: 999, quest_done: true, spun: true },
  missed: [{ t: 'mc', q: 'What is 2+2?', a: ['4', '3', '5'], c: 0 }],
  questions: [
    { t: 'mc', q: 'Capital of France?', a: ['Paris', 'Rome'], topic: 'Geo' },
    { t: 'tf', q: 'Water boils at 100C.', c: true }
  ]
};

{
  const save = await rpc('revuzz_save_account', { p: snapshot }, tokenA);
  check('revuzz_save_account accepts the snapshot', save.ok, `HTTP ${save.status} ${save.ok ? '' : errOf(save)}`);
  check('save returns the real balances', save.ok && save.data && typeof save.data.coins === 'number',
    JSON.stringify(save.data));

  const p = await call(`/rest/v1/profiles?select=coins,xp,level,total_correct,grade,tour_done,inventory&id=eq.${idA}`, { token: tokenA });
  const row = (p.data || [])[0] || {};
  check('CHEAT BLOCKED: coins in the snapshot ignored', row.coins === 0, `coins ${row.coins}`);
  check('CHEAT BLOCKED: xp in the snapshot ignored', row.xp === 0, `xp ${row.xp}`);
  check('CHEAT BLOCKED: level in the snapshot ignored', row.level === 1, `level ${row.level}`);
  check('CHEAT BLOCKED: total_correct ignored', row.total_correct === 0, `total_correct ${row.total_correct}`);
  check('cosmetics still save (grade, tour)', row.grade === '11' && row.tour_done === true, `${row.grade}/${row.tour_done}`);

  const bd = await call(`/rest/v1/player_badges?select=badge_id&user_id=eq.${idA}`, { token: tokenA });
  const ids = (bd.data || []).map(r => r.badge_id).sort();
  check('owned badges saved, unknown id ignored', JSON.stringify(ids) === JSON.stringify(['fire', 'win']), JSON.stringify(ids));

  const mq = await call(`/rest/v1/missed_questions?select=prompt&user_id=eq.${idA}`, { token: tokenA });
  check('missed questions saved', (mq.data || []).length === 1, JSON.stringify((mq.data || []).map(r => r.prompt)));

  const cq = await call(`/rest/v1/custom_questions?select=type&order=position`, { token: tokenA });
  check('custom questions saved in order', (cq.data || []).length === 2 &&
    cq.data[0].type === 'mc' && cq.data[1].type === 'tf', JSON.stringify(cq.data));

  const da = await call(`/rest/v1/daily_activity?select=correct_count,quest_completed,spun&user_id=eq.${idA}`, { token: tokenA });
  const day = (da.data || [])[0] || {};
  check('CHEAT BLOCKED: today\'s counter cannot be set by the client',
    day.correct_count === 0 && day.quest_completed === false && day.spun === false, JSON.stringify(day));
}

/* ---------- 4. match rewards are computed by the server ---------- */
{
  const r1 = await rpc('revuzz_record_game', {
    p: {
      mode: 'Classic', code: 'TEST1', types: ['mc', 'tf'],
      pos: 1, score: 900, won: true,
      correct: 8, wrong: 2, attempts: 10,
      /* a cheater would send these; they must be ignored */
      coins: 99999, xp: 99999,
      practice: false
    }
  }, tokenA);
  check('revuzz_record_game returns balances', r1.ok && r1.data && typeof r1.data.coins === 'number',
    `HTTP ${r1.status} ${JSON.stringify(r1.data)}`);
  const b1 = r1.data || {};
  check('CHEAT BLOCKED: match coins come from the rank table, not the client', b1.coins === 30, `coins ${b1.coins}`);
  check('match xp = score / 10', b1.xp === 90, `xp ${b1.xp}`);
  check('match counts total correct', b1.total_correct === 8, `total_correct ${b1.total_correct}`);

  const gp = await call(`/rest/v1/game_players?select=score,rank,won,xp_gained,coins_gained&user_id=eq.${idA}&order=id.desc`, { token: tokenA });
  const row = (gp.data || [])[0] || {};
  check('match row written with the server reward', row.score === 900 && row.rank === 1 && row.won === true &&
    row.xp_gained === 90 && row.coins_gained === 30, JSON.stringify(row));

  const cl = await call(`/rest/v1/coin_ledger?select=amount,reason&user_id=eq.${idA}&reason=eq.game_reward`, { token: tokenA });
  check('coin ledger records the match', (cl.data || []).length === 1 && cl.data[0].amount === 30, JSON.stringify(cl.data));

  // second match: 8 + 8 = 16 correct today, so the daily quest pays 50
  const r2 = await rpc('revuzz_record_game', {
    p: { mode: 'Classic', code: 'TEST2', types: ['mc'], pos: 2, score: 900, correct: 8, wrong: 2, attempts: 10, practice: false }
  }, tokenA);
  const b2 = r2.data || {};
  check('daily quest pays once at 10 correct', b2.coins === 30 + 20 + 50, `coins ${b2.coins}`);
  check('level up uses the 100-per-level curve', b2.level === 2 && b2.xp === 80, `lvl ${b2.level}, xp ${b2.xp}`);
  check('total correct accumulates', b2.total_correct === 16, `total_correct ${b2.total_correct}`);

  const da = await call(`/rest/v1/daily_activity?select=correct_count,quest_completed&user_id=eq.${idA}`, { token: tokenA });
  const day = (da.data || [])[0] || {};
  check('server counted the answers', day.correct_count === 16 && day.quest_completed === true, JSON.stringify(day));

  const r3 = await rpc('revuzz_record_game', {
    p: { mode: 'Classic', code: 'TEST3', types: ['mc'], pos: 3, score: 500, correct: 2, wrong: 8, attempts: 10, practice: false }
  }, tokenA);
  check('quest bonus is not paid twice', (r3.data || {}).coins === 110, `coins ${(r3.data || {}).coins}`);
}

/* ---------- 5. shop: prices from the catalog, balances enforced ---------- */
{
  const before = (await call(`/rest/v1/profiles?select=coins&id=eq.${idA}`, { token: tokenA })).data[0].coins;

  const broke = await rpc('revuzz_buy', { p: { kind: 'theme', id: 'candy' } }, tokenA); // 250 coins
  check('a purchase you cannot afford is refused', !broke.ok && /not_enough_coins/.test(errOf(broke)),
    `HTTP ${broke.status} ${errOf(broke)}`);

  const afterFail = (await call(`/rest/v1/profiles?select=coins&id=eq.${idA}`, { token: tokenA })).data[0].coins;
  check('a refused purchase costs nothing', afterFail === before, `${before} -> ${afterFail}`);

  const ok = await rpc('revuzz_buy', { p: { kind: 'inv', id: 't' } }, tokenA); // 20 coins
  check('lifeline purchase debits the server price', ok.ok && ok.data.coins === before - 20,
    `HTTP ${ok.status} ${JSON.stringify(ok.data)}`);

  const inv = await call(`/rest/v1/profiles?select=inventory&id=eq.${idA}`, { token: tokenA });
  check('lifeline lands in the inventory', (((inv.data || [])[0] || {}).inventory || {}).t === 1,
    JSON.stringify((inv.data || [])[0]));

  const acc = await rpc('revuzz_buy', { p: { kind: 'accessory', id: 'x3' } }, tokenA); // 70 coins
  check('accessory purchase debits the catalog price', acc.ok && acc.data.coins === before - 90,
    `HTTP ${acc.status} ${JSON.stringify(acc.data)}`);

  const owned = await call(`/rest/v1/player_accessories?select=accessory_key,price_paid&user_id=eq.${idA}`, { token: tokenA });
  const row = (owned.data || []).find(r => r.accessory_key === 'x3');
  check('accessory is now owned', !!row && row.price_paid === 70, JSON.stringify(owned.data));

  const twice = await rpc('revuzz_buy', { p: { kind: 'accessory', id: 'x3' } }, tokenA);
  check('buying the same accessory twice is refused', !twice.ok && /already_owned/.test(errOf(twice)),
    errOf(twice));

  const bogus = await rpc('revuzz_buy', { p: { kind: 'accessory', id: 'nope' } }, tokenA);
  check('unknown item is refused', !bogus.ok && /unknown_item/.test(errOf(bogus)), errOf(bogus));

  const cl = await call(`/rest/v1/coin_ledger?select=amount,reason&user_id=eq.${idA}&reason=like.buy:*`, { token: tokenA });
  check('purchases are logged in the ledger', (cl.data || []).length === 2 &&
    cl.data.every(r => r.amount < 0), JSON.stringify(cl.data));
}

/* ---------- 6. daily spin: once per day, reward rolled server-side ---------- */
{
  const before = (await call(`/rest/v1/profiles?select=coins&id=eq.${idA}`, { token: tokenA })).data[0].coins;

  const first = await rpc('revuzz_claim_daily', { p_kind: 'spin' }, tokenA);
  const reward = (first.data || {}).reward;
  check('spin returns a reward', first.ok && [10, 20, 30, 50, 60, 100].includes(reward),
    `HTTP ${first.status} reward ${reward}`);
  check('spin credits the reward', (first.data || {}).coins === before + reward,
    `${before} + ${reward} = ${(first.data || {}).coins}`);

  const second = await rpc('revuzz_claim_daily', { p_kind: 'spin' }, tokenA);
  check('a second spin the same day is refused', !second.ok && /already_claimed/.test(errOf(second)), errOf(second));

  const after = (await call(`/rest/v1/profiles?select=coins&id=eq.${idA}`, { token: tokenA })).data[0].coins;
  check('the refused spin did not pay again', after === before + reward, `coins ${after}`);
}

/* ---------- 7. leaderboard ---------- */
{
  const lb = await call('/rest/v1/leaderboard?select=name,score,games,wins&limit=50', { token: tokenA });
  const me = (lb.data || []).find(r => r.name === studentA.user);
  check('leaderboard exposes the player', !!me, `HTTP ${lb.status}`);
  check('leaderboard counts all three matches', me && me.games === 3 && me.wins === 1 && me.score === 900,
    me ? `${me.games} games, ${me.wins} wins, best ${me.score}` : '');
  const clean = JSON.stringify(lb.data || []);
  check('leaderboard leaks no student numbers or emails', !/student_number|@students\.revuzz\.app|"email"/.test(clean));
}

/* ---------- 8. log out, log back in ---------- */
{
  const again = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: emailOf(studentA.sn), password: PW }
  });
  check('password login works', again.ok && !!again.data.access_token, `HTTP ${again.status}`);
  const t2 = again.data?.access_token;
  if (t2) {
    const p = await call(`/rest/v1/profiles?select=coins,level,xp&id=eq.${idA}`, { token: t2 });
    const row = (p.data || [])[0] || {};
    check('progress survives a fresh login', row.level === 2 && row.coins > 0, JSON.stringify(row));
  }
  const bad = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: emailOf(studentA.sn), password: 'wrong-' + PW }
  });
  check('wrong password is rejected', !bad.ok && bad.status >= 400, `HTTP ${bad.status}`);
}

/* ---------- 9. row-level security ---------- */
{
  const anon = await call(`/rest/v1/profiles?select=student_number,email,coins&limit=5`);
  check('anon key cannot read profiles', !anon.ok || !Array.isArray(anon.data) || anon.data.length === 0,
    `HTTP ${anon.status}, ${Array.isArray(anon.data) ? anon.data.length : '?'} rows`);

  const upB = await signUp(studentB);
  if (upB.ok && upB.data?.access_token) {
    const tb = upB.data.access_token;
    const peek = await call(`/rest/v1/profiles?select=username&id=eq.${idA}`, { token: tb });
    check('another student cannot read your profile', (peek.data || []).length === 0, `${(peek.data || []).length} rows`);

    const steal = await call(`/rest/v1/profiles?id=eq.${idA}`, { method: 'PATCH', token: tb, body: { coins: 999999 } });
    const still = await call(`/rest/v1/profiles?select=coins&id=eq.${idA}`, { token: tokenA });
    check('another student cannot edit your coins',
      !(still.data || [])[0] || still.data[0].coins !== 999999,
      `update HTTP ${steal.status}, coins now ${JSON.stringify(still.data)}`);

    // The important one: writing your OWN money straight to the table must fail
    // too, otherwise the whole server-side economy is one fetch() away.
    const selfBefore = (await call(`/rest/v1/profiles?select=coins&id=eq.${upB.data.user.id}`, { token: tb })).data[0].coins;
    const selfPatch = await call(`/rest/v1/profiles?id=eq.${upB.data.user.id}`, {
      method: 'PATCH', token: tb,
      body: { coins: 999999, xp: 999999, level: 99, total_correct: 999 }
    });
    const selfAfter = (await call(`/rest/v1/profiles?select=coins,xp,level,total_correct&id=eq.${upB.data.user.id}`, { token: tb })).data[0];
    check('CHEAT BLOCKED: a student cannot PATCH their own coins/xp',
      !selfPatch.ok && selfAfter.coins === selfBefore && selfAfter.level === 1 && selfAfter.total_correct === 0,
      `HTTP ${selfPatch.status}, ${JSON.stringify(selfAfter)}`);

    const selfDay = await call(`/rest/v1/daily_activity?user_id=eq.${upB.data.user.id}`, {
      method: 'PATCH', token: tb,
      body: { correct_count: 999, quest_completed: true, spun: false }
    });
    const dayRow = await call(`/rest/v1/daily_activity?select=correct_count,quest_completed&user_id=eq.${upB.data.user.id}`, { token: tb });
    const day = (dayRow.data || [])[0] || {};
    check('CHEAT BLOCKED: the daily counter cannot be PATCHed',
      !selfDay.ok && day.correct_count !== 999 && day.quest_completed !== true,
      `HTTP ${selfDay.status}, ${JSON.stringify(day)}`);

    const promo = await call(`/rest/v1/profiles?id=eq.${upB.data.user.id}`, { method: 'PATCH', token: tb, body: { role: 'admin' } });
    const role = await call(`/rest/v1/profiles?select=role&id=eq.${upB.data.user.id}`, { token: tb });
    check('a student cannot make themself admin',
      (role.data || [])[0]?.role === 'student', `update HTTP ${promo.status}, role ${(role.data || [])[0]?.role}`);

    const theirSpin = await rpc('revuzz_claim_daily', { p_kind: 'spin' }, tb);
    check('a second player gets their own spin', theirSpin.ok, `HTTP ${theirSpin.status} ${errOf(theirSpin)}`);
  } else {
    check('second student sign-up (RLS peer test)', false, `HTTP ${upB.status} ${JSON.stringify(upB.data)}`);
  }
}

/* ---------- report ---------- */
console.log('');
for (const line of results) console.log('  ' + line);
console.log('');
console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
console.log(`\ntest accounts: ${studentA.sn} / ${studentA.user}, ${studentB.sn} / ${studentB.user}`);
console.log('delete them in Authentication -> Users when you are done.');
process.exit(failed ? 1 : 0);
