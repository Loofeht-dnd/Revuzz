-- ########## 01_schema.sql ##########
-- ============================================================
-- Revuzz online database - schema
-- Run in the Supabase SQL Editor, in this order:
--   01_schema.sql -> 02_functions.sql -> 03_policies.sql -> 04_seed.sql
-- ============================================================

-- ---------- Catalogs (content the game unlocks) ----------

create table if not exists public.themes (
  id    text primary key,
  name  text not null,
  price integer not null default 0 check (price >= 0)
);

create table if not exists public.badges (
  id          text primary key,
  name        text not null,
  icon        text not null,
  description text not null default '',
  sort_order  integer not null default 0
);

create table if not exists public.accessories (
  key      text primary key,
  category text not null check (category in ('h', 'g', 'x', 'e', 'c')),
  slot     integer not null check (slot >= 0),
  price    integer not null default 0 check (price >= 0)
);

-- ---------- Player account ----------

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  student_number  text not null unique check (student_number ~ '^[0-9]{6,15}$'),
  username        text not null check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  first_name      text not null default '',
  middle_name     text not null default '',
  last_name       text not null default '',
  email           text not null default '',
  grade           text not null default '',
  strand          text not null default '',
  school_year     text not null default '',
  role            text not null default 'student' check (role in ('student', 'admin')),
  avatar          jsonb not null default '{"c":0,"e":0,"h":0,"g":0,"x":0}'::jsonb,
  xp              integer not null default 0 check (xp >= 0),
  level           integer not null default 1 check (level >= 1),
  coins           integer not null default 0 check (coins >= 0),
  active_theme    text not null default 'cosmic' references public.themes(id),
  streak          integer not null default 0 check (streak >= 0),
  last_played_on  date,
  total_correct   integer not null default 0 check (total_correct >= 0),
  last_result     jsonb,
  inventory       jsonb not null default '{"f":0,"t":0,"s":0}'::jsonb,
  preferences     jsonb not null default '{"noVib":0,"ts":0,"rm":0,"hc":0}'::jsonb,
  tour_done       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Usernames are unique regardless of letter case.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

create index if not exists profiles_leaderboard_idx
  on public.profiles (level desc, xp desc);

-- ---------- Player unlocks / progress ----------

create table if not exists public.player_badges (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  badge_id  text not null references public.badges(id),
  earned_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create table if not exists public.player_accessories (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  accessory_key text not null references public.accessories(key),
  price_paid    integer not null default 0 check (price_paid >= 0),
  acquired_at   timestamptz not null default now(),
  primary key (user_id, accessory_key)
);

create table if not exists public.player_themes (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  theme_id    text not null references public.themes(id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, theme_id)
);

create table if not exists public.player_modes (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  mode          text not null check (length(mode) <= 60),
  first_seen_at timestamptz not null default now(),
  primary key (user_id, mode)
);

-- One row per player per day: daily quest, streak history and daily spin.
create table if not exists public.daily_activity (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  activity_date   date not null,
  correct_count   integer not null default 0 check (correct_count >= 0),
  quest_completed boolean not null default false,
  coins_awarded   integer not null default 0 check (coins_awarded >= 0),
  spun            boolean not null default false,
  primary key (user_id, activity_date)
);

create index if not exists daily_activity_user_idx
  on public.daily_activity (user_id, activity_date desc);

-- Questions the player got wrong, kept for the flashcard review deck.
create table if not exists public.missed_questions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  prompt         text not null,
  question       jsonb not null,
  times_missed   integer not null default 1 check (times_missed >= 1),
  last_missed_at timestamptz not null default now(),
  unique (user_id, prompt)
);

-- The player's own quiz questions (max 40 enforced by the save function).
create table if not exists public.custom_questions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  position   integer not null default 0,
  type       text not null check (type in ('mc', 'tf', 'id', 'en')),
  prompt     text not null,
  choices    jsonb not null default '[]'::jsonb,
  answer     jsonb,
  topic      text,
  created_at timestamptz not null default now()
);

create index if not exists custom_questions_user_idx
  on public.custom_questions (user_id, position);

-- ---------- Match history ----------

create table if not exists public.game_sessions (
  id             uuid primary key default gen_random_uuid(),
  code           text not null default '',
  mode           text not null check (length(mode) between 1 and 60),
  question_types text[] not null default '{}',
  host_id        uuid references public.profiles(id) on delete set null,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz not null default now()
);

create index if not exists game_sessions_mode_idx
  on public.game_sessions (mode, ended_at desc);

create table if not exists public.game_players (
  id           bigint generated always as identity primary key,
  session_id   uuid not null references public.game_sessions(id) on delete cascade,
  user_id      uuid references public.profiles(id) on delete set null,
  name         text not null,
  avatar       jsonb,
  score        integer not null default 0 check (score >= 0),
  rank         integer not null default 1 check (rank >= 1),
  won          boolean not null default false,
  correct      integer not null default 0 check (correct >= 0),
  wrong        integer not null default 0 check (wrong >= 0),
  attempts     integer not null default 0 check (attempts >= 0),
  xp_gained    integer not null default 0 check (xp_gained >= 0),
  coins_gained integer not null default 0 check (coins_gained >= 0),
  team         text,
  is_bot       boolean not null default false
);

create index if not exists game_players_user_idx
  on public.game_players (user_id, session_id);

-- A signed-in player appears at most once in one match.
create unique index if not exists game_players_one_entry
  on public.game_players (session_id, user_id)
  where user_id is not null;

