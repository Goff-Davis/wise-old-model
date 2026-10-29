# Server architecture

The backend: an Express 5 app on Node 26 that talks to every outside site, reads RuneLite's files, keeps everything in SQLite, works out what each page shows, and runs the chat. See the [root ARCHITECTURE.md](../ARCHITECTURE.md) for how it fits with the client.

TypeScript runs directly on Node (type stripping, no build step), so the code uses only erasable syntax (no enums, namespaces or parameter properties) and relative imports end in `.ts`. TypeScript 7 only type-checks.

## Layers

```mermaid
flowchart TB
  routes["routes/<br/>thin Express routers: parse input, call a service"]
  services["services/ and goals/<br/>page data, accounts, freshness, goal progress"]
  ai["ai/<br/>chat service, Claude provider, tools, instructions"]
  calc["calc/ and items/<br/>requirement checks, gear, XP estimates, item matching"]
  sources["sources/<br/>one module per outside source"]
  store["store/ and db/<br/>SQLite through Kysely: saved data, snapshots, cache"]
  http["http/<br/>local-only guard, errors, shared outbound requester"]
  routes --> services
  routes --> ai
  ai --> services
  ai --> calc
  services --> calc
  services --> sources
  calc --> sources
  sources --> store
  services --> store
  sources --> http
```

