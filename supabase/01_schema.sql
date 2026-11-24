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
