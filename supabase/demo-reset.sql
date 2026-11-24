-- ============================================================
-- Demo-day reset (run in the Supabase SQL Editor)
--
-- The daily quest (10 correct) and the daily spin are once per day.
-- If you rehearse the demo, the live demo will say "already spun".
-- Run one of these to give a student a fresh day.
--
-- The SQL editor runs as the database owner, so these statements skip
-- row-level security. Inside the game, a teacher account uses the
-- revuzz_admin_reset_day() function instead - it needs to be signed in.
-- ============================================================

-- 1. Reset ONE student, by student number.  <-- replace the number
delete from public.daily_activity
where user_id = (
  select id from public.profiles where student_number = '02000440001'
)
and activity_date = public.revuzz_today();

-- 2. Reset everyone (fresh day for the whole class).
delete from public.daily_activity
where activity_date = public.revuzz_today();

-- ------------------------------------------------------------
-- Make someone a teacher (admin). Only SQL can do this.
-- ------------------------------------------------------------
-- update public.profiles set role = 'admin'   where student_number = '02000444475';
-- update public.profiles set role = 'student' where student_number = '02000444475';

-- ------------------------------------------------------------
-- Delete a student completely (account + progress + matches).
-- The profile, progress, matches and ledger cascade from auth.users.
-- ------------------------------------------------------------
-- delete from auth.users where email = '02000440001@students.revuzz.app';

-- ------------------------------------------------------------
-- Quick look at the class.
-- ------------------------------------------------------------
-- select student_number, username, level, xp, coins, total_correct, last_played_on
-- from public.profiles order by username;
