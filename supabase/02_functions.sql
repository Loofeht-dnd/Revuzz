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

grant execute on function public.revuzz_save_account(jsonb) to authenticated;
grant execute on function public.revuzz_record_game(jsonb) to authenticated;
grant execute on function public.revuzz_buy(jsonb) to authenticated;
grant execute on function public.revuzz_claim_daily(text) to authenticated;
grant execute on function public.revuzz_balances() to authenticated;
grant execute on function public.revuzz_admin_grant(jsonb) to authenticated;
grant execute on function public.revuzz_admin_reset_day(jsonb) to authenticated;
grant execute on function public.revuzz_today() to authenticated;
grant execute on function public.revuzz_check_identity(text, text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
