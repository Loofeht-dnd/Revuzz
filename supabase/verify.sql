-- ============================================================
-- Revuzz online database - health check (read only)
-- Run in the Supabase SQL Editor AFTER supabase/ALL.sql.
-- Every row should say "ok" = true. A false row tells you
-- exactly which statement did not run.
-- ============================================================

with expect(kind, name) as (
  values
    -- catalogs
    ('table', 'themes'),
    ('table', 'badges'),
    ('table', 'accessories'),
    -- player
    ('table', 'profiles'),
    ('table', 'player_badges'),
    ('table', 'player_accessories'),
    ('table', 'player_themes'),
    ('table', 'player_modes'),
    ('table', 'daily_activity'),
    ('table', 'missed_questions'),
    ('table', 'custom_questions'),
    -- matches
    ('table', 'game_sessions'),
    ('table', 'game_players'),
    ('table', 'coin_ledger'),
    -- row level security
    ('rls',   'profiles'),
    ('rls',   'player_badges'),
    ('rls',   'daily_activity'),
    ('rls',   'missed_questions'),
    ('rls',   'custom_questions'),
    ('rls',   'game_sessions'),
    ('rls',   'coin_ledger'),
    -- views
    ('view',  'leaderboard'),
    ('view',  'public_profiles'),
    -- functions
    ('function', 'public.is_admin()'),
    ('function', 'public.revuzz_check_identity(text,text)'),
    ('function', 'public.revuzz_save_account(jsonb)'),
    ('function', 'public.revuzz_record_game(jsonb)'),
    ('function', 'public.revuzz_buy(jsonb)'),
    ('function', 'public.revuzz_claim_daily(text)'),
    ('function', 'public.revuzz_balances()'),
    -- triggers
    ('trigger', 'on_auth_user_created'),
    ('trigger', 'profiles_touch_updated'),
    ('trigger', 'profiles_protect_columns')
)
select
  kind,
  name,
  case kind
    when 'table'    then to_regclass('public.' || name) is not null
    when 'view'     then to_regclass('public.' || name) is not null
    when 'rls'      then coalesce((select c.relrowsecurity from pg_class c
                                   where c.oid = to_regclass('public.' || name)), false)
    when 'function' then to_regprocedure(name) is not null
    when 'trigger'  then exists (select 1 from pg_trigger where tgname = name)
  end as ok
from expect
order by ok, kind, name;

-- Anti-cheat: the browser must have no write grant on the money tables.
-- Expect 'ok' = false on every row (false = no write privilege, which is what
-- we want); any true row means a stale grant from an old version survived.
select t as "table", p as privilege,
       has_table_privilege('authenticated', 'public.' || t, p) as browser_can_write
from unnest(array['profiles', 'daily_activity', 'game_players', 'coin_ledger']) t,
     unnest(array['INSERT', 'UPDATE', 'DELETE']) p
order by 1, 2;

-- Seed data: expect 6 themes, 10 badges, 7 accessories.
select 'themes'      as catalog, count(*) as rows from public.themes
union all
select 'badges',      count(*) from public.badges
union all
select 'accessories', count(*) from public.accessories
order by catalog;

-- Accounts created so far (empty until you sign up in the game).
select student_number, username, role, level, xp, coins, created_at
from public.profiles
order by created_at
limit 20;
