# Revuzz Online — Supabase database + connected game

This folder turns the standalone `Revuzz-preview.html` into a version backed by a
real database (Supabase / PostgreSQL). Accounts, XP, coins, badges, the shop,
themes, daily quests, streaks, custom questions, missed questions and match
results are stored in the cloud instead of only in one browser.

The game still runs if the cloud is missing: it falls back to the old
`localStorage` behaviour automatically.

## Files

```
revuzz-online/
  index.html              entry point for a static host (redirects to the game)
  Revuzz-online.html      the game, with three extra <script> tags at the end
  config.js               your Supabase URL + publishable key (fill this in)
  revuzz-cloud.js         the bridge: login, sync, leaderboard, match history,
                          server-owned money, teacher mode
  supabase/
    01_schema.sql         tables and indexes
    02_functions.sql      triggers, login lookup, all server-side RPCs
    03_policies.sql       row-level security + leaderboard views
    04_seed.sql           themes, badges, accessories
    ALL.sql               the four files above, joined (paste once)
    verify.sql            read-only health check after setup
    demo-reset.sql        demo-day helpers (fresh spin, admin role, delete)
  tools/
    live-test.mjs         end-to-end test against the real project (61 checks)
    seed-demo.mjs         creates a populated demo class for the defense
  README.md               this file
  SCHEMA.md               data dictionary + ER diagram (for the paper)
  PRIVACY.md              data privacy notice (Data Privacy Act framing)
  DEFENSE.md              defense pack: demo script, Q&A, limitations
```

## Setup (about 10 minutes)

### 1. Create the project

1. Sign in at <https://supabase.com> and create a project (the free tier is enough).
2. Wait for the database to finish provisioning.

### 2. Run the SQL

**Shortcut:** paste `supabase/ALL.sql` (the four files joined in order) into the
SQL Editor and press Run once. Then skip to step 3.

Or run them one at a time:

| Order | File | What it creates |
|---|---|---|
| 1 | `supabase/01_schema.sql` | tables: profiles, player_badges, player_accessories, player_themes, player_modes, daily_activity, missed_questions, custom_questions, game_sessions, game_players, coin_ledger |
| 2 | `supabase/02_functions.sql` | `handle_new_user` trigger, login lookup, `revuzz_save_account`, `revuzz_record_game`, `revuzz_buy`, `revuzz_claim_daily`, `revuzz_balances`, `revuzz_admin_grant`, `revuzz_admin_reset_day`, `revuzz_today` |
| 3 | `supabase/03_policies.sql` | row-level security and the `leaderboard` / `public_profiles` views |
| 4 | `supabase/04_seed.sql` | the 10 badges, 6 themes and 7 accessories |

Each file is safe to run again.

### 2b. Check it worked

Run `supabase/verify.sql`. Every row should show `ok = true`, the catalog
counts should be 6 themes / 10 badges / 7 accessories, and the account list is
empty until you sign up.

Then, with the publishable key in `config.js`:

```powershell
node tools/live-test.mjs
```

That signs up two throwaway students and checks the whole chain for real: the
sign-up trigger, `revuzz_save_account`, `revuzz_record_game`, the leaderboard
view, password login, and that one student cannot read or edit another's row.
Delete the two `test_…` accounts in **Authentication → Users** afterwards.

### 3. Turn off email confirmation

**Authentication → Providers → Email**:

- Keep **Enable email provider** on.
- Turn **Confirm email** off.

The game uses a synthetic login address (`<student-number>@students.revuzz.app`)
and a password, so no email is ever sent. The student's real Gmail is stored as
contact information in `profiles.email`. This avoids Supabase's small built-in
email quota, which would block a class.

### 4. Connect the game

**Project Settings → API**:

- Copy **Project URL** into `config.js` → `url`.
- Copy the **anon / public** key into `config.js` → `anonKey`.

Never put the `service_role` key in `config.js`; it is not needed and would
give every visitor full control of the database.

### 5. Run it

Serve the folder (do not open the HTML as `file://`):

```powershell
cd C:\Users\Administrator\Downloads\revuzz-online
python -m http.server 8123
```

Open <http://127.0.0.1:8123/Revuzz-online.html>.

Create the first account with **any** student number and an 8+ character
password. Then make yourself the admin:

```sql
update public.profiles
   set role = 'admin'
 where student_number = 'YOUR-STUDENT-NUMBER';
```

Log out and back in: the 👑 Master button appears.

## Status

Connected and verified against project `qizdndshzwtklxipnsgr`. The project currently
uses the **legacy `anon` JWT** (shown under *API Keys → View legacy API keys*),
because no `sb_publishable_` key had been created. That works, but Supabase retires
legacy keys in early 2027 — create a publishable key before then and swap the one
value in `config.js`; nothing else changes.

