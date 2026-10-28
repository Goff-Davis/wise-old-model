# Architecture

> **Status:** being built phase by phase from [PLAN.md](PLAN.md). Built so far: Phase 1 (the server with its local-only guard, configuration, the database with migrations and backups, settings, and the client shell with both themes) and Phase 2 (the shared request handler, the hiscores and Wise Old Man sources, saved source data with its history, freshness and Refresh, the accounts API, game icons, the Overview page, the menu and the add-account dialog). Everything else here is still the planned design. Update each section as it gets built so this file describes the code as it actually is.

## Overview

```
 Browser (http://127.0.0.1:4747)
        │
        ▼
 Express server (bound to 127.0.0.1 only; also serves the built client)
   ├── Data sources ──► OSRS Hiscores (Jagex)
   │                ──► Wise Old Man API
   │                ──► TempleOSRS API
   │                ──► OSRS Wiki (MediaWiki API, Bucket, prices API, images)
   │                ──► RuneLite item icons
   │                ──► Character Export JSON files (filesystem)
   ├── SQLite (accounts, snapshots, cache, goals, chats, settings)
   └── AI provider ─► Claude Agent SDK (Claude Code) ──► Claude (plan or API key)

 RuneLite + Character Export plugin ──► .runelite/character-exporter/<name>/*.json
 RuneLite + Temple OSRS plugin ──────► TempleOSRS (collection log sync)
```

