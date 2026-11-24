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