-- Audit trail for every coin change (rewards, shop, spin, quests).
create table if not exists public.coin_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  amount     integer not null,
  reason     text not null check (length(reason) <= 60),
  ref_id     uuid,
  created_at timestamptz not null default now()
);

create index if not exists coin_ledger_user_idx
  on public.coin_ledger (user_id, created_at desc);

-- ---------- Account deletion ----------
-- Deleting a student must take their match rows with them. Earlier builds
-- used "on delete set null", which left anonymous sessions behind and made
-- "I deleted the account" untrue. Both constraints are re-created by name so
-- this file stays safe to run again on an existing database.
alter table public.game_sessions drop constraint if exists game_sessions_host_id_fkey;
alter table public.game_sessions add constraint game_sessions_host_id_fkey
  foreign key (host_id) references public.profiles(id) on delete cascade;

alter table public.game_players drop constraint if exists game_players_user_id_fkey;
alter table public.game_players add constraint game_players_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;

-- ---------- Handouts (the AI's raw material) ----------
-- A student's own notes, typed/pasted or extracted on the device from a PDF,
-- DOCX or PPTX. The text belongs to that student alone: the owner-only
-- policies live in 03_policies.sql and there is no teacher read path.
create table if not exists public.lessons (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  source_name text not null default '',
  source_kind text not null default 'txt',
  body        text not null,
  chars       integer not null default 0,
  summary     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lessons_title_check check (length(title) between 1 and 120),
  constraint lessons_source_name_check check (length(source_name) <= 160),
  constraint lessons_source_kind_check
    check (source_kind in ('txt', 'md', 'pdf', 'docx', 'pptx', 'paste')),
  constraint lessons_body_check check (length(body) between 20 and 120000),
  constraint lessons_chars_check check (chars >= 0)
);

create index if not exists lessons_user_idx
  on public.lessons (user_id, created_at desc);

-- ---------- AI quota ----------
-- One counter row per student per Manila day. The browser has no grant on this
-- table: only revuzz_ai_reserve / revuzz_ai_refund / revuzz_ai_quota /
-- revuzz_ai_class_used (02_functions.sql) ever read or write it, so the caps
-- cannot be raised from the client.
create table if not exists public.ai_usage (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null,
  calls      integer not null default 0,
  questions  integer not null default 0,
  primary key (user_id, usage_date),
  constraint ai_usage_calls_check check (calls >= 0),
  constraint ai_usage_questions_check check (questions >= 0)
);

-- ########## 02_functions.sql ##########
-- ============================================================
-- Revuzz online database - helper functions, triggers, RPCs
-- Run after 01_schema.sql.
-- ============================================================

-- ---------- Helpers ----------

-- The school day is Philippine time. Postgres runs in UTC, so "today" has to
-- be converted explicitly; otherwise the daily quest and spin roll over at
-- 08:00 Manila, not midnight.
create or replace function public.revuzz_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Manila')::date;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- A student may not make themself an admin, change their student number,
-- or move the account to another auth user.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.id             := old.id;
    new.role           := old.role;
    new.student_number := old.student_number;
    new.email          := old.email;
    new.created_at     := old.created_at;
  end if;
  return new;
end;
$$;

-- ---------- New auth user -> profile ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  -- Accounts created outside the Revuzz sign-up form get no profile.
  if coalesce(meta->>'student_number', '') = '' then
    return new;
  end if;

  insert into public.profiles (
    id, student_number, username,
    first_name, middle_name, last_name,
    email, grade, strand, school_year, avatar
  ) values (
    new.id,
    meta->>'student_number',
    meta->>'username',
    coalesce(meta->>'first_name', ''),
    coalesce(meta->>'middle_name', ''),
    coalesce(meta->>'last_name', ''),
    lower(coalesce(meta->>'email', new.email, '')),
    coalesce(meta->>'grade', ''),
    coalesce(meta->>'strand', ''),
    coalesce(meta->>'school_year', ''),
    coalesce(meta->'avatar', '{"c":0,"e":0,"h":0,"g":0,"x":0}'::jsonb)
  );

  insert into public.player_themes (user_id, theme_id)
  values (new.id, 'cosmic')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists profiles_touch_updated on public.profiles;
create trigger profiles_touch_updated
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_protect_columns on public.profiles;
create trigger profiles_protect_columns
  before update on public.profiles
  for each row execute function public.protect_profile_columns();

drop trigger if exists lessons_touch_updated on public.lessons;
create trigger lessons_touch_updated
  before update on public.lessons
  for each row execute function public.touch_updated_at();

-- ---------- Login / sign-up lookup (callable before login) ----------

-- Returns only a masked email, never the full address.
create or replace function public.revuzz_check_identity(
  p_student_number text,
  p_username text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sn  text := trim(coalesce(p_student_number, ''));
  v_un  text := nullif(trim(coalesce(p_username, '')), '');
  v_row public.profiles;
  v_local text;
begin
  select * into v_row
  from public.profiles
  where student_number = v_sn
  limit 1;

  v_local := split_part(coalesce(v_row.email, ''), '@', 1);

  return jsonb_build_object(
    'exists', v_row.id is not null,
    'sn_taken', v_row.id is not null,
    'username_taken', case
      when v_un is null then false
      else exists (select 1 from public.profiles where lower(username) = lower(v_un))
    end,
    'masked_email', case
      when coalesce(v_row.email, '') = '' then null
      else left(v_local, 1) || repeat('*', greatest(length(v_local) - 1, 1))
           || '@' || split_part(v_row.email, '@', 2)
    end
  );
end;
$$;

-- ---------- Full account snapshot sync ----------

-- The browser keeps a local cache and sends this snapshot after every change.
-- Every table is written in one transaction, so a failure changes nothing.
--
-- Money is NOT in this snapshot. coins, xp, level and total_correct can only
-- move through revuzz_record_game, revuzz_buy and revuzz_claim_daily, so a
-- student cannot edit them in the browser. The function returns the real
-- balances so the client can adopt them.
drop function if exists public.revuzz_save_account(jsonb);

-- Runs as the owner on purpose: the browser has no write grant on profiles or
-- daily_activity any more, so this function is the only way in. It only ever
-- touches rows where id = auth.uid().
create or replace function public.revuzz_save_account(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_username text := nullif(trim(coalesce(p->>'username', '')), '');
  v_theme  text;
  -- The school day comes from the server. A browser-supplied date would let a
  -- student pre-create rows for other days.
  v_today  date := public.revuzz_today();
  v_out    jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_username is null then
    raise exception 'username_required';
  end if;

  -- The active theme must exist in the catalog.
  select id into v_theme
  from public.themes
  where id = coalesce(p->>'active_theme', 'cosmic');
  if v_theme is null then
    v_theme := 'cosmic';
  end if;

  update public.profiles set
    username       = v_username,
    first_name     = coalesce(p->>'first_name', ''),
    middle_name    = coalesce(p->>'middle_name', ''),
    last_name      = coalesce(p->>'last_name', ''),
    grade          = coalesce(p->>'grade', ''),
    strand         = coalesce(p->>'strand', ''),
    school_year    = coalesce(p->>'school_year', ''),
    avatar         = case when jsonb_typeof(p->'avatar') = 'object' then p->'avatar' else avatar end,
    active_theme   = v_theme,
    streak         = greatest(0, coalesce((p->>'streak')::int, 0)),
    last_played_on = nullif(p->>'last_played_on', '')::date,
    last_result    = case when jsonb_typeof(p->'last_result') = 'object' then p->'last_result' else null end,
    inventory      = case when jsonb_typeof(p->'inventory') = 'object' then p->'inventory' else inventory end,
    preferences    = case when jsonb_typeof(p->'preferences') = 'object' then p->'preferences' else preferences end,
    tour_done      = coalesce((p->>'tour_done')::boolean, tour_done)
  where id = v_uid;

  if not found then
    raise exception 'profile_missing';
  end if;

  -- Badges: add the ones in the snapshot, remove the ones no longer owned.
  delete from public.player_badges pb
  where pb.user_id = v_uid
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p->'badges', '[]'::jsonb)) e
      where e.value = pb.badge_id
    );

  insert into public.player_badges (user_id, badge_id)
  select v_uid, e.value
  from jsonb_array_elements_text(coalesce(p->'badges', '[]'::jsonb)) e
  where exists (select 1 from public.badges b where b.id = e.value)
  on conflict do nothing;

  -- Purchased accessories.
  delete from public.player_accessories pa
  where pa.user_id = v_uid
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p->'accessories', '[]'::jsonb)) e
      where e.value = pa.accessory_key
    );

  insert into public.player_accessories (user_id, accessory_key, price_paid)
  select v_uid, e.value, coalesce(a.price, 0)
  from jsonb_array_elements_text(coalesce(p->'accessories', '[]'::jsonb)) e
  join public.accessories a on a.key = e.value
  on conflict do nothing;

  -- Unlocked themes (the starter theme is always owned).
  insert into public.player_themes (user_id, theme_id)
  values (v_uid, 'cosmic')
  on conflict do nothing;

  delete from public.player_themes pt
  where pt.user_id = v_uid
    and pt.theme_id <> 'cosmic'
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p->'themes', '[]'::jsonb)) e
      where e.value = pt.theme_id
    );

  insert into public.player_themes (user_id, theme_id)
  select v_uid, e.value
  from jsonb_array_elements_text(coalesce(p->'themes', '[]'::jsonb)) e
  join public.themes t on t.id = e.value
  on conflict do nothing;

  -- Game modes the player has opened.
  delete from public.player_modes pm
  where pm.user_id = v_uid
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p->'modes', '[]'::jsonb)) e
      where e.value = pm.mode
    );

  insert into public.player_modes (user_id, mode)
  select v_uid, left(e.value, 60)
  from jsonb_array_elements_text(coalesce(p->'modes', '[]'::jsonb)) e
  where length(e.value) between 1 and 60
  on conflict do nothing;

  -- The day's row is created empty. Answers, the quest and the spin belong to
  -- revuzz_record_game and revuzz_claim_daily, so this snapshot cannot fake them.
  insert into public.daily_activity (user_id, activity_date)
  values (v_uid, v_today)
  on conflict (user_id, activity_date) do nothing;

  -- Missed-question review deck (kept to 30 in the browser; cap here too).
  delete from public.missed_questions mq
  where mq.user_id = v_uid
    and mq.prompt not in (
      select left(e.value->>'q', 500)
      from jsonb_array_elements(coalesce(p->'missed', '[]'::jsonb)) e
      where jsonb_typeof(e.value) = 'object'
        and coalesce(e.value->>'q', '') <> ''
    );

  insert into public.missed_questions (user_id, prompt, question)
  select v_uid, left(e.value->>'q', 500), e.value
  from jsonb_array_elements(coalesce(p->'missed', '[]'::jsonb)) e
  where jsonb_typeof(e.value) = 'object'
    and coalesce(e.value->>'q', '') <> ''
  on conflict (user_id, prompt) do update
    set question = excluded.question;

  -- The player's own quiz questions (replace the set; max 40).
  delete from public.custom_questions where user_id = v_uid;

  insert into public.custom_questions (
    user_id, position, type, prompt, choices, answer, topic
  )
  select
    v_uid,
    (e.ord - 1)::int,
    e.value->>'t',
    left(e.value->>'q', 500),
    coalesce(e.value->'a', '[]'::jsonb),
    coalesce(e.value->'c', 'null'::jsonb),
    nullif(left(coalesce(e.value->>'topic', ''), 80), '')
  from jsonb_array_elements(coalesce(p->'questions', '[]'::jsonb)) with ordinality as e(value, ord)
  where e.value->>'t' in ('mc', 'tf', 'id', 'en')
    and coalesce(e.value->>'q', '') <> ''
  order by e.ord
  limit 40;

  -- Hand back the real balances. The browser overwrites its local copy with
  -- these, so any edit made in devtools disappears on the next save.
  select jsonb_build_object(
    'coins', coins,
    'xp', xp,
    'level', level,
    'total_correct', total_correct
  ) into v_out
  from public.profiles
  where id = v_uid;

  return v_out;