`node tools/live-test.mjs` passes **61/61** against that project, including the
anti-cheat checks: money in a snapshot is ignored, match rewards are computed by
the database, and a hand-written `PATCH` to `profiles` or `daily_activity` is
refused with 403.

## How the sync works

The game was written around synchronous `localStorage`, so the bridge keeps that
cache and mirrors it:

- **Login** pulls the profile and all child rows, writes them into
  `rv_users` / `rv_leaderboard`, then fills the game state.
- **Every `save()`** (avatar change, purchase, spin, quest, level up, game end)
  debounces for 700 ms and calls `revuzz_save_account`, which writes the whole
  account snapshot in one transaction. Money is not part of that snapshot: the
  RPC returns the real balances and the client overwrites its local copy with
  them.
- **Every finished match** calls `revuzz_record_game` with facts only (rank,
  score, correct/wrong). Coins, XP, the level-up and the daily quest are
  computed inside the database.
- **Purchases and the daily spin** mirror to `revuzz_buy` / `revuzz_claim_daily`,
  which price the item and roll the reward server-side. If the server refuses,
  the local optimistic change is rolled back by re-pulling the profile.
- **Leaderboard** loads local rows first, then merges the cloud `leaderboard`
  view, so other devices appear.
- **Logout** signs out of Supabase and clears the local account cache.

**Teacher mode.** Master Control has two faces, and the header tells you which:
signed in as an account whose database role is `admin`, it lists every student
from the server and writes coin/XP corrections through `revuzz_admin_grant`, so
the change appears on the student's own device. Without that role it falls back
to the local preview, which only edits this browser. Nobody can promote
themselves; the role is set in SQL (`supabase/demo-reset.sql` has the line).

If the network or Supabase is unavailable, the game keeps working locally and
shows “Cloud save failed - kept on this device”.

## Money is server-owned

`coins`, `xp`, `level`, `total_correct` and the whole `daily_activity` row can
only be changed by three RPCs:

| Action | RPC | What the browser may send |
|---|---|---|
| match reward | `revuzz_record_game` | rank, score, right/wrong counts, mode |
| shop purchase | `revuzz_buy` | item kind + id (price comes from the catalog) |
| daily spin | `revuzz_claim_daily` | nothing (the reward is rolled in the database) |
| teacher correction | `revuzz_admin_grant` | student number + delta (refused unless the caller is an admin) |
| demo reset | `revuzz_admin_reset_day` | student number (admin only) |

The browser has **no `INSERT`/`UPDATE` grant** on `profiles` or `daily_activity`,
and no update policy on them, so a hand-written
`PATCH /rest/v1/profiles?id=eq.<self> {"coins":999999}` is rejected — the RPC is
the only door. `revuzz_save_account` runs as `security definer` for exactly that
reason and ignores every money key it receives.

Consequence for players: **money only moves while online.** Offline play still
works, still scores, and still saves cosmetics when the connection returns, but
the coins and XP from an offline match are not credited (that is the price of
not trusting the client). The local numbers are overwritten by the server's on
the next sync.

Still client-writable on purpose (no money value, documented soft spots):
`inventory` (lifeline counts) and `player_badges`. Move them into RPCs before
the game is used for anything graded.


## Where each piece lives

| Game data | Database |
|---|---|
| student number, username, name, grade, strand, school year, email, avatar, role | `profiles` |
| XP, level, coins, active theme, streak, total correct, last result, inventory, preferences | `profiles` (money columns are server-only) |
| owned badges | `player_badges` |
| purchased accessories | `player_accessories` |
| unlocked themes | `player_themes` |
| game modes opened | `player_modes` |
| daily quest, daily spin, streak history | `daily_activity` (server-written only) |
| missed questions (flashcard review) | `missed_questions` |
| the player's own quiz questions (max 40) | `custom_questions` |
| match header | `game_sessions` |
| per-match score, rank, win, correct/wrong | `game_players` |
| coin audit trail | `coin_ledger` |
| catalogs | `themes`, `badges`, `accessories` |

## Security notes (read before a real class)

- The publishable key (`sb_publishable_…`, or the older `anon` JWT) is public by
  design. All protection comes from row-level security plus the grant rules: a
  student can read their own profile and progress and edit only cosmetics
  through `revuzz_save_account`. Student numbers and emails are never in the
  public views.