The server exists because the Jagex hiscores send no CORS headers (the browser can't call them directly) and because Claude credentials must stay out of the browser.

## Layout

Folders described only in general terms are still planned; adjust as the code takes shape.

```
/server/src
  /sources   one module per data source (hiscores, wom, temple, wiki, prices, icons, character-export),
             and answers.ts: what they share (fetch an answer and check it parses, read one back)
  /http      inbound: the local-only guard (localOnly.ts), listenLocal and JSON errors (errors.ts);
             outbound: the shared request handler (requester.ts: User-Agent, per-site queues,
             retries)
  /db        node:sqlite + Kysely adapter, migrations, queries
  /store     saved source data: the newest per account and kind, and its history
             (sourceState.ts)
  /calc      XP, requirement checks, gear upgrades, goal progress
  /ai        provider interface, Claude (Agent SDK) provider, tools, instructions
  /routes    Express routes (accounts, account data, refresh, goals, chats, settings, icons)
  /services  work that spans sources and the database (freshness.ts: ensureFresh; accounts.ts:
             lookup, add, rename, delete, refresh; overview.ts: the Overview page's data)
  /settings  settingsRepo: settings read and saved one row each
  app.ts     createApp: security headers, the guard, routes, and the built client in production
  config.ts  loadConfig: .env values, per-OS defaults, validation
  main.ts    entry point: loads the config, then startServer, and prints what went wrong if either fails
  dev.ts     development entry point: runs main.ts and starts it again when the code changes (watch.ts)
  start.ts   startServer: claims the port on 127.0.0.1 first (so a second copy stops before it can
             touch the database), opens the database (backed up at startup), then serves the app
/server/test helpers for tests (tempDir, testConfig with a fresh temp data folder, testDb: a
             migrated database closed after the test, call: one real HTTP request, fixture,
             fakeRequester with the requester's notFound and outage errors, insertAccount)
/client/src  React app
  main.tsx   entry point: fonts, theme tokens, then <App />
  App.tsx    routes and the TanStack Query client
  /api       fetch helpers that check each answer with a Zod schema (apiGet, apiSend), the
             TanStack Query client (createQueryClient, apiQuery), and the account queries and
             actions (accounts.ts)
  /components shared pieces of the page (Icon, StatsTiles, Menu, AddAccountDialog, and Problem:
             something that went wrong, announced as it appears)
  /layout    the three-column shell
  /pages     one folder per page; pageList.ts holds the menu order and URL ids
  /settings  useSettings hooks: read and change settings, put the theme on <html>, report the
             browser's time zone
  /test      test setup (cleanup after each test), fakeApi (a stand-in for the server), renderApp
             (the app at a path) and test data
  /theme     tokens.css (both themes) and the bundled fonts
/shared/src  Zod schemas and types for the API (settings, accounts, source kinds, freshness, the
             overview, the error answer), the ports, nameKey, the time helpers and formatNumber,
             used by server and client; /osrs holds game rules both sides need (combatLevel,
             wikiIconFile, the stats tab's order and isBoss)
```

## Platforms

Runs on Windows, macOS, Linux and WSL. Developed on WSL; the finished app will likely run on Windows.

- **Scripts:** npm scripts use only Node and cross-platform tools. Environment variables set in scripts go through `cross-env`, `.env` is loaded with Node's `--env-file-if-exists`, and paths are built with Node's `path`.
- **App data** (SQLite database, caches) lives in the OS's app-data folder: `%LOCALAPPDATA%\wise-old-model` on Windows (or `<home>\AppData\Local\wise-old-model` without `LOCALAPPDATA`), `~/Library/Application Support/wise-old-model` on macOS, `$XDG_DATA_HOME/wise-old-model` or `~/.local/share/wise-old-model` on Linux and WSL (a relative `XDG_DATA_HOME` is ignored, per the XDG spec). `DATA_DIR` overrides it. On WSL this keeps SQLite off the Windows drive, where its file locking isn't reliable.
- **RuneLite folder** defaults to `~/.runelite`, where RuneLite keeps it on every OS. `RUNELITE_DIR` overrides it; on WSL with RuneLite on Windows it's `/mnt/c/Users/<user>/.runelite`.
- **Folder settings** (`DATA_DIR`, `RUNELITE_DIR`): empty means the default; a leading `~` means the home folder; on Windows a WSL path such as `/mnt/c/Users/me/.runelite` becomes `C:\Users\me\.runelite`, so a `.env` shared with WSL keeps working. Anything else that wouldn't work on this OS (a Linux path on Windows, a Windows path on Linux or WSL, a relative path, a line break) stops the server with a message saying what to write instead.
- **Dependencies:** no native Node add-ons that compile on install (node-gyp). Tools that ship prebuilt per-OS binaries through npm (Vite, Biome, TypeScript 7, the Agent SDK's Claude Code) are fine.
- **No scheduled jobs:** the app only fetches data while you use it, so nothing depends on cron or Task Scheduler.
- **Watching for code changes** in development checks files' modified times once a second rather than waiting for file-change events, which WSL doesn't deliver for files on a Windows drive (`/mnt/c/...`); it works the same on every OS. Each check of the server's code costs about 10 ms of CPU there.
- **Switching OS:** moving one checkout between WSL and Windows needs a fresh `npm install`, because build tools like Vite ship per-OS binaries.

## Backend

- **Stack:** Node.js 26 (pinned in `mise.toml`), Express 5, TypeScript run directly by Node (see Repo and tooling).
- **Data sources:** one module per source, all sending requests through the shared request handler (see Data sources → Fetching and caching).
- **Local-only server:** binds to `127.0.0.1`. Every request must carry a `Host` of `localhost:<port>` or `127.0.0.1:<port>` (bare names too on port 80, which browsers omit), which blocks DNS-rebinding attacks from websites open in the same browser; requests the browser marks as coming from another site (`Sec-Fetch-Site` of `cross-site` or `same-site`, which covers pages on other localhost ports) are refused unless they open a page (a GET top-level navigation), so an `<img>` or `fetch()` on another site can't make the server do anything, such as fetch an icon; any request other than GET or HEAD must also carry a matching `Origin`. In development the Vite dev server's port 5173 is accepted as well, because the Vite proxy passes the browser's Host and Origin through. Failures get a 403 with a plain explanation.
- **Security headers** on every response: `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (no other site can frame the app and trick clicks onto its buttons), `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`.
- **Production serving:** files from `client/dist`; paths without a file extension get `index.html` (app pages); a missing asset gets 404; if the client isn't built, the server warns at startup and pages answer 503 with "run npm run build".
- **Startup:** the server claims its port first, so a second copy stops with "port in use" before it can touch the database; then it opens the database (migrating and backing up as needed), answering 503 "starting" meanwhile, and hands the port to the app.
- **Storage:** Node's built-in SQLite (`node:sqlite`, "release candidate" in Node 26), queried through [Kysely](https://kysely.dev) via a small adapter of our own (Kysely's SQLite dialect expects statements with a `reader` flag and array parameters; `node:sqlite` gives `columns()` and spread parameters). Schema changes are Kysely migrations. No compiled add-ons. Fetched data that changed is saved as a snapshot with the raw response, so parsers can be improved later without losing history.
- **API:** REST routes under `/api` for accounts (look up, add, rename, delete), account data (overview, this week, bank and gear, collection log), refresh and file checks, goals, chats (list, send, approve or decline, stop), settings and icons. Chat answers stream over SSE. Built so far: `GET /api/health`; `GET /api/settings` and `PATCH /api/settings` (any subset of the settings; unknown keys and invalid values get a 400 with Zod's message, and nothing is saved); `GET /api/accounts` (by name); `GET /api/accounts/lookup?name=` (what the hiscores and Wise Old Man know; `onHiscores` and `womTracked` are null for a source that couldn't be checked, and `problems` says why, so an outage isn't reported as an unknown name); `POST /api/accounts` `{ name, type, trackOnWom }` → 201 `{ account, problems }` (Wise Old Man is asked about the name, and asked to start tracking only when it doesn't track it and the person chose to; its answer is saved, so the new account's first Overview doesn't ask again; Wise Old Man failing doesn't stop the add, but tracking that didn't start is listed in `problems`; 409 when the name matches an account already added); `PATCH /api/accounts/:id` `{ name?, type? }` (a rename keeps the history and forgets the old name's failures, so the next fetch asks under the new name; a type that differs from the saved one counts as set by hand); `DELETE /api/accounts/:id` (204; all its data goes too); `POST /api/accounts/:id/refresh` → `{ freshness, renameSuggestion }`; `GET /api/accounts/:id/overview` (the Overview page's data, after fetching the hiscores and Wise Old Man's player when they're past their freshness limits). Names must be 1 to 12 letters, numbers, spaces, hyphens or underscores, with at least one letter or number. An account id is plain digits; an unknown one is a 404. `GET /api/icons/wiki/:file` and `GET /api/icons/item/:id` (see Game icons).
- **Errors** answer in JSON (`{ "error": "..." }`, `ErrorAnswerSchema` in shared) like everything else, and only one place writes them: the last middleware, `jsonErrors`. Routes and the guard throw or pass on an `HttpError(status, message)`, and `parseInput(schema, body)` turns a body that doesn't fit into a 400 with Zod's message. An error meant for the client (marked `expose`: an `HttpError`, or a body that isn't JSON or is too large) keeps its 4xx status and message. Another site's failure (a `SourceError` from the request handler, whose message names the site and says what went wrong) answers 502 with its message, so routes needn't catch it unless they treat it specially (the icon routes answer a missing icon with a 404). Anything else is a 500 that says to look at the server's console, where the details go, even when it carries a status (a missing file's path isn't the browser's business).

## Data sources

### How each source is used

| Source | Used for |
|---|---|
| Character Export | Everything in game: quests, diaries, combat achievements, bank, seed vault, inventory, gear, levels and XP |
| Official hiscores | Our own snapshots of levels, XP, ranks, boss kill counts and clue counts, with no third party in between |
| Wise Old Man | Gains over any period, EHP/EHB and time to max, achievements, history from before the app existed, and account type |
| OSRS Wiki | Search and page sections for cited answers; Bucket tables for quest requirements, combat achievements, gear stats, recommended gear and drop sources |
| Wiki prices | GE prices and item info |
| TempleOSRS | Collection log: every item with count and date obtained, totals, last sync time and EHC. Needs the Temple OSRS RuneLite plugin (one manual sync, then automatic sync of new items). The hiscores' "Collections Logged" total is the backup number |

- In This week and `get_gains`, XP and kill gains come from Wise Old Man; quests, diaries and combat achievements completed come from our own snapshots; new collection log items come from Temple's dates. Our own hiscores snapshots keep an independent copy of the stats history.
- **When a source fails,** the app keeps showing the last good data, marks it stale with the reason (shown next to the freshness times), and tools report it to the AI so it can say so.
- The app never updates Wise Old Man automatically. Refresh asks it to update a player only when its data is more than an hour old.
- Every outbound request sends a descriptive User-Agent with the contact info set in `.env`.

### Fetching and caching

- **Only when used.** Online data is fetched when it's needed (opening an account, a chat question that needs it, or Refresh), and only when the saved copy is older than its freshness limit. There is no background fetching and no scheduled job; the app only runs while you're using it.
- **Refresh** skips the freshness limits, but won't refetch a source fetched less than a minute ago, and still follows the Wise Old Man update rule above.
- **A failed attempt counts** toward the limit like a fetch, so a site that's down, or one that doesn't know the account (a 404), isn't asked again on every open: the last good data stays, reported stale with the reason (and `notFound` for a 404, which a rename suggestion uses), until the next attempt. The server remembers failures while it runs, including for a source never fetched, which has no row. A fetch already under way is shared, so two tabs or a page load during Refresh don't fetch twice, and an attempt dated more than a minute in the future (the clock went back) counts as due. Wise Old Man is contacted only when one of its kinds is due. On Refresh, if its player answer says it last updated the player over an hour ago, it's asked to update, and the update's answer (the updated player) is what's saved; its gains and achievements are read after the player answer, and not at all when it doesn't track the player, since they'd only be not found too. A player it doesn't track answers 404 first, so Refresh never starts tracking anyone. This is `ensureFresh` in `server/src/services/freshness.ts`, which knows nothing about any one source: each kind has a fetcher, told whether it's a Refresh, and a small table says which kinds wait for which on Refresh.
- **Snapshots:** a fetch whose data differs from the last one is saved exactly as received. Identical data isn't saved twice.

| Data | Kept for |
|---|---|
| Hiscores | 15 min |
| Wise Old Man reads | 15 min |
| Temple collection log | 1 hour |
| GE prices (`/latest`, every item in one request) | 5 min |
| Item list (`/mapping`) | 1 day |
| Wiki Bucket query results | 1 day |
| Wiki search results | 1 day |
| Game icons (wiki images, RuneLite item icons) | Permanently, as files in the data folder |
| Wiki pages | Until the page changes. A saved page older than a day is checked against the wiki's current revision id (one request covers up to 50 pages) and downloaded again only if it changed. |

**Whole tables** are fetched once and reused rather than queried per question: every quest's requirements (Quest bucket), the 12 diary pages, the combat achievement list and the item list (`/mapping`). Requirement checks and item lookups then need no wiki requests while the cached copies are fresh.

**Staying within each source's limits** (expected use assumes about 5 accounts, used heavily):

| Source | Published limit | Expected use |
|---|---|---|
| Hiscores | None published | 1 request per account per 15 min |
| Wise Old Man | 20/min, 500/h and 3,000/day per IP, shared with the WOM RuneLite plugin | About 4 requests per account per 15 min, so under 100 an hour |
| TempleOSRS | None published; asks clients to query only what they need | 1 request per account per hour |
| OSRS Wiki API | None found | A few requests per chat question |
| Wiki prices | No explicit limit; asks for bulk requests instead of looping over item ids | At most 1 bulk request per 5 min, plus the item list once a day |

Every request goes through one shared request handler that:
- sends the User-Agent with contact info;
- sends one request at a time per site: Wise Old Man at least 3 seconds apart, the others at least 1 second apart, timed on a clock that only moves forward and including retries;
- pauses Wise Old Man requests when its `RateLimit-Remaining` header runs low, until `RateLimit-Reset`. The headers report whichever window (minute, hour or day) is closest to its limit, so this also covers the WOM plugin's traffic from the same IP;
- retries rate-limit (429) and server (5xx) errors and lost connections up to 3 times, waiting 1, 2, then 4 seconds or as long as `Retry-After` says (in seconds or as a date);
- gives each request 20 seconds, reading the answer included, and doesn't send it again after a timeout (a POST may have arrived), so a hung connection can't hold up every later request to that site;
- never waits more than a minute: a `Retry-After` or a Wise Old Man pause longer than that (its hourly or daily window) fails the request at once, keeping its status, e.g. "too many requests (429). Try again in 20 hours.", instead of holding the queue;
- names the site in every error, e.g. `Wise Old Man: server error (500)`, `Hiscores: no connection`, `OSRS Wiki: no answer within 20 seconds`, and adds the site's own reason when its error answer gives one (Wise Old Man's "Player was updated less than 60 seconds ago"); error answers are read, up to 4 KB, which also frees their connections. A 404 is a separate `NotFoundError`, which sources turn into "isn't on the hiscores" and the like.

It's `createRequester` in `server/src/http/requester.ts`: one promise queue per host, with the clock and `sleep` passed in so tests run instantly.

### What each API offers

Verified against the live APIs on 2026-10-27.

- **Official hiscores (Jagex):** `GET https://secure.runescape.com/m=<table>/index_lite.json?player=<RSN>`
  - Returns `{ name, skills[], activities[] }`. Skills are `{id, name, rank, level, xp}` (25, including Overall and Sailing); activities are `{id, name, rank, score}` (92: bosses, clues, minigames, "Collections Logged"). Unranked entries have `rank: -1`: a skill outside the top two million keeps its real level and XP (checked on 2026-10-28: an account's unranked levels add up to its total level), while an unranked activity's score isn't a count. Unknown player: 404.
  - Tables: `hiscore_oldschool`, `hiscore_oldschool_ironman`, `hiscore_oldschool_hardcore_ironman`, `hiscore_oldschool_ultimate` (plus skiller, fresh start, deadman, seasonal). They nest: every account is on the main table, every iron type is on the ironman table, and a hardcore ironman who died stays on the hardcore table with frozen stats. Telling account types apart means comparing tables.
  - No key, no CORS headers, no published rate limit.
  - In the app (`server/src/sources/hiscores.ts`): `fetchHiscoresText` returns the answer exactly as received, which is what gets stored, but only after checking it parses as hiscores (a maintenance page can arrive with a 200); a 404 becomes "Hiscores: <name> isn't on the hiscores". `fetchHiscores` returns the parsed data, or null for an unknown player. Parsing keeps every skill and activity in the response's order, so a new one appears without a code change. Unranked entries keep `rank: -1`. An unranked skill's level and XP are still used (the combat and total level count them, and the stats tiles show them); only a skill with xp -1 counts as having no level. An unranked activity's score (-1, or 0 for a few newer activities) isn't a count. When an answer doesn't fit, the details go to the server's console. Stats come from the main table, which every account is on.
- **Wise Old Man:** base URL `https://api.wiseoldman.net/v2`
  - `GET /players/:username`: type (regular, ironman, hardcore, ultimate), build, EHP, EHB, time to max, and the latest snapshot (skills, bosses, activities, computed). Also gains for a period or date range (`/gained`), snapshots and timelines, achievements and progress, records, and name changes. `POST /players/:username` updates a player; `POST /players/:username/assert-type` re-checks its type. Players are found by their current name only.
  - `GET /names?username=<name>&status=approved&limit=50` searches name changes by part of a name, matching either the old or the new name, case-insensitively (pages default to 20 results, at most 50). Checked against WOM's documentation on 2026-10-28; it's how a renamed account is found from its old name.
  - Limits per IP: 20/min, 500/h, 3,000/day (an API key from their Discord raises them). Every response has `RateLimit-*` headers, and a 429 has `Retry-After`. They ask for delays between requests, automatic updates no more often than every 1–6 hours, and a User-Agent with contact info (or risk an IP ban).
  - The Wise Old Man RuneLite plugin and RuneLite's built-in XP Updater already update WOM when you log out after gaining XP.
  - In the app (`server/src/sources/wom.ts`): for the kinds that get stored (player, weekly gains, achievements) a text fetcher returns the answer exactly as received after checking it parses (when an answer doesn't fit, the details go to the server's console); a 404 becomes "Wise Old Man: <name> isn't tracked", and `getPlayer` returns null instead. The parse functions are exported so stored answers can be read back. A player type Wise Old Man adds later reads as `unknown`, and a player it has never updated has no boss kills (an unranked boss has kills 0 and rank -1). Gains have no start or end when Wise Old Man has no data for the period; a date range is checked before asking and sent as full ISO times. Name changes come from the name-change search, keeping only approved changes of exactly that name (old or new), newest first. Efficiency rates keep `realRate`: where a method trains two skills, `rate` is this skill's share and `realRate` the XP per hour it really gives. `updatePlayer` (a POST, answered with the updated player) asks Wise Old Man to update a player: on Refresh only when `canRequestUpdate` says the player's data is over an hour old, and never for a player Wise Old Man doesn't track, since an update would start tracking them; starting to track is offered when adding an account. Efficiency rates follow the account type: regular uses `main`, ultimate `ultimate`, every other iron type `ironman`.
- **TempleOSRS:** `https://templeosrs.com/api/...`
  - `collection-log/player_collection_log.php?player=<RSN>&categories=all` returns every logged item with count and date obtained, plus totals, last sync times, EHC and hiscores rank. Items only arrive once synced by the Temple OSRS RuneLite plugin (a sync button in the collection log, plus optional automatic sync of new items without counts). RuneLite's XP Updater can update Temple stats on logout.
  - No published rate limit; they ask clients to query only what they need.
- **OSRS Wiki:** `https://oldschool.runescape.wiki/api.php`
  - Search (`action=query&list=search`) and page sections and content (`action=parse`).
  - Structured data through the Bucket extension (`action=bucket&query=bucket('quest').select(...).where(...).run()`), 51 tables including: Quest (requirements with skill levels, "not boostable" and "required to start" flags, the full prerequisite quest tree, and other requirements as text), Combat achievement (id, name, tier, monster), Infobox bonuses (equipment stats), Recommended equipment, Dropsline, Money making guide, and item and monster infoboxes.
  - Content is CC BY-NC-SA 3.0, so answers link the source page.
- **OSRS Wiki prices:** v2 at `https://prices.runescape.wiki/api/v2/osrs/` (v1 still works but may be removed). `/latest` (all items, about 340 KB, or one item with `?id=`), `/mapping` (names, ids, GE limits, alch values; about 870 KB), `/5m` and `/1h` (averages can have two decimals), and `/timeseries?id=&lookback=` with `24h`, `7d`, `6m` or `1y`. Prices can exceed 2,147,483,647, so they're stored as 64-bit integers.
- **Both wiki APIs reject generic User-Agents** (a `python-requests` one got 403), so every request sends a descriptive User-Agent with contact info.
- **WikiSync** (not used for now): `https://sync.runescape.wiki/runelite/player/<RSN>/STANDARD` returns quests, diaries with per-task detail, combat achievement ids, collection log item ids, levels and music tracks. Anyone can read it by name, and it needs the WikiSync plugin.

## RuneLite data (Character Export)

The hiscores don't include quests, achievement diaries, combat achievements, bank, inventory or worn gear. These come from [Character Export](https://github.com/DZWNK/Character-Export), a Plugin Hub plugin (installed the normal way; BSD 2-Clause) that writes JSON files per account to `.runelite/character-exporter/<Character Name>/`. It has no network code. The backend reads the files from the RuneLite folder: `~/.runelite` on every OS, or `/mnt/c/Users/<user>/.runelite` when the app runs in WSL and RuneLite runs on Windows.

| File | Updated when | Contents |
|---|---|---|
| `character.json` | Login, stat change | Skills (level, boosted level, XP), world, player name |
| `quests.json` | Login, quest change | Every quest's state (not started / in progress / finished) |
| `diaries.json` | Login, change, diary journal opened | 12 areas × 4 tiers: completion, tasks done, named tasks |
| `combat_achievements.json` | Login, change | Every combat achievement task by name with completion, by tier |
| `collection_log.json` | A collection log entry is viewed | Items from the entries viewed so far |
| `bank.json` / `seed_vault.json` | Bank / seed vault opened | Full contents with item names |
| `inventory.json` / `equipment.json` | They change, or Sync Available is pressed in the plugin's side panel | Carried / worn items |

- **Formats** (checked against real files, v0.6.0): `stats` keyed by skill name; quest `state` is `FINISHED`, `IN_PROGRESS` or `NOT_STARTED`; diary and combat achievement tiers are keyed in lowercase (`easy` … `grandmaster`); container files list `items` with `slot`, `id`, `quantity`, `name`; `exported_at` carries a UTC offset and up to 9 fractional digits. Full field list in `PLAN.md` → Task 17.
- **Gaps:** named diary tasks need each area's diary journal opened once (completion and task counts are always there). Later exports can drop those names (seen after re-logging: only Karamja kept them), so the app keeps, per area and tier, the most recent names it has seen in its snapshots, shows when they're from, and flags them as stale once the tier's task count has changed since; reopening that journal refreshes them. `seed_vault.json` uses the bank's format (from the plugin's source; not yet seen on a real account). The collection log only covers entries opened in game, so the app takes the collection log from TempleOSRS instead and ignores `collection_log.json`. The bank and seed vault are only as fresh as the last time they were opened.
- **When the files are read:** a setting, changed in the app's settings page and stored in its database, picks the mode:
  - **Automatic:** while an account is open in the browser, the page asks the server to check every few seconds (interval configurable), so the dashboard updates as you play. Nothing runs when no page is open.
  - **Manual:** files are only read when you press Refresh.

  In both modes, a chat message checks the files before the AI reads account data, so answers never use older data than what's on disk (the AI may see newer data than the dashboard until you refresh). Every check compares modified times and re-reads only files that changed; there are no file watchers. The Refresh button exists in both modes. The setting covers Character Export's local files only; online sources are never polled this way (rate limits).
- **Reading the files:** the plugin overwrites files in place, so a read can catch one half-written: retry when JSON fails to parse. The format belongs to a third party (reviewed at v0.6.0, commit `0386dcc`), so store raw file contents in snapshots and parse defensively.
- **If it breaks or is abandoned:** take it over as our own plugin (about 3,500 lines, BSD 2-Clause), or use Bank Bridge for bank, inventory and gear.
- **Alternatives considered:**
  - OSRS Companion (the original choice) writes no local files; it uploads everything to a third-party website.
  - WikiSync covers quests, diaries, combat achievements and the collection log, but makes them public by name and has no bank.
  - Persistent Bank was disabled on the Plugin Hub as unmaintained.
  - Bank Bridge serves data over a local WebSocket only while RuneLite runs, and only knows whole diary and combat achievement tiers.
  - Our own plugin: RuneLite only loads plugins that aren't on the Plugin Hub in developer mode, which is off whenever a launcher starts the client, so it would mean playing on a developer build or publishing it.

## Database

| Table | Holds |
|---|---|
| `accounts` | Name as shown in game, a matching key, account type (and whether it came from Wise Old Man or was set by hand), notes, when it was added |
| `source_state` | The latest data per account and data type (hiscores, WOM player, WOM weekly gains, Temple collection log, each Character Export file, ...): raw data, a content hash, when it was fetched, and the file's modified time for Character Export. Reads and freshness limits use this table. A fetch that brings the same data still moves `fetched_at` on; a successful fetch clears any error; a failed one keeps the last good data and notes the error and when (a source never fetched has nothing to note). |
| `snapshots` | History: a copy is added whenever the data changed (see retention below). Whether it changed is decided by a SHA-256, inside one transaction with the save: of the data, or of a text the source gives to compare, so Character Export's export time and reason, which change on every write, don't count as changes. A file's snapshot is dated by when the file was written, not when the app read it. |
| `cache` | Shared data not tied to an account: wiki pages (with revision id), Bucket results, search results, GE prices, the item list |
| `goals` | Account, title, kind, target (JSON), status (active, done, dropped), position in the user's order, created, completed and dropped times (details in Goals) |
| `chat_sessions`, `chat_messages` | Conversations per account, stored in a provider-neutral format (details in AI layer) |
| `settings` | Settings changed in the app (RuneLite update mode and interval, time zone, ...), one row per setting with its value as JSON; a saved value that's no longer valid, or a key that's gone, falls back to the default. Secrets and paths stay in `.env`. |

**History retention:**
- Stats and progress (hiscores, Wise Old Man player, Temple collection log, quests, diaries, combat achievements): every change.
- Bank and seed vault: at most one per day (the day's last version), enough for a bank value chart.
- The character file (levels and XP from Character Export): at most one per day too. The plugin rewrites it every few seconds while you play, and the hiscores and Wise Old Man already keep the stats history.
- Inventory and worn gear: latest only; they change constantly while playing.
- Wise Old Man gains and achievements: latest only; Wise Old Man keeps that history.

**Conventions:**
- **Names** match ignoring case, with spaces, underscores, hyphens and non-breaking spaces treated as the same (Wise Old Man's rule). A name sent to the app must be an OSRS name: 1 to 12 letters, numbers, spaces, hyphens or underscores (a pasted non-breaking space counts as a space). The matching key is also how the app finds each account's Character Export folder. A renamed account is updated in the app and keeps its history.
- **Times** are stored as ISO 8601 text in UTC and always shown in the configured time zone. The time zone setting is either Automatic (the browser's time zone, which the page reports to the server) or a zone picked from a list. Day-based rules, such as one bank snapshot per day, use that zone, and the AI is given the current local date, time and zone. A saved zone this browser or server doesn't know (picked in another browser, say) counts as UTC rather than breaking the settings. Times are written in US English, like the rest of the interface (Oct 27, 2026, 5:00 PM); recent ones read "just now", "5 minutes ago", "3 hours ago", then by calendar day "yesterday" and "3 days ago", and after a week the date.
- **Deleting an account** deletes all its data, after confirmation. Foreign keys are on.
- **The file** is `wise-old-model.db` in the data folder. If it can't be opened (or migrated), the server stops with the reason.
- **Migrations** run automatically at startup; they live in code (`server/src/db/migrations.ts`) and run in name order. All pending migrations run as one transaction (`BEGIN IMMEDIATE`, which also keeps a second process out), so one that fails partway leaves nothing behind. Foreign keys are off while they run, as SQLite's guide to changing a table requires (otherwise rebuilding a table deletes every row pointing at it), and a foreign key check runs before committing; a migration that would leave rows pointing at missing rows is undone. A clock that went backwards between migrations doesn't block startup.
- **Write-ahead logging** is on (safe because the database lives on a local drive), and a write waits up to 5 seconds for a lock instead of failing at once.
- **Backups** are automatic: at startup when the newest backup is over a day old, and always right before a migration runs on an existing database. Each is a full copy made with SQLite's `VACUUM INTO` (safe while the app runs) into `backups/` in the data folder, named by UTC time without colons so Windows accepts it (`wom-2026-10-27T120000Z.db`); the newest 7 are kept. A backup named in the future (made while the clock was ahead) doesn't count as the newest. If the daily backup can't be made, the server warns and starts anyway; an old backup that can't be deleted (Windows refuses while another program has it open) is tried again next time. The backup before a migration must succeed, or nothing is migrated.

## Goals

Goals belong to one account. Progress is computed from the account's data, never stored.

| Kind | Target | Progress shown |
|---|---|---|
| Skill | A level or an XP amount | Progress bar, XP to go, hours at Wise Old Man's efficient rates |
| Quest | Complete a quest | What's still needed, from the same requirement check the AI uses |
| Diary | Complete an area's tier | What's still needed |
| Combat achievements | A task, or a whole tier | Done or not; points toward the tier |
| Boss kills | A kill count | Current kill count |
| Collection log | An item, or a whole entry | Obtained or not; items in the entry |
| Item | Own an item | Where it is, from bank, inventory and gear |
| Custom | Free text | None; ticked off by hand |

- **Completing:** a goal completes itself when the data shows it reached; it moves to Done with the date and appears in This week. It can be reopened. Custom goals are ticked off by hand.
- **Dropping:** a dropped goal is hidden but kept.
- **Order:** active goals are in the user's order (drag to reorder). The AI reads that order as priorities for "what should I work on next?"
- **The AI:** it can suggest goals and add or update them, each after the user approves (e.g. offering 75 Magic and Dream Mentor as goals after "Can I do Dragon Slayer II?").
- **Page:** Add goal and Suggest goals buttons; active goals with progress (quest and diary goals list what's still needed, with an "Ask the AI for a plan" link); a Done list with dates. Suggest goals posts a request into the chat ("Suggest a few goals for <account> based on my progress and current goals"); each suggestion the AI adds comes up as Approve / Decline.
- No target dates (left out to keep goals simple).

## AI layer

- The LLM sits behind a provider interface so the provider can be swapped.
- **Claude runs through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)** (`@anthropic-ai/claude-agent-sdk`), which runs Claude Code inside the app, so usage can bill to the user's Claude Max plan. A billing setting picks the credential: **Plan** (default; Claude Code's own sign-in, and `ANTHROPIC_API_KEY` is removed from the Claude Code process's environment) or **API key** (pay per use, with an optional spending cap).
  - Anthropic's Claude Code legal page: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." It forbids apps offering Claude.ai sign-in, routing other people's requests through plan credentials, and collecting, storing or intermediating Claude.ai credentials or session tokens. So the app never reads, copies or stores the Claude sign-in; Claude Code handles it (`claude` → `/login`, once per machine).
  - The SDK installs a per-OS Claude Code binary as an optional dependency, like Vite's build tools.
- **Provider interface:** one user turn at a time (a message in; streamed text, tool activity and usage out). The provider runs the tool loop. Tools are defined once in a provider-neutral form (name, description, Zod input schema, handler, read-only flag).
- **Agent SDK setup:**
  - Our tools are an in-process MCP server (`createSdkMcpServer`), pre-approved with `allowedTools: ["mcp__osrs__*"]`, with schemas always loaded (`alwaysLoad`) instead of deferred to tool search.
  - `tools: []` removes every built-in tool (no files, shell or web). A custom `systemPrompt` replaces Claude Code's. `settingSources: []` keeps the user's Claude Code settings, `CLAUDE.md`, plugins, hooks and skills out.
  - `cwd` is a folder in the data directory, so these sessions stay out of the user's coding projects. Each chat stores its Claude session id and resumes it on the next message (`resume`); Claude Code compacts long chats itself.
- **Defaults:** `claude-opus-5-5`, effort `medium`, at most 20 tool rounds per question (`maxTurns`). All three are settings.
- **Streaming:** text deltas (`includePartialMessages`) reach the browser over SSE; tool calls show as status lines ("Checking your quests…", "Reading wiki: Dragon Slayer II"); Stop cancels the turn.
- **Writes need approval:** tools that change data (adding or completing goals) use the SDK's `always_ask` permission policy, and `canUseTool` relays the request to the chat as Approve / Decline. Read-only tools are marked `readOnlyHint` so they can run in parallel.
- **Sources:** the server records every wiki page a tool returned during the turn and lists them under the answer, in addition to links the model writes.
- **Context:** one chat per account. The account's name and type are in the system prompt; each message carries the local date, time and time zone.
- **Stored:** chats and messages as shown in the UI (messages, answers, tool activity, sources, usage: tokens on the plan, plus cost with an API key). Claude Code keeps its own transcript for the model's context.
- The model gets account and game knowledge only through tools. Calculations (XP remaining, time estimates, requirement checks, costs) happen in code; the model only interprets the results.
- **Privacy:** everything a tool returns (account names, stats, bank contents) is sent to the AI provider. That's accepted for this project, but nothing else from the machine is sent.

### Instructions

The system prompt (stable for the whole chat, so Claude's prompt cache holds; the Agent SDK caches prompts automatically) tells the model:

1. **Role:** an Old School RuneScape advisor for one account: its name, its type, and that it's the user's own account.
2. **Facts about the account come from tools.** Never guess stats, quests, bank or gear. When data is missing or stale, say so and say how to fix it ("open your bank in game so Character Export saves it").
3. **Respect the account type:** ironmen can't trade or use the Grand Exchange, group ironmen trade only within their group, ultimate ironmen have no bank, and hardcore ironmen get risk warnings for dangerous content.
4. **Numbers come from the calculation tools** (XP, time estimates, requirements, costs), not mental math.
5. **Always check the wiki:** every specific game fact (requirements, stats, drop rates, locations, methods, XP rates) comes from a wiki page read in this chat and is cited. General strategy can come from the model's own knowledge, but the concrete claims behind it are looked up. Every lookup goes through the app's cache.
6. **Ask before guessing** when a request is ambiguous ("best gear upgrade" for which boss or style?).
7. **Decline** botting, macros, real-world trading, account selling or sharing, bug abuse and unapproved third-party clients.
8. **Style:** practical and concise, answer first, lists for steps, times in the user's time zone.
9. **Goals:** it may suggest goals and add them only after the user approves.

### Tools

**Account (read-only):**

| Tool | Returns |
|---|---|
| `get_account_overview` | Type, combat level, every skill's level and XP, EHP/EHB and time to max, quest points, diary and combat achievement summaries, collection log total, plus each source's freshness and what's missing (e.g. "no bank data yet: open your bank in game") |
| `get_boss_kills` | Non-zero boss kill counts, clue counts and minigame scores |
| `get_quests` | Quests, filterable by status or name |
| `get_diaries` | Per area and tier: complete or not, tasks done, task names when known |
| `get_combat_achievements` | Tasks with completion, filterable by tier, status or name |
| `get_collection_log` | Temple data by category: obtained and missing items, counts, dates |
| `get_gains` | For a day, week, month or date range: Wise Old Man XP and kill gains, plus quests, diaries, combat achievements and collection log items gained (from our snapshots and Temple's dates) |
| `get_bank` | Total value, most valuable items and when the bank was last seen; or a search across bank, seed vault, inventory and worn gear ("do I own X, and where?") |
| `get_gear` | Worn gear by slot with stats, plus inventory |

**Calculations (in code):**

| Tool | Returns |
|---|---|
| `check_quest_requirements` | Met or unmet for each skill (noting which are boostable), each prerequisite quest in the tree, and quest points, from the wiki's Quest bucket. Requirements code can't check are listed separately with the wiki link. |
| `check_diary_requirements` | The same for a diary area and tier, parsed from the wiki's diary page tables (Task / Requirements columns with `{{SCP}}` templates and quest links) |
| `calc_xp` | XP to a target level or XP, plus hours at Wise Old Man's efficient rates for the account type (`GET /efficiency/rates?metric=ehp&type=<type>`: per skill, rate by XP bracket with a method description) |
| `find_gear_upgrades` | For a boss or activity: the wiki's recommended equipment per slot against what the account owns, with GE prices and an optional budget. For ironmen, items aren't buyable; it points to how to obtain them. |

**Game knowledge (read-only):**

| Tool | Returns |
|---|---|
| `search_wiki` | Top page titles and snippets |
| `get_wiki_page` | A page's section list, or one section as clean text, with its URL |
| `get_item_info` | Stats, GE price and buy limit, members flag and drop sources for named items |
| `get_prices` | Current GE prices for named items |

**Goals:**

| Tool | Returns |
|---|---|
| `list_goals` | Goals with progress computed from the account's data |
| `add_goal`, `update_goal` | Change goals; each needs the user's Approve in the chat |

**Rules for every tool:** small, filtered results (never a whole bank or a whole wiki page); an "as of" time on every result; say when data is missing or stale; loose item-name matching ("dragon scim" finds Dragon scimitar). Everything a tool returns is sent to the AI provider.

## Frontend

A chat-first React app for one account at a time, with data pages beside the chat.

- **Layout:** three columns, built for a second monitor to the right of the user. Left to right:
  1. **Chat**, the main feature, about half the width. Its header has New chat and Earlier chats for the selected account.
  2. **The selected page**: Overview by default (a compact stats summary), or This week, Goals, Bank and gear, Collection log, Settings.
  3. **The menu** on the right edge: accounts (plus Add account) and pages, next to the page it controls.

  Picking an account switches both the chat and the page. The columns take about 54%, 30% and 16% of the width. Below 1000 px, the page and menu collapse behind a menu button (a hamburger, named "Menu" for screen readers) in a bar above the chat, so the chat keeps the screen; the panel opens over the chat's right side, closes with Escape, and keeps what's in it (scroll, searches, typing) while closed.
- **URLs:** each page has its own, `/<account id>/<page>` (`overview`, `this-week`, `goals`, `bank`, `collection-log`, `settings`). An unknown page opens the account's overview, `/<account id>` opens the overview, and any other path goes to `/`, which opens the first account or, until one exists, shows the add-account form (and, once it has asked, stays until the person is done adding, so a problem along the way can be read). An account page waits for the account list, and an account that isn't in it goes to `/`.
- **Menu:** the accounts, each linking to the page being viewed, then Add account (the add-account form in a modal `<dialog>`), then the open account's pages.
- **Pages** (in the page panel):
  - **Overview:** name, type, combat and total level; the stats tiles; progress rows (quests, diary tiers, combat achievements, collection log) with icons; the top kill counts with boss icons, expandable to all of them; worn gear; data freshness and Refresh. Built so far (progress rows and worn gear come with Character Export): opening it fetches the hiscores and Wise Old Man's player when they're past their freshness limits. An unranked skill's level (and an unranked total) shows as a dash, since the hiscores don't say it. A reload that fails keeps what was shown and says it failed, and switching accounts starts the page afresh. Kill counts are the hiscores' activities that are bosses, told apart by Wise Old Man's boss metrics (`isBoss`: letters and digits compared, a trailing "mode" ignored, so "Tombs of Amascut: Expert Mode" is `tombs_of_amascut_expert`); the metrics are the same for every player, so an account Wise Old Man doesn't track uses another account's saved answer, and with none saved anywhere the page says how to get them (the overview's `missing`). The five highest show, most first, with a button for all of them. Sources lists when each was fetched and, when the last try failed, why; when the hiscores don't know the name, the page says Refresh checks Wise Old Man for a name change, and a suggested rename is offered there (renaming, then refreshing under the new name).
  - **This week:** period picker (Today, 7 days, 30 days, Custom); a one-line summary; XP per skill with level-ups; kills and clues; quests, diaries, combat achievements and goals completed, dated; new collection log items with icons.
  - **Bank and gear:** bank value and when the bank was last seen (ironmen get a "for reference" note); one search across bank, inventory and gear; worn gear laid out like the in-game equipment screen; the 28-slot inventory; the most valuable bank items; links to the whole bank and the seed vault.
  - **Goals:** see Goals below.
  - **Collection log:** totals and Temple's last sync time; tabs like the in-game log (Bosses, Raids, Clues, Minigames, Other); entry list (complete entries in green) and the selected entry's item grid (missing items greyed, counts on obtained items, first-obtained date on selection).
- **Settings page:**
  - **Accounts:** name; type (marked as from Wise Old Man or set by hand); whether the Character Export folder was found; whether Temple has the collection log; Rename; Delete (confirmed, removes all the account's data).
  - **Game data:** the RuneLite folder in use and whether it was found; update mode (Automatic or Manual) and checking interval (default 5 seconds).
  - **AI:** billing (plan or API key), model (default Claude Opus 5.5), effort (default medium), maximum tool rounds per question (default 20), optional spending cap per question (API key only).
  - **Display:** theme (default dark), time zone (Automatic, showing the zone the browser reported, or picked from UTC and every zone the browser knows).
  - **About:** data folder location, last backup and Back up now, the `.env` settings read-only (the API key shows only set or not set), and credits: "Game images © Jagex Ltd.", the wiki's CC BY-NC-SA 3.0 license, and the data sources.
- **Adding an account:**
  1. Type the name.
  2. The app looks it up on the hiscores and Wise Old Man and shows combat and total level and the type Wise Old Man reports; the type can be changed (group ironman types are set by hand), and it counts as from Wise Old Man only when it matches Wise Old Man's. If Wise Old Man doesn't track the name yet, it offers to start tracking it; tracking starts only when the person says yes. A source that couldn't be checked is named, rather than the name being called unknown.
  3. It checks for the Character Export folder: when it was last written, or what to do (log in to the account with the plugin on, then open the bank and each diary journal once).
  4. It checks whether Temple has the collection log, or shows how to sync it.
  5. Save: the account appears in the menu and its overview opens, which runs the first fetch. If tracking was asked for and didn't start, that's said first, with a button to open the account.

  Built as `AddAccountForm` (`client/src/components/AddAccountDialog.tsx`): a name that can't be an OSRS name is refused before any request; changing the name after a lookup clears it, so only a looked-up name can be added; the account is added under the name the lookup gives (Wise Old Man's display name when it tracks the player, since the hiscores echo the name as asked). Until Character Export and Temple are read (Phase 3), steps 3 and 4 always show what to do.
- **Name changes:** when an account's name stops resolving on the hiscores, Refresh checks Wise Old Man's name changes and offers to rename the account; its history stays attached. It suggests the newest change involving the name, only when that change is away from the name and came after the hiscores last found it (or, if they never did, after the account was added): an older change is a previous owner's, or was undone. The check is made at most once a minute per account and name.
- **Chat column:**
  - Header: account name, New chat, Earlier chats (this account's chats, newest first; titled from the first message, no extra AI call; rename and delete).
  - Tool activity collapses to one line ("Looked at 4 things") that expands to each lookup, with game icons.
  - Answers in the serif. Write tools appear as Approve / Decline rows, one per proposed change; while one is waiting, the input says so and Stop stays available.
  - Under each answer: sources on the left; tokens used on the right ("on your plan", or a cost with an API key).
  - A new chat shows a short prompt and starter questions ("What should I work on next?", "What did I get done this week?", "Can I do a quest yet?", "Best gear upgrade for a boss").
  - Setup problems explain the fix in place, e.g. when Claude Code isn't signed in: run `claude`, then `/login`, or switch billing to an API key in Settings.
- **Stack:** React 19 and Vite 8, TanStack Query for server data (and its browser-side cache), React Router for pages, Zod to validate API responses. Requests go out even while the browser reports being offline (the server is on the same machine), and a request the server refused (4xx) isn't retried; others are retried twice. `main.tsx` makes the router and the query client once, outside React. Each query is keyed by its API path's segments (`apiQuery('/api/accounts/1/overview', schema)` → `['api', 'accounts', '1', 'overview']`), so one prefix refreshes everything under it.
- **Styling:** plain CSS with no component library. CSS Modules per component, plus global CSS custom properties as theme tokens. Native elements cover tables, dialogs (`<dialog>`) and form controls; charts are small hand-written SVG components.
- **Themes:** light and dark, defaulting to dark; the choice is a setting, applied to `<html data-theme>`. The browser also keeps the last choice (localStorage), so `index.html` applies it before the app loads and a light page doesn't flash dark.
- **Visual direction, "Stone and lantern":** the game's own interface, refined.
  - Dark theme (default): background `#1f1c17`, panel `#28231c`, raised `#393227`, rules `#4a4134`, text `#ebe1ca`, muted text `#a89a80`, accent `#ff981f` (the game's orange text).
  - Light theme (parchment): background `#e4d8b9`, panel `#dacdab`, raised `#cdbd94`, rules `#a8956b`, text `#2b2116`, muted text `#6b5a40`, accent `#8f4300` (a darker amber, so links pass contrast on parchment).
  - Type: Alegreya (serif) for chat answers and headings, Alegreya Sans for the interface, Silkscreen (pixel) only for skill levels. Fonts are bundled with the app (Fontsource packages, SIL Open Font License), not loaded from Google at runtime.
  - The one loud element: stats tiles styled like the in-game stats tab. Each tile shows the skill icon, the skill name and the level, in the in-game tab's order (Sailing last; a skill the layout doesn't know yet is appended, since the skill list comes from the hiscores response).
    - Dark: stone tiles (`#393227`, frame `#1f1c17`), names `#cfc3a8`, levels yellow `#ffff00` in the pixel font with a black shadow.
    - Light: parchment tiles (`#ebe2cb`, frame `#cdbd94`), names `#3d3122`, levels dark amber `#7a3a00` with a light shadow.
  - Status colors follow the in-game quest list: red not started, yellow in progress, green done. Dark: `#e5654f`, `#e9d44b`, `#3fbf4f`; light: `#9e2f1c`, `#6b5400`, `#25622a`. Each passes 4.5:1 contrast on the background and panels, so status can color text.
  - Avoid generic template chrome: no all-caps labels, no middle-dot meta strings, no arrows appended to buttons.
- **Game icons:** skill, boss, quest, diary, combat achievement and collection log icons come from OSRS Wiki images (`https://oldschool.runescape.wiki/images/<File>.png`, e.g. `Attack_icon.png`, `Vorkath_icon.png`); item icons come from RuneLite's icon server by item id (`https://static.runelite.net/cache/item/icon/<id>.png`), which also covers untradeable items. The server downloads each icon on first use and keeps it in the data folder (`icons/wiki/`, `icons/item/`), serving it at `/api/icons/wiki/<file>` or `/api/icons/item/<id>` with `Cache-Control: public, max-age=31536000, immutable`. Only plain file names (letters, digits and `_().'%-`, ending `.png`) and numeric ids are accepted, so nothing can reach outside the folder. A file is written whole or not at all, and two pages asking for one icon share a fetch. An answer that isn't a PNG (a challenge page sent with a 200, say) is a failure. An icon the site doesn't have answers 404 with nothing written, isn't asked for again while the server runs, and the browser may keep that 404 for a day; any other failure answers 502, and that site isn't asked for any icon for a minute, so a page full of icons can't hold up the wiki's queue (which the chat's lookups share) during an outage. An icon that can't be written to disk is still served. The wiki file for a skill or boss is its name with spaces as underscores plus `_icon.png`, a colon turned into a hyphen as the wiki does; nine hiscores names whose icons the wiki names otherwise are listed (`Kree'Arra` → `Kree'arra_icon.png`, `Nightmare` → `The_Nightmare_icon.png`, ...). That's `wikiIconFile` in shared, with `WIKI_ICON_FILE`, the file-name pattern the server accepts. Checked against the wiki on 2026-10-27: all 24 skills and 62 of the 72 bosses have icons; the other ten (Chambers of Xeric, both Theatres of Blood, both Gauntlets, Phosani's Nightmare, Lunar Chests, Artio, Spindel, Calvar'ion) have none, so `<Icon>` leaves a blank of the icon's size, as it does for any icon that fails to load. The client shows them with `<Icon>`, pixel art kept sharp. Icons are Jagex's copyright ("used with permission" on the wiki), so they are never committed to the repo, and Settings credits "Game images © Jagex Ltd."

## Configuration

Settings that rarely change, and secrets, live in `.env` in the repo root, which is git-ignored. The committed `.env.example` lists every variable with its default and a one-line comment; copy it to `.env` to start. Everything else is a setting in the app.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CONTACT` | Yes | (none) | Discord name or email, sent in the User-Agent (`wise-old-model/<version> (personal use; contact: davisparkergoff@gmail.com)`) so Wise Old Man, Temple and the wiki can reach the user. Plain ASCII only, since it goes in an HTTP header |
| `PORT` | No | `4747` | Port the server listens on |
| `DATA_DIR` | No | The OS's app-data folder | Database, backups, icons and the Agent SDK's working folder |
| `RUNELITE_DIR` | No | `~/.runelite` | Where to find Character Export's files |
| `ANTHROPIC_API_KEY` | No | (none) | Only used when billing is set to API key |

The server checks these at startup and stops with a clear message when one is missing or invalid.

## Repo and tooling

- **npm workspaces:** `server/`, `client/` and `shared/` (the API's Zod schemas and types, used by both sides). `"engines": { "node": ">=26" }`.
- **Server:** Node 26 runs its TypeScript directly (built-in type stripping, no build step and no extra runner): `node --env-file-if-exists=.env server/src/main.ts`. In development `server/src/dev.ts` runs that and starts it again, once the old one has exited, whenever the server's or the shared code changes (tests excepted); it compares the files' modified times once a second, because Node's own `--watch` relies on file-change events, which a WSL checkout on a Windows drive never gets. Vite checks the client's files the same way (`server.watch.usePolling` in `client/vite.config.ts`), so a code change needs only a page reload. This allows only erasable TypeScript syntax (no enums, namespaces or parameter properties), so `tsconfig` sets `erasableSyntaxOnly` and `verbatimModuleSyntax`, and relative imports use `.ts` extensions.
- **Type checking:** TypeScript 7 (the native compiler) with `noEmit`; it never produces output.
- **Client:** in development the Vite dev server (port 5173) forwards `/api` to the server at `PORT` (read the way the server reads it: the environment, then the root `.env`). The proxy keeps the browser's `Host` (`changeOrigin: false`) so the local-only check still sees it, and Vite's CORS is off so pages on other localhost ports can't read API answers. In production `vite build` produces static files the server hosts, so the app is one process at one URL.
- **Lint and format:** Biome, one tool for both. It skips `server/test/fixtures`, so captured responses stay exactly as received. (ESLint's TypeScript plugin supports TypeScript only up to 6.0.)
- **Scripts:** `npm run dev` (server and Vite together, via `concurrently`), `npm run dev:server` and `npm run dev:client` (each alone), `npm run build` (the client), `npm start` (the app), `npm test`, `npm run typecheck`, `npm run lint`, and `npm run check` (type check, lint and tests; run before committing). A single test file: `npx vitest run <path>`.
- **Shared package:** `@wom/shared` exports only `shared/src/index.ts`, which re-exports every shared module.
- **Tests (Vitest 5):**
  - Unit: each source's parser (hiscores, Wise Old Man, Temple, Character Export, the wiki's requirement tables); every calculation (XP, requirements, gear upgrades, goal progress); the request handler's queues, rate limits and retries, with fake timers.
  - Integration: API routes against a temporary database (`testDb()`: in memory unless a test passes a file, with every migration applied, closed when the test finishes); the chat flow with a fake AI provider. Tests never call Claude.
  - Temporary folders: a test that needs one gets a fresh folder from `tempDir()` (`server/test/helpers.ts`), deleted when the test finishes, so tests never share leftovers and a full run leaves nothing behind.
  - Fixtures: real responses captured once from the public APIs. Character Export samples come from real files, trimmed and renamed so no real names or bank contents are committed.
  - Frontend: component tests only where there's logic (stream rendering, approvals, goal progress); no browser end-to-end tests. They fake the API with `client/src/test/fakeApi.ts`, where a request the fake doesn't serve fails the test, and use the app's own query client without retries. The test setup gives jsdom a `matchMedia` that reports a wide window. Tests with no DOM run in the node environment.
  - Vitest puts spies, stubbed globals and stubbed environment variables back before every test (`restoreMocks`, `unstubGlobals`, `unstubEnvs`), so tests don't undo them by hand.
- **Repo files:** `.gitignore` (`node_modules`, build output, coverage, `.env` and any `.env.*` except `.env.example`, `.superpowers/`, npm debug logs, `.DS_Store` and `Thumbs.db`); `.env.example`; `.gitattributes` forcing LF line endings so WSL and Windows agree.
- No CI and no git hooks: the user commits by hand.
