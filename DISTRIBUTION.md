# Giving this to a QA friend — build, install, update

## TL;DR — what to do right now

```
cd apps/desktop
pnpm dist:win
```

This produces a real Windows installer at
`apps/desktop/release/MyPetCompanion-Setup-<version>.exe` (~80MB, already
built once as proof — works). **Send that one file** to your friend (email,
Drive, Discord, whatever). They double-click it, click through the
installer (it's a normal "Next → Next → Install" NSIS wizard, not
one-click, so they can change the install folder if they want), and it adds
a desktop + Start Menu shortcut. No Node, no pnpm, no git — just an app.

**They no longer need pnpm/source at all.** That was the old way; this is
the real one.

## The Windows "unknown publisher" warning

The installer isn't code-signed (a signing certificate costs money and
isn't worth it yet for a friend-testing build). Windows SmartScreen will
show a blue "Windows protected your PC" screen. Tell your friend:
**"More info" → "Run anyway"**. This is expected and safe — it's just
because the app isn't signed, not because anything's wrong. Worth doing
before a wider public release, not before a QA friend.

## Auto-update — the code is already wired, one thing left to decide

`electron-updater` is installed and configured (`apps/desktop/electron/main.ts`
→ `setupAutoUpdate()`): on every launch, and every 2 hours after, the app
silently checks GitHub Releases, downloads any newer version in the
background, and installs it the next time the app restarts. Nothing
force-quits mid-session. This only activates in a **packaged** build —
`pnpm dev` never checks for updates.

**To make a new version reach your friend automatically**, you publish a
GitHub Release instead of just emailing a new .exe:

```
cd apps/desktop
$env:GH_TOKEN = "<a GitHub personal access token with repo scope>"
pnpm release:win
```

This builds AND uploads the installer + the update metadata files
(`latest.yml`, `.blockmap`) to a new GitHub Release on
`friedmannhen/my_pet_companion`, tagged with the version in
`apps/desktop/package.json`. Bump that version number before each release.

**One thing to decide: is the GitHub repo public or private?**
- **Public repo** → updates just work, no extra setup, `GH_TOKEN` only
  needed at publish time (on your machine), never shipped to your friend.
- **Private repo** → the *installed app itself* also needs a token to
  download release assets (electron-updater supports this via a
  `GH_TOKEN` environment variable **on the end-user's machine**, which is
  awkward to hand a non-technical QA tester). The practical options if you
  want to stay private: (a) make the repo public (fine — it's a hobby
  project, no secrets live in the code, real keys are `.env`-only and
  gitignored), or (b) skip GitHub Releases as the feed and self-host the 3
  update files somewhere with a public URL instead (S3/Cloudflare
  R2/anything static) — a bit more setup, tell me if you want this instead.

I didn't publish anything or touch repo visibility — that's your call to
make once, then it's a two-command release each time after.

## Do you need a separate test/QA Supabase project?

**Short answer: yes, recommended, but I didn't create one — that's a real
account/billing decision only you should make.**

Right now everything (your own dev saves, the leaderboard, hall of fame,
achievements) lives in one Supabase project. If a QA friend starts playing
against that same project:
- Their save/pet becomes a real row next to yours — fine on its own.
- But they'll show up on **your leaderboard and hall of fame**, and if they
  hatch/evolve/quest through test data quickly (or you ask them to spam
  actions to find bugs), that pollutes rankings that are otherwise
  meant to be real.
- Your admin "full reset" tools only reset *your own* account's data —
  there's no "wipe the whole project" button, on purpose (safety).

**My recommendation:** spin up a second free-tier Supabase project for
QA/beta (Supabase's free tier is genuinely free, no card needed for a
small hobby-scale project), point a `.env` at it for test builds, and keep
your current project as the "real" one going forward. Given account/org
creation and any billing surface, I'm not doing this without you — but
it's a 2-minute dashboard click if you want to go that way:

1. supabase.com → New Project (free tier) → copy its URL + publishable key.
2. In `apps/desktop`, create `.env.qa` (gitignored, same shape as your
   current `.env`) with those QA values.
3. I'll wire a build script that swaps `envDir`/`.env` file per-target so
   `pnpm dist:win:qa` vs `pnpm dist:win` point at different backends —
   say the word and I'll add that.
4. Run the SAME migrations against the new project
   (`supabase db push` with `--project-ref` pointed at it) so QA has the
   identical schema.

If you'd rather keep it simple for now (one project, QA data mixed in, use
the admin reset tools liberally), that's a completely reasonable v1 choice
too — just flag it to your friend so they know test data will be visible
to you and vice versa.

## What I did NOT do (needs your decision)

- Did not touch GitHub repo visibility.
- Did not publish a release (the built .exe is local-only, in
  `apps/desktop/release/`, gitignored).
- Did not create a second Supabase project.
- Did not buy/configure code signing.

Tell me which of these you want and I'll do the rest.