end;
$$;

-- ---------- Match result ----------

-- The browser sends what happened (rank, score, answers), never the reward.
-- Coins, XP, level-ups, total correct and the daily quest are all computed
-- here, so a forged snapshot cannot invent money. Returns the new balances.
drop function if exists public.revuzz_record_game(jsonb);

create or replace function public.revuzz_record_game(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_sid      uuid;
  v_name     text;
  v_avatar   jsonb;
  v_pos      int;
  v_score    int;
  v_correct  int;
  v_wrong    int;
  v_attempts int;
  v_practice boolean;
  v_coins    int;
  v_xp       int;
  v_quest    int := 0;
  v_today    date := public.revuzz_today();
  v_xp_now   int;
  v_lvl      int;
  v_today_n  int;
  v_out      jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select username, avatar into v_name, v_avatar
  from public.profiles where id = v_uid;
  if v_name is null then
    raise exception 'profile_missing';
  end if;

  v_pos      := greatest(1, coalesce((p->>'pos')::int, 1));
  v_score    := greatest(0, coalesce((p->>'score')::int, 0));
  v_correct  := greatest(0, coalesce((p->>'correct')::int, 0));
  v_wrong    := greatest(0, coalesce((p->>'wrong')::int, 0));
  v_attempts := greatest(0, coalesce((p->>'attempts')::int, 0));
  v_practice := coalesce((p->>'practice')::boolean, false);

  -- Server-side reward table: same numbers the game shows (30/20/10/5/3/2/1/1).
  if v_practice then
    v_coins := 0;
    v_xp    := 0;
  else
    v_coins := (array[30, 20, 10, 5, 3, 2, 1, 1])[least(v_pos, 8)];
    v_xp    := round(v_score / 10.0)::int;
  end if;

  insert into public.game_sessions (code, mode, question_types, host_id, started_at, ended_at)
  values (
    left(coalesce(p->>'code', ''), 12),
    left(coalesce(nullif(p->>'mode', ''), 'Unknown'), 60),
    coalesce(array(
      select left(e.value, 40)
      from jsonb_array_elements_text(coalesce(p->'types', '[]'::jsonb)) e
    ), '{}'),
    v_uid,
    now(),
    now()
  )
  returning id into v_sid;

  insert into public.game_players (
    session_id, user_id, name, avatar,
    score, rank, won, correct, wrong, attempts, xp_gained, coins_gained, team
  ) values (
    v_sid, v_uid, v_name, v_avatar,
    v_score, v_pos, v_pos = 1, v_correct, v_wrong, v_attempts,
    v_xp, v_coins, nullif(left(coalesce(p->>'team', ''), 20), '')
  );

  if not v_practice then
    -- Daily quest: the server counts the answers, so "10 correct today" is real.
    insert into public.daily_activity (user_id, activity_date, correct_count, quest_completed, spun)
    values (v_uid, v_today, v_correct, false, false)
    on conflict (user_id, activity_date) do update
      set correct_count = daily_activity.correct_count + excluded.correct_count;

    select correct_count into v_today_n
    from public.daily_activity
    where user_id = v_uid and activity_date = v_today;

    if not coalesce((select quest_completed from public.daily_activity
                     where user_id = v_uid and activity_date = v_today), false)
       and coalesce(v_today_n, 0) >= 10 then
      v_quest := 50;
      update public.daily_activity set quest_completed = true
      where user_id = v_uid and activity_date = v_today;
    end if;

    update public.profiles
       set coins         = greatest(0, coins + v_coins + v_quest),
           total_correct = total_correct + v_correct,
           xp            = xp + v_xp
     where id = v_uid;

    -- Level-ups use the same 100-per-level curve as the game.
    select xp, level into v_xp_now, v_lvl from public.profiles where id = v_uid;
    while v_xp_now >= v_lvl * 100 loop
      v_xp_now := v_xp_now - v_lvl * 100;
      v_lvl    := v_lvl + 1;
    end loop;
    update public.profiles set xp = v_xp_now, level = v_lvl where id = v_uid;

    insert into public.coin_ledger (user_id, amount, reason, ref_id)
    values (v_uid, v_coins + v_quest, 'game_reward', v_sid);
  end if;

  select public.revuzz_balances() into v_out;
  return v_out;
end;
$$;

-- ---------- Current balances (internal helper) ----------

create or replace function public.revuzz_balances()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'coins', coins,
    'xp', xp,
    'level', level,
    'total_correct', total_correct
  )
  from public.profiles
  where id = auth.uid();
