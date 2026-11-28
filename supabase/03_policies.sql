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
