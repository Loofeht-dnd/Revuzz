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

We do **not** collect: home address, birthdate, grades in other subjects,
photos, device location, or anything from the phone.

## Who can see it

- **The student** sees their own profile, progress and match history.
- **Other signed-in players** see the leaderboard only: username, avatar, level,
  XP, coins, grade, strand, best score, games, wins, badges. No student number,
  no Gmail, no real name.
- **A teacher (admin role)** can see the class list and can correct coins/XP.
  Only a database change (SQL) can give someone the admin role; a student cannot
  promote themselves.
- **Nobody else.** The public key shipped in the browser is not a password: the
  database refuses every row that does not belong to the caller. This is checked
  by 61 automated tests, including attempts to read another student's row and to
  edit one's own coins.

## How it is protected

- Passwords are hashed by Supabase Auth; the app never stores or sees them.
- Every table has row-level security; the browser's key is publishable by design.
- Money (coins, XP, level, total correct) can only be changed by three
  server-side functions, never by the browser. The browser has no write grant on
  those columns at all.
- Traffic is HTTPS.

## Retention and deletion

Data stays while the school uses the system. A student can ask the teacher to
delete the account; the teacher deletes it in **Authentication → Users**, which
removes the profile, progress, match history and coin ledger automatically
(every table cascades from `auth.users`).

## Honest limitations (say these before a panel finds them)

- The server trusts the score the game reports, so a student who edits the
  page could claim a higher score and gain XP. It cannot invent coins, change a
  balance, or touch another account.
- Playing without an internet connection works, but earns no coins or XP.
- The daily quest and spin reset at **midnight Philippine time**.

## Contact

Ask the class adviser / system administrator. This is a student project, not a
commercial service, and there is no third-party analytics or advertising.