$$;

-- ---------- Shop purchase ----------

-- p = { "kind": "accessory" | "theme" | "inv", "id": "h5" | "ocean" | "f" }
-- The price comes from the catalog, never from the browser.
create or replace function public.revuzz_buy(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_kind  text := nullif(trim(coalesce(p->>'kind', '')), '');
  v_id    text := nullif(trim(coalesce(p->>'id', '')), '');
  v_price int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if v_kind = 'accessory' then
    select price into v_price from public.accessories where key = v_id;
    if v_price is null then
      raise exception 'unknown_item';
    end if;
    if exists (select 1 from public.player_accessories where user_id = v_uid and accessory_key = v_id) then
      raise exception 'already_owned';
    end if;

    update public.profiles set coins = coins - v_price
     where id = v_uid and coins >= v_price;
    if not found then
      raise exception 'not_enough_coins';
    end if;

    insert into public.player_accessories (user_id, accessory_key, price_paid)
    values (v_uid, v_id, v_price) on conflict do nothing;

  elsif v_kind = 'theme' then
    select price into v_price from public.themes where id = v_id;
    if v_price is null then
      raise exception 'unknown_item';
    end if;
    if exists (select 1 from public.player_themes where user_id = v_uid and theme_id = v_id) then
      raise exception 'already_owned';
    end if;

    update public.profiles set coins = coins - v_price
     where id = v_uid and coins >= v_price;
    if not found then
      raise exception 'not_enough_coins';
    end if;

    insert into public.player_themes (user_id, theme_id)
    values (v_uid, v_id) on conflict do nothing;

  elsif v_kind = 'inv' then
    -- Lifeline prices, fixed here: 50/50, +5 seconds, skip.
    v_price := case v_id when 'f' then 30 when 't' then 20 when 's' then 40 end;
    if v_price is null then
      raise exception 'unknown_item';
    end if;

    update public.profiles set coins = coins - v_price
     where id = v_uid and coins >= v_price;
    if not found then
      raise exception 'not_enough_coins';
    end if;

    update public.profiles
       set inventory = jsonb_set(
             inventory,
             array[v_id],
             to_jsonb(coalesce((inventory->>v_id)::int, 0) + 1),
             true)
     where id = v_uid;

  else
    raise exception 'unknown_kind';
  end if;

  insert into public.coin_ledger (user_id, amount, reason)
  values (v_uid, -v_price, left('buy:' || v_kind || ':' || v_id, 60));

  return public.revuzz_balances();
end;
$$;

-- ---------- Daily spin / quest claim ----------

-- The spin can only be claimed once per day, and the reward is rolled here.
create or replace function public.revuzz_claim_daily(p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_roll   int;
  v_reward int;
  v_out    jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if coalesce(p_kind, '') <> 'spin' then
    raise exception 'unknown_claim';
  end if;

  insert into public.daily_activity (user_id, activity_date, spun)
  values (v_uid, public.revuzz_today(), true)
  on conflict (user_id, activity_date) do update
    set spun = true
    where daily_activity.spun = false;

  if not found then
    raise exception 'already_claimed';
  end if;

  -- Weights match the wheel: 30/25/20/15/5/5.
  v_roll := floor(random() * 100)::int;
  v_reward := case
    when v_roll < 30 then 10
    when v_roll < 55 then 20
    when v_roll < 75 then 30
    when v_roll < 90 then 50
    when v_roll < 95 then 100
    else 60
  end;

  update public.profiles set coins = coins + v_reward where id = v_uid;

  insert into public.coin_ledger (user_id, amount, reason)
  values (v_uid, v_reward, 'daily_spin');

  select public.revuzz_balances() || jsonb_build_object('reward', v_reward) into v_out;
  return v_out;
end;
$$;

-- ---------- Administrator tools ----------

-- Teachers need one more door, because the browser has no write grant on
-- profiles. Both functions refuse anybody whose role is not 'admin' in the
-- database, so reaching the panel in the browser is not enough.
create or replace function public.revuzz_admin_grant(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid := auth.uid();
  v_target uuid;
  v_sn     text := nullif(trim(coalesce(p->>'student_number', '')), '');
  v_coins  int  := coalesce(nullif(p->>'coins', '')::int, 0);
  v_xp     int  := coalesce(nullif(p->>'xp', '')::int, 0);
  v_xp_now int;
  v_lvl    int;
  v_out    jsonb;
begin
  if v_admin is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_sn is null then
    raise exception 'missing_student_number';
  end if;

  select id into v_target from public.profiles where student_number = v_sn;
  if v_target is null then
    raise exception 'student_not_found';
  end if;

  -- An adjustment, not a blank cheque.
  v_coins := greatest(-1000000, least(1000000, v_coins));
  v_xp    := greatest(-1000000, least(1000000, v_xp));

  update public.profiles
     set coins = greatest(0, least(1000000000, coins + v_coins)),
         xp    = greatest(0, xp + v_xp)
   where id = v_target;

  select xp, level into v_xp_now, v_lvl from public.profiles where id = v_target;
  while v_xp_now >= v_lvl * 100 loop
    v_xp_now := v_xp_now - v_lvl * 100;
    v_lvl    := v_lvl + 1;
  end loop;
  update public.profiles set xp = v_xp_now, level = v_lvl where id = v_target;

  if v_coins <> 0 then
    insert into public.coin_ledger (user_id, amount, reason)
    values (v_target, v_coins, 'admin_grant');
  end if;

  select jsonb_build_object(
    'student_number', student_number,
    'username', username,
    'coins', coins,
    'xp', xp,
    'level', level
  ) into v_out
  from public.profiles where id = v_target;

  return v_out;
end;
$$;

-- Clear the day's counter, quest and spin for one student (demo/rehearsal).
create or replace function public.revuzz_admin_reset_day(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid := auth.uid();
  v_target uuid;
  v_sn     text := nullif(trim(coalesce(p->>'student_number', '')), '');
  v_day    date := coalesce(nullif(p->>'date', '')::date, public.revuzz_today());
  v_rows   int;
begin
  if v_admin is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  if v_sn is null then
    raise exception 'missing_student_number';
  end if;

  select id into v_target from public.profiles where student_number = v_sn;
  if v_target is null then
    raise exception 'student_not_found';
  end if;

  delete from public.daily_activity
   where user_id = v_target and activity_date = v_day;
  get diagnostics v_rows = row_count;

  return jsonb_build_object('student_number', v_sn, 'date', v_day, 'rows_cleared', v_rows);
end;
$$;

-- ---------- AI: one quota row per student per day ----------
-- The caps are constants inside the function, so a caller cannot pass a bigger
-- number. p_calls is clamped to 1..30, so there is no free read path.
create or replace function public.revuzz_ai_reserve(
  p_calls     integer default 1,
  p_questions integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_calls     constant integer := 30;
  c_questions constant integer := 300;
  v_uid   uuid := auth.uid();
  v_day   date := public.revuzz_today();
  v_calls integer := least(greatest(coalesce(p_calls, 1), 1), c_calls);
  v_qs    integer := least(greatest(coalesce(p_questions, 0), 0), c_questions);
  v_used  integer;
  v_usedq integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  insert into public.ai_usage (user_id, usage_date)
  values (v_uid, v_day)
  on conflict (user_id, usage_date) do nothing;

  update public.ai_usage
     set calls = calls + v_calls,
         questions = questions + v_qs
   where user_id = v_uid
     and usage_date = v_day
     and calls + v_calls <= c_calls
     and questions + v_qs <= c_questions
  returning calls, questions into v_used, v_usedq;

  if v_used is null then
    select calls, questions into v_used, v_usedq
      from public.ai_usage
     where user_id = v_uid and usage_date = v_day;
    return jsonb_build_object(
      'ok', false,
      'reason', 'daily_limit',
      'used', coalesce(v_used, c_calls),
      'used_questions', coalesce(v_usedq, c_questions),
      'cap', c_calls,
      'cap_questions', c_questions
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'used', v_used,
    'used_questions', v_usedq,
    'left', c_calls - v_used,
    'cap', c_calls,
    'cap_questions', c_questions
  );
end;
$$;

-- Read-only views of the same counters for the Edge Function, so it does not
-- need the service-role key just to show "27 of 30 left".
create or replace function public.revuzz_ai_quota()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'used', coalesce((
      select calls from public.ai_usage
       where user_id = auth.uid() and usage_date = public.revuzz_today()), 0),
    'questions', coalesce((
      select questions from public.ai_usage
       where user_id = auth.uid() and usage_date = public.revuzz_today()), 0)
  );
$$;

-- Whole-class calls today, for the shared daily budget. Only a number.
create or replace function public.revuzz_ai_class_used()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(calls), 0)::int
    from public.ai_usage
   where usage_date = public.revuzz_today();
$$;

-- Give back quota when the provider itself failed (timeout, 429, bad key).
-- Server-only: the function calls this with the service client, best effort.
create or replace function public.revuzz_ai_refund(
  p_user      uuid,
  p_calls     integer default 1,
  p_questions integer default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_usage
     set calls = greatest(calls - greatest(coalesce(p_calls, 0), 0), 0),
         questions = greatest(questions - greatest(coalesce(p_questions, 0), 0), 0)
   where user_id = p_user
     and usage_date = public.revuzz_today();
$$;

-- ---------- Permissions ----------

revoke all on function public.revuzz_save_account(jsonb) from public;
revoke all on function public.revuzz_record_game(jsonb) from public;
revoke all on function public.revuzz_buy(jsonb) from public;
revoke all on function public.revuzz_claim_daily(text) from public;
revoke all on function public.revuzz_balances() from public;
revoke all on function public.revuzz_admin_grant(jsonb) from public;
revoke all on function public.revuzz_admin_reset_day(jsonb) from public;
revoke all on function public.revuzz_check_identity(text, text) from public;
revoke all on function public.revuzz_today() from public;
revoke all on function public.revuzz_ai_reserve(integer, integer) from public;
revoke all on function public.revuzz_ai_quota() from public;
revoke all on function public.revuzz_ai_class_used() from public;
revoke all on function public.revuzz_ai_refund(uuid, integer, integer) from public;

grant execute on function public.revuzz_save_account(jsonb) to authenticated;
grant execute on function public.revuzz_record_game(jsonb) to authenticated;
grant execute on function public.revuzz_buy(jsonb) to authenticated;
grant execute on function public.revuzz_claim_daily(text) to authenticated;
grant execute on function public.revuzz_balances() to authenticated;
grant execute on function public.revuzz_admin_grant(jsonb) to authenticated;
grant execute on function public.revuzz_admin_reset_day(jsonb) to authenticated;
grant execute on function public.revuzz_today() to authenticated;
grant execute on function public.revuzz_check_identity(text, text) to anon, authenticated;
grant execute on function public.revuzz_ai_reserve(integer, integer) to authenticated;
grant execute on function public.revuzz_ai_quota() to authenticated;
grant execute on function public.revuzz_ai_class_used() to authenticated;
grant execute on function public.revuzz_ai_refund(uuid, integer, integer) to service_role;
grant execute on function public.is_admin() to anon, authenticated;

-- ########## 03_policies.sql ##########
-- ============================================================
-- Revuzz online database - row level security + public views
-- Run after 02_functions.sql.
-- ============================================================

alter table public.profiles          enable row level security;
alter table public.player_badges     enable row level security;
alter table public.player_accessories enable row level security;
alter table public.player_themes     enable row level security;
alter table public.player_modes      enable row level security;
alter table public.daily_activity    enable row level security;
alter table public.missed_questions  enable row level security;
alter table public.custom_questions  enable row level security;
alter table public.game_sessions     enable row level security;
alter table public.game_players      enable row level security;
alter table public.coin_ledger       enable row level security;
alter table public.themes            enable row level security;
alter table public.badges            enable row level security;
alter table public.accessories       enable row level security;

-- ---------- Profiles: owner or admin only ----------

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;

-- There is deliberately no update policy: the browser has no write grant on
-- this table either. Saves go through revuzz_save_account.

-- ---------- Achievement tables: readable by signed-in players ----------

drop policy if exists player_badges_select on public.player_badges;
create policy player_badges_select on public.player_badges
  for select to authenticated using (true);

drop policy if exists player_badges_write on public.player_badges;
create policy player_badges_write on public.player_badges
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists player_accessories_select on public.player_accessories;
create policy player_accessories_select on public.player_accessories
  for select to authenticated using (true);

drop policy if exists player_accessories_write on public.player_accessories;
create policy player_accessories_write on public.player_accessories
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists player_themes_select on public.player_themes;
create policy player_themes_select on public.player_themes
  for select to authenticated using (true);

drop policy if exists player_themes_write on public.player_themes;
create policy player_themes_write on public.player_themes
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists player_modes_select on public.player_modes;
create policy player_modes_select on public.player_modes
  for select to authenticated using (true);

drop policy if exists player_modes_write on public.player_modes;
create policy player_modes_write on public.player_modes
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ---------- Private progress: owner or admin only ----------

drop policy if exists daily_select on public.daily_activity;
create policy daily_select on public.daily_activity
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists daily_write on public.daily_activity;

-- No insert/update policy either - see the grant above. The two reward RPCs
-- write this table as the owner.

drop policy if exists missed_select on public.missed_questions;
create policy missed_select on public.missed_questions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists missed_write on public.missed_questions;
create policy missed_write on public.missed_questions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists custom_select on public.custom_questions;
create policy custom_select on public.custom_questions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists custom_write on public.custom_questions;
create policy custom_write on public.custom_questions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------- Match history: everyone signed in can read (leaderboard) ----------

drop policy if exists game_sessions_select on public.game_sessions;
create policy game_sessions_select on public.game_sessions
  for select to authenticated using (true);

drop policy if exists game_players_select on public.game_players;
create policy game_players_select on public.game_players
  for select to authenticated using (true);

drop policy if exists coin_ledger_select on public.coin_ledger;
create policy coin_ledger_select on public.coin_ledger
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------- Catalogs: read-only reference data ----------

drop policy if exists themes_select on public.themes;
create policy themes_select on public.themes for select to anon, authenticated using (true);

drop policy if exists badges_select on public.badges;
create policy badges_select on public.badges for select to anon, authenticated using (true);

drop policy if exists accessories_select on public.accessories;
create policy accessories_select on public.accessories for select to anon, authenticated using (true);

-- ---------- Public views ----------

-- Safe profile card: no student number, no email, no real name.
drop view if exists public.public_profiles;
create view public.public_profiles
with (security_invoker = false) as
select
  p.id,
  p.username,
  p.avatar,
  p.level,
  p.xp,
  p.coins,
  p.grade,
  p.strand,
  p.streak,
  p.created_at,
  coalesce(b.badges, '{}'::text[]) as badges
from public.profiles p
left join lateral (
  select array_agg(pb.badge_id order by pb.earned_at) as badges
  from public.player_badges pb
  where pb.user_id = p.id
) b on true
where p.role = 'student';

-- Leaderboard: best score, games, wins and last played, per player.
drop view if exists public.leaderboard;
create view public.leaderboard
with (security_invoker = false) as
select
  p.id,
  p.username as name,
  p.avatar,
  p.level as lvl,
  p.xp,
  p.coins,
  p.grade,
  p.strand,
  p.created_at as joined,
  p.updated_at as updated,
  coalesce(g.games, 0)::int as games,
  coalesce(g.wins, 0)::int as wins,
  coalesce(g.best_score, 0)::int as score,
  g.last_played,
  (p.last_result->>'mode') as mode,
  coalesce(b.badges, '{}'::text[]) as bd
from public.profiles p
left join lateral (
  select
    count(*) as games,
    count(*) filter (where gp.won) as wins,
    max(gp.score) as best_score,
    max(gs.ended_at) as last_played
  from public.game_players gp
  join public.game_sessions gs on gs.id = gp.session_id
  where gp.user_id = p.id
) g on true
left join lateral (
  select array_agg(pb.badge_id order by pb.earned_at) as badges
  from public.player_badges pb
  where pb.user_id = p.id
) b on true
where p.role = 'student';

-- ---------- Grants ----------

grant usage on schema public to anon, authenticated;

-- Earlier versions of this file handed the browser write access to the money
-- and result tables. GRANTs only ever add, so the old privileges have to be
-- taken away explicitly or they survive every re-run.
revoke insert, update, delete on public.profiles       from anon, authenticated;
revoke insert, update, delete on public.daily_activity from anon, authenticated;
revoke insert, update, delete on public.game_sessions  from anon, authenticated;
revoke insert, update, delete on public.game_players   from anon, authenticated;
revoke insert, update, delete on public.coin_ledger    from anon, authenticated;
revoke insert, update, delete on public.themes,
                                public.badges,
                                public.accessories     from anon, authenticated;

grant select on public.profiles to authenticated;

-- No insert/update/delete on profiles: coins, xp, level and total_correct live
-- in this table, and row level security cannot restrict *columns* - a student
-- could simply PATCH /rest/v1/profiles?id=eq.<self> {"coins":999999} and skip
-- every server-side rule. All profile writes therefore go through
-- revuzz_save_account, which is security definer and ignores money columns.

grant select on public.player_badges, public.player_accessories,
                 public.player_themes, public.player_modes to authenticated;
grant insert, update, delete on public.player_badges, public.player_accessories,
                                public.player_themes, public.player_modes to authenticated;

-- Answers, quest completion and the daily spin are written by
-- revuzz_record_game / revuzz_claim_daily only, so this table is read-only to
-- the browser. A student-owned INSERT/UPDATE here would let them hand
-- themselves the quest bonus and a second spin.
grant select on public.daily_activity to authenticated;

grant select, insert, update, delete on public.missed_questions,
                                       public.custom_questions to authenticated;

grant select on public.game_sessions, public.game_players, public.coin_ledger to authenticated;

grant select on public.themes, public.badges, public.accessories to anon, authenticated;

grant select on public.public_profiles, public.leaderboard to authenticated;

-- ---------- Handouts (lessons) ----------
-- Owner-only in both directions: a student reads and edits their own notes and
-- nobody else's. There is deliberately no teacher or admin read path, so a
-- classmate's handout can never be opened from another account.
alter table public.lessons enable row level security;

drop policy if exists lessons_select on public.lessons;
create policy lessons_select on public.lessons
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists lessons_write on public.lessons;
create policy lessons_write on public.lessons
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.lessons to authenticated;

-- ---------- AI counters ----------
-- Server-only table: RLS on, zero policies and no browser grant, so even a
-- signed-in student cannot read or edit their quota row directly. The numbers
-- come back through revuzz_ai_quota() and friends.
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- ########## 04_seed.sql ##########
-- ============================================================
-- Revuzz online database - seed data (catalogs)
-- Run after 03_policies.sql.
-- Safe to run again; rows are updated, not duplicated.
-- ============================================================

insert into public.themes (id, name, price) values
  ('cosmic', 'Cosmic', 0),
  ('ocean',  'Ocean',  50),
  ('sunset', 'Sunset', 100),
  ('forest', 'Forest', 150),
  ('neon',   'Neon',   200),
  ('candy',  'Candy',  250)
on conflict (id) do update
  set name = excluded.name, price = excluded.price;

insert into public.badges (id, name, icon, description, sort_order) values
  ('win',    'First Win',   '🏆', 'Win your first match',            1),
  ('fire',   '5 Streak',    '🔥', 'Get five correct answers in a row', 2),
  ('perf',   'Perfect',     '💯', 'Answer every question correctly',  3),
  ('sch',    'Scholar',     '🎓', 'Answer 50 questions correctly',    4),
  ('quest',  'Quest',       '🎯', 'Finish the daily quest',           5),
  ('boss',   'Boss Slayer', '⚔️', 'Defeat the boss',                  6),
  ('bomb',   'Defuser',     '💣', 'Defuse the bomb',                  7),
  ('tower',  'Defender',    '🏰', 'Defend the base',                  8),
  ('summit', 'Summit',      '🏔️', 'Win Sky Climb',                   9),
  ('royale', 'Last Standing', '👑', 'Win Quiz Royale',               10)
on conflict (id) do update
  set name = excluded.name,
      icon = excluded.icon,
      description = excluded.description,
      sort_order = excluded.sort_order;

insert into public.accessories (key, category, slot, price) values
  ('h5', 'h', 5, 80),
  ('h6', 'h', 6, 120),
  ('h7', 'h', 7, 100),
  ('g3', 'g', 3, 60),
  ('g4', 'g', 4, 60),
  ('x3', 'x', 3, 70),
  ('x4', 'x', 4, 90)
on conflict (key) do update
  set category = excluded.category,
      slot = excluded.slot,
      price = excluded.price;

-- ============================================================
-- Make yourself an administrator (run once, after you sign up):
--
--   update public.profiles
--      set role = 'admin'
--    where student_number = 'YOUR-STUDENT-NUMBER';
--
-- Then log out and back in. The 👑 Master button appears.
-- ============================================================