- **Never put a secret key (`sb_secret_…`) or a `service_role` JWT in
  `config.js`.** It ignores every policy and would give any visitor full control
  of the database. As a safety net, `revuzz-cloud.js` inspects the key on start-up
  and refuses to go online, with a console error, if it looks like one.
- `role` and `student_number` cannot be changed by a student; a trigger restores
  them. Only SQL/dashboard changes can create an admin.
- **Rewards are computed in the database** (see *Money is server-owned* above).
  The client can no longer invent coins or XP, and it cannot patch the balance
  table directly because it has no write grant on `profiles`. What a determined
  student can still do is play a match and set their own score in the request —
  the server trusts the reported score, since it never sees the questions. For
  fully cheat-proof scoring the questions must move server-side too.
- **Master Control has two modes.** Signed in as an account whose database role
  is `admin`, it lists every student from the server and writes coin/XP changes
  through `revuzz_admin_grant` (the RPC re-checks the role, so the panel is not
  the gate). Without that role it falls back to the local preview, which only
  edits accounts cached in this browser.
- **The online leaderboard comes from the database only.** Accounts cached in the
  browser are merged in when offline, but while online they are ignored - a
  shared computer cannot show a previous student's local test account.
- **Deleting a student removes everything.** Deleting the user in
  **Authentication → Users** cascades to the profile, unlocks, daily rows,
  match rows and coin ledger (the foreign keys are `on delete cascade`).
- There is no self-service password reset. Use **Authentication → Users** in the
  Supabase dashboard, or add a recovery flow later.
- Email-code login is not enabled. It needs custom SMTP and a `{{ .Token }}`
  email template; password login is the supported mode.

## Troubleshooting

| Message | Fix |
|---|---|
| “The database is not set up yet” | Run the four SQL files, in order. |
| “Account created, but Supabase still asks for email confirmation” | Turn off **Confirm email**, then log in. The account already exists. |
| Sign-up fails with `email_address_invalid` / 400 | GoTrue checks that the domain has an MX record while **Confirm email** is on. `students.revuzz.app` has none, so turn Confirm email off — the synthetic login address then bypasses the check. |
| “Cloud not configured - offline mode” | Fill `config.js` with the project URL and publishable key. |
| “Wrong key type in config.js - see console” | You pasted a `sb_secret_…` or `service_role` key. Revoke it in **API Keys** and use `sb_publishable_…`. |
| “Wrong student number or password” | Use the password chosen at sign-up, or reset it from the Supabase dashboard. |
| Cloud saves fail but the game works | Check the browser console; usually RLS is missing because `03_policies.sql` was skipped. |
| “Purchase rejected - refreshing your balance” | The server refused the buy (not enough coins, or the price differs). The local change is rolled back automatically. |
| Coins do not change after an offline match | By design - money only moves through the RPCs, so it needs a connection. |
| You edited `revuzz-cloud.js` (or `config.js`) and the old behaviour is still there | The browser cached the file. Bump the `?v=` date on those two `<script src>` tags in `Revuzz-online.html`. |
| A `PATCH` to `profiles` returns 403 | Correct. The browser has no write grant on `profiles`; use `revuzz_save_account` / `revuzz_buy`. |

## Deploying

The folder is static. Upload it to Vercel, Netlify or GitHub Pages as-is. The
only secret is the publishable key, which is meant to be public; never add the
`service_role` or `sb_secret_…` key.

`index.html` is the entry point: it opens `Revuzz-online.html`, so the site's
root URL works instead of 404-ing.

Vercel (recommended, ~2 minutes):

1. Push this folder to a GitHub repository.
2. On <https://vercel.com> → **Add New → Project** → import that repository.
3. Framework preset: **Other**. Build command: *empty*. Output directory: `.`
   (the folder root — there is nothing to build).
4. Deploy. Every later `git push` redeploys automatically.
5. Open the URL on a phone and log in once to confirm the deployed copy reaches
   the same database.

Netlify and GitHub Pages work the same way (drag the folder onto Netlify, or
enable Pages on the repository root). No environment variables are needed: the
project URL and publishable key live in `config.js`.

`.vercelignore` keeps `supabase/`, `tools/` and `DEFENSE.md` in the repository
but off the public site — the SQL, the seeder (it contains the demo password)
and the defense notes are for you, not for visitors. On Netlify or GitHub Pages,
delete or move those folders before publishing, or keep the repository private.

### Before a demo or a defense

```
node tools/live-test.mjs        # 61 checks must pass
node tools/seed-demo.mjs        # creates the demo class, prints the passwords
```

Then run option 2 in `supabase/demo-reset.sql` so the daily spin and quest are
fresh for the presentation. `DEFENSE.md` has the rehearsal checklist and the
demo script.
