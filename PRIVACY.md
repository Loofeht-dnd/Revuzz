# Revuzz — Data Privacy Notice

Short version for the sign-up screen and for anyone who asks what the system
stores. Revuzz is a school project; this notice exists so students and teachers
know exactly what is kept, who can see it, and how to get it removed.

## What we collect

| Data | Why | Where it lives |
|---|---|---|
| Last, first and middle name | so the teacher and other players can tell students apart | `profiles` |
| Student number | the login name (the password is separate) | `profiles`, first column of `auth.users` email |
| Gmail address | school contact only — it is **never** used to log in or to "verify" anything | `profiles.email` |
| Grade, strand, school year | so results can be grouped by class | `profiles` |
| Game progress: level, XP, coins, streak, badges, unlocked items, daily quest/spin, missed questions, questions the student wrote | the whole point of the game | `profiles` and related tables |
| Match history: mode, score, rank, right/wrong counts, date | leaderboard and class results | `game_sessions`, `game_players` |
| Coin movements | so a balance can be explained | `coin_ledger` |
| Handouts/notes a student uploads or pastes for Solo study | so the AI can summarise and make practice questions from their own lesson | `lessons` (private to that student) |
| Number of AI calls used today | to keep one class from using up the AI budget | `ai_usage` (server-only) |

We do **not** collect: home address, birthdate, grades in other subjects,
photos, device location, or anything from the phone. An uploaded file is read
**on the student's device**; the original file is never uploaded — only the
text that was pulled out of it, and only to that student's own `lessons` rows.

## Who can see it

- **The student** sees their own profile, progress and match history.
- **Other signed-in players** see the leaderboard only: username, avatar, level,
  XP, coins, grade, strand, best score, games, wins, badges. No student number,
  no Gmail, no real name.
- **A teacher (admin role)** can see the class list and can correct coins/XP.
  Only a database change (SQL) can give someone the admin role; a student cannot
  promote themselves. A teacher **cannot** read a student's uploaded handouts:
  `lessons` has owner-only policies and no admin read path.
- **The AI provider** receives the text of the handout the student chose to
  analyse, plus the prompt, for the few seconds it takes to answer. The key used
  to call it is stored in Supabase secrets and is never sent to the browser. If
  no key is configured, nothing leaves the server and the Solo screen uses
  on-device fallbacks.
- **Nobody else.** The public key shipped in the browser is not a password: the
  database refuses every row that does not belong to the caller. This is checked
  by 61 automated tests, including attempts to read another student's row and to
  edit one's own coins, plus separate checks that one student cannot read
  another's lesson or spend another's AI quota.

## How it is protected

- Passwords are hashed by Supabase Auth; the app never stores or sees them.
- Every table has row-level security; the browser's key is publishable by design.
- Money (coins, XP, level, total correct) can only be changed by three
  server-side functions, never by the browser. The browser has no write grant on
  those columns at all.
- Handouts are protected by owner-only row-level security; the AI quota counters
  are server-only and have no browser grant.
- Traffic is HTTPS.

## Retention and deletion

Data stays while the school uses the system. A student can ask the teacher to
delete the account; the teacher deletes it in **Authentication → Users**, which
removes the profile, progress, match history, uploaded handouts and coin ledger
automatically (every table cascades from `auth.users`). A student can also
delete one handout themselves on the Solo screen without deleting the account.

## Honest limitations (say these before a panel finds them)

- The server trusts the score the game reports, so a student who edits the
  page could claim a higher score and gain XP. It cannot invent coins, change a
  balance, or touch another account.
- Playing without an internet connection works, but earns no coins or XP.
- The daily quest and spin reset at **midnight Philippine time**.
- The AI writes practice questions from a handout; it is not a graded exam and
  can be wrong. A teacher should skim generated questions before using them.
- AI is capped at 30 calls / 300 questions per student per day, with a class-wide
  cap, so one class cannot run up an unlimited bill.

## Contact

Ask the class adviser / system administrator. This is a student project, not a
commercial service, and there is no third-party analytics or advertising.