| Folder | What's in it |
|---|---|
| `main.ts`, `start.ts`, `app.ts`, `config.ts`, `dev.ts`, `watch.ts` | Entry point, startup, the Express app, `.env` handling, and the development restarter |
| `http/` | `localOnly.ts` (the request guard), `errors.ts` (JSON errors), `listen.ts`, `requester.ts` (every outbound request) |
| `sources/` | `hiscores.ts`, `wom.ts`, `temple.ts`, `wiki.ts`, `prices.ts`, `icons.ts`, `characterExport.ts` (+ its schemas), and `answers.ts` (fetch-and-check helpers they share) |
| `store/` | `sourceState.ts` (each account's latest data and its history), `cache.ts` (shared data such as wiki pages and prices) |
| `db/` | `open.ts`, `migrations.ts`, `schema.ts`, `backup.ts`, and `nodeSqliteDialect.ts` (Kysely over `node:sqlite`) |
| `services/` | `freshness.ts` (when to fetch), `accounts.ts` (lookup, add, rename, delete, refresh), `overview.ts`, `bank.ts`, `gains.ts`, `collectionLog.ts`, `itemInfo.ts`, `accountData.ts` (everything saved for an account, for goals and the AI) |
| `calc/` | `requirements.ts` (quest and diary checks, quest points), `gear.ts` (recommended gear and upgrades), `estimates.ts` (hours to a target XP), `combatAchievements.ts` |
| `items/` | `itemIndex.ts` (loose name search), `itemNames.ts` (name keys, owned-item matching), `itemStats.ts` (equipment stats from the wiki) |
| `goals/` | `progress.ts` (how far a goal is), `goalsService.ts` (the Goals page, adding, changing, ordering, completing) |
| `ai/` | `provider.ts` (the interface), `claudeProvider.ts`, `fakeProvider.ts` (tests), `chatService.ts`, `instructions.ts`, `tools/` |
| `routes/` | `accounts.ts`, `goals.ts`, `chats.ts`, `settings.ts` (with About and backups), `icons.ts` |
| `settings/` | `settingsRepo.ts`: settings stored one row each |
| `../test/helpers.ts` | Test helpers: temp folders, test configs and databases, a real HTTP `call`, fake requesters, fixtures |

## Startup and the HTTP layer

```mermaid
sequenceDiagram
  participant M as main.ts
  participant St as start.ts
  participant DB as db/open.ts
  participant A as app.ts
  M->>M: loadConfig(.env) — stops with a clear message if invalid
  M->>St: startServer(config, { Claude provider })
  St->>St: claim 127.0.0.1:PORT first (a second copy stops here)
  Note over St: answers 503 "starting" meanwhile
  St->>DB: open, back up if due, migrate
  St->>A: createApp(config, db) and hand it the port
```

- **Config** (`config.ts`): `CONTACT` is required (it goes in the User-Agent, so plain ASCII only). Folder settings accept `~`, turn a WSL path like `/mnt/c/...` into `C:\...` on Windows, and refuse anything that wouldn't work on this OS (a Linux path on Windows, a relative path), saying what to write instead.
- **The guard** (`http/localOnly.ts`): `Host` must be `localhost:<port>` or `127.0.0.1:<port>` (also Vite's 5173 in development), which blocks DNS rebinding. Requests the browser marks as cross-site or same-site are refused unless they're a page navigation, and anything but GET or HEAD must carry a matching `Origin`. Failures are a 403 explaining why.
- **Headers:** `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`.
- **Errors** (`http/errors.ts`) are written in one place, the last middleware, always as `{ "error": "..." }`. Routes throw an `HttpError(status, message)`, or `parseInput(schema, value)` turns bad input into a 400 with Zod's message. A `SourceError` (an outside site failing) becomes a 502 with its message. Anything else is a 500 whose details stay in the server's console.
- **In production** the server also serves `client/dist`; a path without a file extension gets `index.html`, and if the client isn't built, pages answer 503 with what to run.
- **In development** `dev.ts` runs `main.ts` and restarts it when server or shared code changes, polling modified times once a second (WSL gives no change events for files on a Windows drive).

## Talking to other sites

Every outbound request goes through `createRequester` (`http/requester.ts`). It:

- sends `wise-old-model/<version> (personal use; contact: <CONTACT>)` as the User-Agent (the wiki blocks generic ones);
- keeps one queue per site: Wise Old Man requests at least 3 s apart, every other site 1 s, on a clock that only moves forward;
- pauses Wise Old Man when its `RateLimit-Remaining` runs low, until `RateLimit-Reset` (its 20/min, 500/h and 3,000/day per-IP limits are shared with the Wise Old Man RuneLite plugin);
- retries 429s, 5xx errors and lost connections up to 3 times (1, 2, then 4 s, or as `Retry-After` says), gives each request 20 s, and never waits more than a minute: a longer wait fails at once with the site's status ("Try again in 20 hours");
- names the site in every error (`Wise Old Man: server error (500)`) and adds the site's own reason when it gives one. A 404 is a separate `NotFoundError`.

Sources build on two helpers in `sources/answers.ts`: `fetchChecked` fetches and checks an answer parses (a maintenance page can arrive with a 200), returning both the text to store and the parsed value; `readSaved` parses a stored answer back.

### The sources

The endpoints below were checked against the live APIs on 2026-10-27; recheck an API's docs before relying on anything not listed.

| Source | Module | What the app uses | Kept for |
|---|---|---|---|
| OSRS Hiscores | `hiscores.ts` | `m=hiscore_oldschool/index_lite.json?player=<name>`: skills and activities (bosses, clues, "Collections Logged"), in the order given, so new skills appear without code changes | 15 min |
| Wise Old Man | `wom.ts` | `/players/:name` (type, EHP, EHB, boss kills), `/gained` (by period or dates), `/achievements`, `/names` (name changes), `/efficiency/rates` | 15 min; rates 1 day |
| TempleOSRS | `temple.ts` | The whole collection log with names and missing items; `categories.php` for each entry's tab | 1 hour; categories 1 day |
| OSRS Wiki | `wiki.ts` | Search, page sections and wikitext, Bucket queries (quests, recommended gear, item stats, drops), template expansion | Pages until they change (rechecked daily); the rest 1 day |
| Wiki prices | `prices.ts` | `/api/v2/osrs/mapping` (every tradeable item) and `/latest` (every item's last trades), bulk only | 1 day / 5 min |
| Icons | `icons.ts` | Wiki images by file name, RuneLite's item icons by id | Forever, as files |
| Character Export | `characterExport.ts` | The plugin's JSON files in the RuneLite folder | Re-read when changed |

A few rules worth knowing:

- **Wise Old Man is never updated automatically.** Refresh asks it to update a player only when its data is over an hour old, and never for a player it doesn't track (that would start tracking them; the add-account dialog offers that instead).
- Efficiency rates follow the account type: `main` for regular, `ultimate`, and `ironman` for every other iron type. `hoursToTarget` (`calc/estimates.ts`) walks a skill's XP brackets the way Wise Old Man's own algorithm does.
- Hiscores answers keep unranked entries (`rank: -1`); an unranked skill still has its real level and XP. Account types use different hiscores tables, which nest (every account is on the main table, so stats come from there).
- Temple's times are UTC without saying so. A player who never synced gets Temple's error 402, which the app treats as "no log yet". The log is compared without its rank and sync time, so only a changed log adds a snapshot.
- Wiki titles are normalized (spaces, a capital first letter), redirects followed, and each page part is cached with its revision id. A day-old page is checked with one `latestRevisions` request for up to 50 pages, and downloaded again only if it changed. Section text is turned into plain lines (tables as `cell | cell`) and cut at 4,000 characters.
- Prices can exceed 2³¹, so they stay JavaScript numbers (exact to 2⁵³).

## Freshness: when to fetch

`ensureFresh` (`services/freshness.ts`) decides, per account and kind, whether to fetch. It knows nothing about any one source: each kind has a fetcher, and a small table says which kinds wait for another on Refresh (Wise Old Man's gains and achievements wait for its player answer).

```mermaid
flowchart TD
  ask["A page, tool or Refresh needs a kind"] --> recent{"fetched or tried<br/>within its limit?"}
  recent -- yes --> saved["use the saved copy<br/>(with the last error, if any)"]
  recent -- no --> flight{"a fetch already<br/>under way?"}
  flight -- yes --> share["share it"]
  flight -- no --> fetch["fetch through the requester"]
  fetch -- ok --> store["save as latest;<br/>snapshot if it changed"]
  fetch -- fails --> keep["keep the last good data;<br/>note the error (a 404 as not found)"]
```

- A failed attempt counts toward the limit like a fetch, so a site that's down (or doesn't know the name) isn't asked again on every page load. Failures are remembered in memory while the server runs, including for a kind never fetched.
- **Refresh** ignores the limits, but never fetches a kind again within a minute.
- This week's ranges other than the week (today, 30 days, custom dates) aren't saved with the account; they're kept 15 minutes in memory (`remembered`) under the same rules.

### Shared data cache

Data not tied to an account lives in the `cache` table through `cachedEntry` (`store/cache.ts`), and `cachedFor` (`sources/wiki.ts`) for the wiki, prices, Temple's categories and Wise Old Man's rates. A saved copy is served while it's within its limit; when the site fails, it's served however old along with the failure. A failure stands for a minute, and a load already under way is shared.

Two layers avoid repeated parsing while you play (the Goals and Bank pages reload with every changed file):

- `parsedOnce` parses a whole table (every quest's requirements, the quest list's points, a diary page) once per cached copy.
- A cached row of 64 KB or more (the prices are about a megabyte) is turned back from JSON once per copy and shared.

Whole tables are fetched once and reused rather than queried per question, so requirement checks and item lookups need no wiki requests while the copies are fresh.

## Character Export

[Character Export](https://github.com/DZWNK/Character-Export) (a Plugin Hub plugin, BSD 2-Clause, no network code) writes JSON files to `<RUNELITE_DIR>/character-exporter/<character name>/`.

| File | Written when | Holds |
|---|---|---|
| `character.json` | Login, any stat change | Levels and XP |
| `quests.json` | Login, quest change | Every quest's state |
| `diaries.json` | Login, change, journal opened | 12 areas × 4 tiers, task names once a journal is opened |
| `combat_achievements.json` | Login, change | Every task, by tier |
| `bank.json`, `seed_vault.json` | When opened | Full contents |
| `inventory.json`, `equipment.json` | On change | Carried and worn items |

- **Reading** (`checkFiles`): only files whose modified time changed are read. The plugin overwrites in place, so a file that isn't valid JSON yet is retried 250 ms later, three tries in all; one still unreadable keeps the data from before and is noted as failed. The schemas (`characterExport.schemas.ts`) check the fields the app reads and keep any others, and the raw text is what's stored.
- **Folders** are found by name key, so a name written with a non-breaking space or underscores matches; of two matches, the one written to last wins.
- **A rewrite that only moved the export time** isn't a change and adds no snapshot.
- **Diary task names** only appear after opening that area's journal, and later exports can drop them. `mergeDiaryNames` keeps the most recent names seen in the history, dated, and flags them stale once the tier's task count moves. A tier counts as done by its named tasks while they're current, else by the plugin's flag.
- `collection_log.json` only covers entries opened in game, so the collection log comes from Temple instead.
- The plugin limits how often it saves each file and drops changes that come too soon; Sync Available in its side panel catches up.
- **Modes:** in Automatic mode an open page calls `POST /files/check` every few seconds (`pollSeconds`); in Manual mode only Refresh reads files. A chat message always checks first, so answers never use older data than what's on disk.

## Storage

```mermaid
erDiagram
  accounts ||--o{ source_state : "latest data per kind"
  accounts ||--o{ snapshots : "history"
  accounts ||--o{ goals : "has"
  accounts ||--o{ chat_sessions : "has"
  chat_sessions ||--o{ chat_messages : "holds"
  accounts {
    int id PK
    text name
    text name_key
    text type
    text type_source "wom or manual"
    text created_at
  }
  source_state {
    int account_id PK
    text kind PK
    text data "raw answer or file"
    text hash
    text fetched_at
    text file_mtime
    text error
    text error_at
  }
  snapshots {
    int id PK
    int account_id
    text kind
    text taken_at
    text data
  }
  goals {
    int id PK
    int account_id
    text title
    text kind
    text target "JSON"
    text status "active, done, dropped"
    int position
    text completed_at
    text dropped_at
  }
  chat_sessions {
    text id PK
    int account_id
    text title
    text provider_session_id
    text updated_at
  }
  chat_messages {
    int id PK
    text session_id
    text role
    text content "JSON"
    text usage
  }
  cache {
    text key PK
    text kind
    text fetched_at
    text revision
    text data
  }
  settings {
    text key PK
    text value "JSON"
  }
```

- **Saving** (`saveSource` in `store/sourceState.ts`) writes the latest copy and, in the same transaction, adds a snapshot when a SHA-256 of the data (or of a text the source gives to compare, leaving out what moves without the data changing) differs.
- **History kept:** every change for stats and progress (hiscores, Wise Old Man's player, Temple's log, quests, diaries, combat achievements, the character file); one a day for the bank and seed vault; latest only for inventory, worn gear and Wise Old Man's gains and achievements.
- **Names** match ignoring case, with spaces, underscores, hyphens and non-breaking spaces the same (`nameKey`). A rename keeps the account's id, so its history stays.
- **Times** are stored as ISO 8601 UTC text. Day-based rules use the time zone from the settings.
- **Deleting an account** deletes everything it owns (foreign keys cascade).
- **The file** is `wise-old-model.db` in the data folder, opened through `node:sqlite` with a small Kysely dialect of our own (`nodeSqliteDialect.ts`). Write-ahead logging with `synchronous = NORMAL`; a write waits up to 5 s for a lock.
- **Migrations** (`db/migrations.ts`) run at startup, all pending ones in one transaction, with a foreign-key check before committing.
- **Backups** (`db/backup.ts`) are full copies made with `VACUUM INTO` into `backups/`: at startup when the newest is over a day old, before any migration (which must succeed first), and on Back up now. The newest 7 are kept.
- **Settings** are one row each, as JSON; a value no longer valid falls back to its default. Secrets and paths stay in `.env`.

## Page data

Each page has one service that returns everything it shows. They read saved data, fetch what's past its freshness limit first, and report each source's freshness.

| Service | Page | Notes |
|---|---|---|
| `overview.ts` | Overview | Levels, top kill counts (bosses told apart by Wise Old Man's boss list), progress rows (quests, diary tiers, combat achievement points against the wiki's thresholds, collection log), worn gear, what's missing |
| `gains.ts` | This week | Wise Old Man's XP and kill gains; quests, diaries and combat achievements done, from our own snapshots; new collection log items, from Temple's dates; goals done |
| `bank.ts` | Bank and gear | The bank's value (latest instant-buy price, else instant-sell, else the wiki's value; coins at face value), a search across every place, worn gear, inventory |
| `collectionLog.ts` | Collection log | Temple's log, each entry in its tab |
| `accounts.ts` | Menu, Settings, add dialog | Lookup before adding, add, rename, change type, delete, Refresh (including the rename check), each account's status for Settings |
| `accountData.ts` | Goals, AI tools | Everything saved for an account in one normalized shape: levels (the newer of the hiscores and the character file), quests, diaries, combat achievements, owned items, Temple's log |
| `itemInfo.ts` | AI tools | An item's stats, price, buy limit and likeliest drop sources |

### Calculations

- **Requirement checks** (`calc/requirements.ts`): every quest's requirements come from one Quest Bucket query; a diary's from its page's task table. Lines the parser can't turn into a checkable requirement (alternatives, conditions, items) are kept as plain text and listed as unchecked, rather than guessed. Quest points are worked out from the wiki's quest list, since no source gives them.
- **Gear** (`calc/gear.ts`): a boss's recommended gear (from `<boss>/Strategies`) against what's owned in any state (charged, ornamented, degraded), up to three better items per slot within a budget, buyable only for accounts that can trade.
- **XP and time** (`calc/estimates.ts`): XP to a level or amount, and hours at Wise Old Man's efficient rates for the account type.
- **Combat achievements** (`calc/combatAchievements.ts`): points per tier from the wiki's thresholds.

## Goals

Goals belong to one account; progress is computed from its data every time, never stored.

| Kind | Target | Progress |
|---|---|---|
| Skill | A level (2–126) or an XP amount | A bar from the starting XP, XP to go, hours at efficient rates |
| Quest | Complete a quest | What's still needed, from the same check the AI uses |
| Diary | Complete an area's tier | What's still needed, tasks done |
| Combat achievements | A task, or a whole tier | Done or not; points toward the tier |
| Boss kills | A kill count | The hiscores' count |
| Collection log | An item, or a whole entry | Obtained or not; items in the entry |
| Item | Own an item | Where it is, in any state |
| Custom | Free text | Ticked off by hand |

- A goal **completes itself** when the data shows it reached (`syncGoalCompletion`): after Refresh, after a file check that read a changed file, and before the Goals page is shown. Custom goals are ticked off by hand.
- Active goals keep **your order**, which the AI reads as priorities. Dropped goals are kept but hidden.
- Names in a goal are checked against the account's data and written as the data writes them.
- The Goals page loads the **shared data** its goals need (quest requirements and points, diary pages, combat achievement thresholds, Wise Old Man's rates) in parallel, while the account's own sources refresh.

## The AI layer

```mermaid
flowchart LR
  route["routes/chats.ts<br/>(SSE)"] --> svc["chatService.ts<br/>turns, storage, approvals"]
  svc --> prov{{"ChatProvider interface<br/>(provider.ts)"}}
  prov --> claude["claudeProvider.ts<br/>Claude Agent SDK"]
  prov -.-> fake["fakeProvider.ts<br/>(tests)"]
  svc --> tools["tools/<br/>20 tools via defineTool"]
  svc --> instr["instructions.ts<br/>system prompt, message header"]
  claude --> cc["Claude Code process"]
  cc -- "MCP (in-process 'osrs' server)" --> tools
```

### Chat service

`createChatService` runs one turn at a time per chat:

1. Stores the question, names a new chat after it, and checks the account's files (completing goals), sending a `files` event when something changed.
2. Builds the system prompt (`buildSystemPrompt`: the account's name and type with that type's rule, the nine rules below) and heads the message with the local time and zone (`Local time: Tuesday 27 October 2026, 17:00 (America/Chicago, GMT-05:00)`). The prompt never changes within a chat, so Claude's prompt cache holds.
3. Streams the provider's events to the page as `ChatEvent`s (`shared/src/chat.ts`): text, each lookup with its status line, changes waiting for approval and their answers, then the wiki pages read, tokens used and `done`.
4. Stores the answer, with its error and whether it was stopped.

Stop, closing the page, or deleting the chat or its account ends the turn at once; whatever it left open (a change waiting, a lookup running) is settled the same way on the page and in the stored answer.

### The Claude provider

`claudeProvider.ts` calls the Agent SDK's `query` per turn:

- `tools: []` (no built-in tools), `settingSources: []` (none of your Claude Code settings, plugins or skills), `strictMcpConfig` (no other MCP servers), a custom system prompt, and a working folder of its own (`<dataDir>/claude/`), so these sessions stay out of your coding projects. Each chat resumes its Claude Code session.
- The app's tools are an in-process MCP server. Every call goes through `canUseTool`: lookups run unasked; a goal change is shown as an Approve / Decline row first; anything else is refused.
- **Billing:** with your plan, any `ANTHROPIC_API_KEY` is removed from Claude Code's environment, and a turn whose Claude Code would still bill a key stops with an explanation. With API key billing, the key from `.env` is passed in, with an hour-long prompt cache and the optional spending cap.
- The models and effort levels offered come from Claude Code itself (`supportedModels()`, asked without sending a prompt, kept an hour per billing), so new models appear without code changes. The default model is Claude Code's `opus` alias.
- Errors come with what to do: not signed in gets the `claude` then `/login` steps.

The app never reads, copies or stores the Claude sign-in; Claude Code handles it.

### Instructions

The system prompt tells the model to: act as an advisor for this one account; take facts about it only from tools, saying when data is missing or stale and how to fix it; respect the account type (ironmen can't trade, ultimate ironmen have no bank, hardcore ironmen get risk warnings); take numbers from the calculation tools; check and cite the wiki for every specific game fact; ask before guessing; decline botting, real-world trading and similar; be concise; and add goals only with approval.

### Tools

Each tool is built with `defineTool` (`tools/define.ts`), which checks the input against its Zod schema before running, adds `asOf` to every result, and refuses a result over 8,000 characters of JSON (so the model asks for less). Results say which sources are stale and which files are missing.

| Group | Tools |
|---|---|
| Account | `get_account_overview`, `get_boss_kills`, `get_quests`, `get_diaries`, `get_combat_achievements`, `get_collection_log`, `get_gains`, `get_bank`, `get_gear` |
| Calculations | `check_quest_requirements`, `check_diary_requirements`, `calc_xp`, `find_gear_upgrades` |
| Game knowledge | `search_wiki`, `get_wiki_page`, `get_item_info`, `get_prices` |
| Goals | `list_goals`, `add_goal` and `update_goal` (these two need approval) |

Everything a tool returns is sent to the AI provider, so tools return only account and game data, filtered small (never a whole bank or page).

## API

All routes are under `/api`. Inputs are checked with the shared schemas; an unknown id is a 404.

| Route | Does |
|---|---|
| `GET /health` | Version check |
| `GET`, `PATCH /settings` | The app's settings (a partial update; unknown keys refused) |
| `GET /about` | Data folder, RuneLite folder and whether it's there, last backup, `.env` values (the API key only as set or not) |
| `POST /backups` | Back up now |
| `GET /accounts` | Every account, by name |
| `GET /accounts/status` | Each account's Character Export folder and Temple log, from saved data |
| `GET /accounts/lookup?name=` | What the hiscores, Wise Old Man, Temple and Character Export know about a name before adding it |
| `POST /accounts` | Add an account (optionally asking Wise Old Man to start tracking it) |
| `PATCH`, `DELETE /accounts/:id` | Rename or change type; delete with all its data |
| `POST /accounts/:id/refresh` | Fetch everything again (within the one-minute floor), read the files, suggest a rename if Wise Old Man saw one |
| `POST /accounts/:id/files/check` | Read changed Character Export files and complete goals |
| `GET /accounts/:id/overview`, `/gains`, `/bank?search=`, `/collection-log` | The pages' data |
| `GET`, `POST /accounts/:id/goals`, `GET /accounts/:id/goals/options`, `POST /accounts/:id/goals/reorder`, `PATCH /goals/:id` | Goals |
| `GET`, `POST /accounts/:id/chats`, `PATCH`, `DELETE /chats/:id`, `GET /chats/:id/messages` | Chats |
| `POST /chats/:id/messages` | Send a message; the answer streams back as server-sent events |
| `POST /chats/:id/approvals/:requestId`, `POST /chats/:id/stop` | Approve or decline a change; stop an answer |
| `GET /chat/models?billing=` | The models and effort levels Claude Code offers |
| `GET /icons/wiki/:file`, `GET /icons/item/:id` | Game icons, downloaded on first use and kept in the data folder |

Icons are served with a year-long immutable cache. Only plain file names and numeric ids are accepted, a file is written whole or not at all, and a site that fails isn't asked for icons for a minute, so a page full of icons can't hold up the wiki's queue.

## Testing

- `server/test/helpers.ts` gives every test a fresh temp folder (`tempDir`), a config pointing at it (`testConfig`), a migrated database (`testDb`, in memory unless a file is passed), and `call`, one real HTTP request against the app.
- Outside sites are faked with `fakeRequester`, fed with responses captured once from the real APIs (`server/test/fixtures`); `sharedDataAnswer` answers the wiki, prices, Temple's categories and Wise Old Man's rates from those fixtures. `testWikiCtx` gives a wiki context with a movable clock.
- Character Export samples come from real files, trimmed and renamed so no real names are committed (`exportFixture`, `writeExportFiles`).
- The chat is tested with `fakeProvider.ts`; tests never call Claude. The Claude provider is tested against a fake `query`.
- The requester's queues, pauses and retries are tested with an injected clock and `sleep`, so they run instantly.
