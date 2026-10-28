# Wise Old Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local OSRS account advisor in `ARCHITECTURE.md`: a chat-first web app that knows each account's real state and cites the OSRS Wiki.

**Architecture:** One Node 26 process (Express 5 on `127.0.0.1:4747`) serves the React app, reads Character Export's files, fetches the hiscores, Wise Old Man, Temple and the wiki through one rate-limited request handler, stores everything in `node:sqlite` through Kysely, and runs Claude through the Claude Agent SDK with our own in-process tools. Seven phases, each ending in something you can run.

**Tech Stack:** Node 26 (TypeScript run directly), TypeScript 7 (type checking only), Express 5, `node:sqlite` + Kysely 0.29, Zod 4, `@anthropic-ai/claude-agent-sdk` 0.3.x, React 19, Vite 8, React Router 8, TanStack Query 5, Biome 2, Vitest 5, concurrently, cross-env, node-html-parser, Fontsource.

**Spec:** `ARCHITECTURE.md` (the design; each task names its section), `README.md` (setup), `CLAUDE.md` (working rules).

## Working rules

- Claude runs only read-only git commands and never commits, stages or switches branches. Every task ends with a **Checkpoint**: run `npm run check` (from Task 1 on) and expect exit 0; update `ARCHITECTURE.md` / `README.md` / `CLAUDE.md` wherever the code now differs from them or adds commands; then hand the user a commit message (brief, only the changes, no trailers) if commit messages are switched on. The user commits.
- TDD for every code step (superpowers:test-driven-development): failing test, watch it fail, implement, watch it pass.
- Run single test files with `npx vitest run <path>`.
- Tests never call Claude or the live APIs. Fixtures are captured once with the commands given, using the header `-A "wise-old-model/dev (personal use; contact: davisparkergoff@gmail.com)"`.

## Global Constraints

- `"engines": { "node": ">=26" }` in every `package.json`; Node pinned in `mise.toml`.
- Runs on Windows, macOS, Linux and WSL: no shell-specific npm scripts, environment variables in scripts via `cross-env`, paths via `node:path`, no node-gyp add-ons.
- Server binds `127.0.0.1`, default port `4747`. `Host` must be `localhost:<port>` or `127.0.0.1:<port>` (also port `5173` when `NODE_ENV=development`); non-GET requests also need a matching `Origin`.
- Server TypeScript: erasable syntax only (no enums, namespaces, parameter properties); relative imports end in `.ts`; TypeScript 7 with `noEmit`.
- Every outbound request goes through the shared request handler, with User-Agent `wise-old-model/<version> (personal use; contact: davisparkergoff@gmail.com)`.
- Wise Old Man: requests at least 3 s apart, obey `RateLimit-*` headers, never update automatically; Refresh may `POST /players/:username` only when WOM's `updatedAt` is over 1 hour old. Other sites at least 1 s apart.
- Wiki prices: API v2 `https://prices.runescape.wiki/api/v2/osrs`, bulk endpoints only; prices stored as 64-bit integers.
- Freshness limits: hiscores 15 min, WOM reads 15 min, Temple 1 h, prices `/latest` 5 min, `/mapping` 1 day, Bucket results 1 day, wiki search 1 day, wiki pages until their revision changes (checked after 1 day), icons forever. Refresh never refetches a source fetched under 60 s ago.
- Times stored as ISO 8601 UTC text; shown in the configured time zone; day-based rules use that zone.
- Name matching uses `nameKey()`: lowercase; spaces, `_`, `-` and U+00A0 become one space; trimmed.
- Snapshots are saved only when data changed. Retention: stats and progress every change; bank and seed vault one per local day; inventory, equipment, WOM gains and WOM achievements latest only.
- Claude: the app never reads, copies or stores the Claude sign-in. With Plan billing, `ANTHROPIC_API_KEY` is removed from the Agent SDK's environment. Tools are the model's only data path; write tools need the user's approval.
- Game icons are never committed; they're cached as files under `<DATA_DIR>/icons/`.
- UI copy: sentence case; no all-caps labels, no middle-dot meta strings, no arrows appended to buttons. Colors and fonts exactly as in `ARCHITECTURE.md` → Frontend.
- Tool results stay under 8,000 characters of JSON.

## Review Focus

1. A name with spaces, `_`, `-` or a non-breaking space (Character Export folder `Lumby Pete` with U+00A0, typed `lumby_pete`) resolves to the same account and folder. Tests: Tasks 8 and 17.
2. A new or renamed account the hiscores 404 and Wise Old Man doesn't track can still be added, showing "not on the hiscores yet". Test: Task 12.
3. Character Export files that are missing (bank never opened) or caught half-written show what to do or are retried, never crash or replace good data. Tests: Task 17.
4. No network, or a source answering 429/5xx, leaves the last good data on screen marked stale with the reason, and the chat still answers from what it has. Tests: Tasks 7, 11 and 28.
5. Running on Windows after developing in WSL: `%LOCALAPPDATA%` data folder, `C:\Users\…` RuneLite folder, backslash paths. Test: Task 2.

---

## Phase 0: Before coding

### Task 0: Game-side setup (the user)

Not code. Task 17 can't start until the last step is done.

- [ ] Install **Character Export** and **Temple OSRS** from the RuneLite Plugin Hub.
- [ ] On each account: log in; open the bank, the seed vault and every diary journal once; press Temple's sync button in the collection log; turn on Temple's automatic sync and the in-game "Collection log – New addition notification".
- [ ] Check that `~/.runelite/character-exporter/<name>/` (Windows: `C:\Users\<you>\.runelite\character-exporter\<name>\`) holds `character.json`, `quests.json`, `diaries.json`, `combat_achievements.json`, `bank.json`, `seed_vault.json`, `inventory.json`, `equipment.json`. If inventory, equipment or seed vault are missing: press **Sync Available** in Character Export's side panel, and open the seed vault once.
- [x] Tell Claude where one account's folder is, for Task 17's fixtures. (Done: `C:\Users\Davis\.runelite\character-exporter\PoutingPop`; a second account, `SaturnsJudge`, is there too. Checked on 2026-10-27: everything except `seed_vault.json`, which needs the seed vault unlocked.)

---

## Phase 1: Skeleton

Ends with: `npm run dev` shows the empty three-column app in both themes, and `npm run check` passes.

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.gitattributes`, `.env.example`
- Modify: `.gitignore` only if the scaffold produces something it doesn't already cover
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`, `shared/src/index.test.ts`
- Create: `server/package.json`, `server/tsconfig.json`, `client/package.json`, `client/tsconfig.json`

**Interfaces:**
- Produces: workspaces `@wom/shared`, `@wom/server`, `@wom/client`; root scripts `dev`, `dev:server`, `dev:client`, `build`, `start`, `test`, `typecheck`, `lint`, `check`.

- [x] **Step 1: Write the failing test** `shared/src/index.test.ts`: `it('names the app', () => expect(APP_NAME).toBe('wise-old-model'))`.
- [x] **Step 2: Run** `npx vitest run shared/src/index.test.ts`. Expected: FAIL (cannot find module).
- [x] **Step 3: Create the files**
  - Root `package.json`: `"private": true`, `"type": "module"`, `"workspaces": ["shared", "server", "client"]`, `"engines": { "node": ">=26" }`. Scripts:
    - `dev`: `concurrently -k -n server,client "npm:dev:server" "npm:dev:client"`
    - `dev:server`: `cross-env NODE_ENV=development node --watch --env-file-if-exists=.env server/src/main.ts`
    - `dev:client`: `npm run dev -w @wom/client`
    - `build`: `npm run build -w @wom/client`
    - `start`: `cross-env NODE_ENV=production node --env-file-if-exists=.env server/src/main.ts`
    - `test`: `vitest run`; `typecheck`: `tsc -p shared && tsc -p server && tsc -p client`; `lint`: `biome check .`; `check`: `npm run typecheck && npm run lint && npm test`
  - Root devDependencies: `typescript@^7`, `@biomejs/biome@^2`, `vitest@^5`, `concurrently@^10`, `cross-env@^10`, `@types/node`.
  - `tsconfig.base.json`: `strict`, `noEmit`, `target` and `lib` `esnext`, `module` and `moduleResolution` `nodenext`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `skipLibCheck`. `client/tsconfig.json` overrides `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `lib: ["esnext", "dom"]`.
  - `vitest.config.ts`: three projects, `shared` and `server` (environment `node`) and `client` (environment `jsdom`).
  - `biome.json`: recommended lint rules, formatter on, 2-space indent, ignores `client/dist` and `.superpowers`.
  - `.gitattributes`: `* text=auto eol=lf`. (`.gitignore` already exists; see `ARCHITECTURE.md` → Repo and tooling.)
  - `.env.example`: the five variables in `ARCHITECTURE.md` → Configuration, each with its default and a one-line comment; `CONTACT=` left empty.
  - `shared/src/index.ts`: `export const APP_NAME = 'wise-old-model';`
- [x] **Step 4: Verify** `npm install`, then `npx vitest run shared/src/index.test.ts`: PASS. `npm run check`: exit 0.
- [x] **Step 5: Checkpoint.**

### Task 2: Config and paths

Spec: Configuration, Platforms.

**Files:** Create `server/src/config.ts`, `server/src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Config = { contact: string; port: number; dataDir: string; runeliteDir: string; anthropicApiKey: string | null; isDev: boolean; version: string };
  export class ConfigError extends Error {}
  export function loadConfig(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string): Config;
  export function userAgent(config: Pick<Config, 'version' | 'contact'>): string;
  ```

- [x] **Step 1: Write the failing tests**
  - `requires CONTACT`: `expect(() => loadConfig({}, 'linux', '/home/u')).toThrow(/CONTACT/)`
  - `defaults on Linux`: `dataDir === '/home/u/.local/share/wise-old-model'`; with `XDG_DATA_HOME='/x'` it's `'/x/wise-old-model'`; `runeliteDir === '/home/u/.runelite'`; `port === 4747`
  - `defaults on macOS`: `dataDir === '/Users/u/Library/Application Support/wise-old-model'`
  - `defaults on Windows`: with `LOCALAPPDATA='C:\\Users\\u\\AppData\\Local'`, `dataDir === 'C:\\Users\\u\\AppData\\Local\\wise-old-model'` and `runeliteDir === 'C:\\Users\\u\\.runelite'` (home `C:\\Users\\u`)
  - `honours overrides`: `PORT='5000'`, `DATA_DIR='/d'`, `RUNELITE_DIR='/mnt/c/Users/u/.runelite'` come back as given
  - `rejects a bad PORT`: `PORT='abc'` throws `/PORT/`
  - `builds the User-Agent`: `userAgent({ version: '0.1.0', contact: 'me#1234' }) === 'wise-old-model/0.1.0 (personal use; contact: me#1234)'`
- [x] **Step 2: Run** `npx vitest run server/src/config.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** using `path.win32` when `platform === 'win32'`, else `path.posix`, so the tests pass on any OS. `version` comes from the root `package.json`; `isDev = env.NODE_ENV === 'development'`; empty `ANTHROPIC_API_KEY` means `null`.
- [x] **Step 4: Run** the test file. Expected: PASS.
- [x] **Step 5: Checkpoint.**

### Task 3: Server app with the local-only guard

Spec: Backend → Local-only server.

**Files:** Create `server/src/http/localOnly.ts`, `server/src/http/localOnly.test.ts`, `server/src/app.ts`, `server/src/main.ts`. Modify `server/package.json` (`express@^5`, `@types/express`).

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces:
  ```ts
  export function checkLocalRequest(req: { method: string; host?: string; origin?: string }, ports: number[]): 'ok' | 'bad-host' | 'bad-origin';
  export function localOnly(ports: number[]): express.RequestHandler; // 403 with { error } on anything but 'ok'
  export type AppDeps = { config: Config }; // later tasks add fields
  export function createApp(deps: AppDeps): express.Express; // GET /api/health → { ok: true, version }; in production also serves client/dist with an index.html fallback
  ```
- `main.ts`: `loadConfig(process.env, process.platform, os.homedir())`; on `ConfigError` print the message and exit 1; listen on `127.0.0.1:<port>`; print `Wise Old Model is running at http://127.0.0.1:<port>`.

- [x] **Step 1: Write the failing tests** for `checkLocalRequest` with `ports = [4747]` unless noted:
  - `GET` with host `localhost:4747` → `'ok'`; host `127.0.0.1:4747` → `'ok'`; host `evil.example:4747` → `'bad-host'`; host missing → `'bad-host'`
  - `POST` with host `localhost:4747`, origin `http://localhost:4747` → `'ok'`; origin `http://evil.example` → `'bad-origin'`; no origin → `'bad-origin'`
  - With `ports = [4747, 5173]`: `POST` host `localhost:5173`, origin `http://localhost:5173` → `'ok'`
- [x] **Step 2: Run** `npx vitest run server/src/http/localOnly.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** the three exports and `main.ts`. `ports` is `[config.port]`, plus `5173` when `config.isDev`.
- [x] **Step 4: Run** the tests: PASS. Then `CONTACT=test npm run dev:server` and `curl -s http://127.0.0.1:4747/api/health` → `{"ok":true,...}`.
- [x] **Step 5: Checkpoint.**

### Task 4: Database, migrations and backups

Spec: Backend → Storage; Database.

**Files:** Create `server/src/db/nodeSqliteDialect.ts`, `server/src/db/schema.ts`, `server/src/db/migrations.ts`, `server/src/db/open.ts`, `server/src/db/backup.ts`, `server/src/db/db.test.ts`, `server/src/db/backup.test.ts`. Modify `server/package.json` (`kysely@^0.29`), `server/src/app.ts` and `main.ts` (open the DB at `<dataDir>/wise-old-model.db`, run `backupIfDue` at startup, add `db` to `AppDeps`).

**Interfaces:**
- Produces:
  ```ts
  export interface DB { accounts: AccountsTable; source_state: SourceStateTable; snapshots: SnapshotsTable; cache: CacheTable; goals: GoalsTable; chat_sessions: ChatSessionsTable; chat_messages: ChatMessagesTable; settings: SettingsTable }
  export type AccountRow = Selectable<AccountsTable>;
  export async function openDatabase(file: string, opts: { backupDir: string | null; now: () => Date }): Promise<Kysely<DB>>; // ':memory:' allowed (no WAL, no backup)
  export async function backupNow(db: Kysely<DB>, backupDir: string, now: Date): Promise<string>; // VACUUM INTO, then keep the newest 7
  export async function backupIfDue(db: Kysely<DB>, backupDir: string, now: Date): Promise<string | null>; // only when the newest backup is over 24 h old (or none exists)
  ```
- Tables (all times ISO UTC text):
  - `accounts`: `id` integer pk, `name`, `name_key` unique, `type`, `type_source` (`'wom' | 'manual'`), `notes` null, `created_at`
  - `source_state`: `account_id` fk (cascade), `kind`, `data`, `hash`, `fetched_at`, `file_mtime` null, `error` null, `error_at` null; pk (`account_id`, `kind`)
  - `snapshots`: `id` pk, `account_id` fk (cascade), `kind`, `taken_at`, `data`
  - `cache`: `key` pk, `kind`, `fetched_at`, `revision` null, `data`
  - `goals`: `id` pk, `account_id` fk (cascade), `title`, `kind`, `target` (JSON), `status`, `position`, `created_at`, `completed_at` null, `dropped_at` null
  - `chat_sessions`: `id` text pk (UUID), `account_id` fk (cascade), `title`, `provider_session_id` null, `created_at`, `updated_at`
  - `chat_messages`: `id` pk, `session_id` fk (cascade), `role` (`'user' | 'assistant'`), `content` (JSON), `usage` (JSON) null, `created_at`
  - `settings`: `key` pk, `value` (JSON)

- [x] **Step 1: Write the failing tests**
  - `db.test.ts`: insert an account with `returning('id')` → `1`; select it back; after `openDatabase(':memory:', …)` the table names from `db.introspection.getTables()` are exactly the 8 above (plus Kysely's migration tables); deleting an account removes its `snapshots`, `goals`, `chat_sessions` and their `chat_messages` (foreign keys on); `PRAGMA journal_mode` is `wal` for a file database.
  - `backup.test.ts` (temp dir, fixed clock): `backupIfDue` creates `backups/wom-2026-10-27T120000Z.db` when none exist; returns `null` when the newest is 2 h old; after 9 `backupNow` calls one minute apart, 7 files remain and they're the newest; when a new migration is pending on an existing database file, a backup appears before it runs.
- [x] **Step 2: Run** `npx vitest run server/src/db`. Expected: FAIL.
- [x] **Step 3: Implement.** The dialect adapts `DatabaseSync` to Kysely's `SqliteDialect` interface:
  ```ts
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      reader: stmt.columns().length > 0,
      all: (params) => stmt.all(...(params as SQLInputValue[])),
      run: (params) => stmt.run(...(params as SQLInputValue[])),
      iterate: (params) => stmt.iterate(...(params as SQLInputValue[])),
    };
  }
  ```
  Migrations are an in-code `Record<string, Migration>` behind a custom `MigrationProvider` (`001_initial` creates all tables). `openDatabase` sets `PRAGMA foreign_keys = ON` and, for files, `PRAGMA journal_mode = WAL`, then backs up if migrations are pending and the file already existed, then migrates.
- [x] **Step 4: Run** the tests: PASS.
- [x] **Step 5: Checkpoint.**

### Task 5: Client shell, layout and themes

Spec: Frontend → Layout, Stack, Styling, Themes, Visual direction.

**Files:** Create `client/index.html`, `client/vite.config.ts`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/layout/Layout.tsx`, `client/src/layout/Layout.module.css`, `client/src/layout/Layout.test.tsx`, `client/src/theme/tokens.css`, `client/src/theme/fonts.ts`, `client/src/api/client.ts`. Modify `client/package.json`: `react@^19`, `react-dom`, `react-router@^8`, `@tanstack/react-query@^5`, `zod@^4`, `@fontsource/alegreya`, `@fontsource/alegreya-sans`, `@fontsource/silkscreen`; dev: `vite@^8`, `@vitejs/plugin-react`, `@testing-library/react`, `jsdom`.

**Interfaces:**
- Produces:
  ```ts
  export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  export async function apiSend<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
  export function Layout(props: { chat: ReactNode; page: ReactNode; menu: ReactNode }): JSX.Element;
  ```
- Routes: `/` and `/:accountId/:page`, where `page` is `overview | this-week | goals | bank | collection-log | settings`.
- `<html data-theme="dark|light">`; `tokens.css` defines both themes' variables with the exact hex values in `ARCHITECTURE.md` → Visual direction; dark is the default.
- Vite: `server.port: 5173`, `strictPort: true`, `server.proxy['/api'] = { target: 'http://127.0.0.1:<PORT, else 4747>', changeOrigin: false }`, `server.cors: false`; `build.outDir: 'dist'`.

- [x] **Step 1: Write the failing tests** (`Layout.test.tsx`): the three regions render in order with accessible names "Chat", "Page", "Menu"; the chat column is the first child; below 1000 px wide (mock `matchMedia`) the page and menu are hidden behind a menu button (a hamburger icon, named "Menu" for screen readers).
- [x] **Step 2: Run** `npx vitest run client/src/layout`. Expected: FAIL.
- [x] **Step 3: Implement** the shell with placeholder content, the fonts (Alegreya for headings and answers, Alegreya Sans for the interface, Silkscreen only for skill levels) and both token sets. The chat column is about 54% of the width, the page 30%, the menu 16%.
- [x] **Step 4: Verify** the tests PASS; `npm run dev`, open `http://localhost:5173`, see three columns in the dark theme; set `data-theme="light"` in dev tools and see parchment.
- [x] **Step 5: Checkpoint.**

### Task 6: Settings and time helpers

Spec: Database → settings; Frontend → Settings page (Display); Database → Times.

**Files:** Create `shared/src/settings.ts`, `shared/src/time.ts`, `shared/src/time.test.ts`, `server/src/settings/settingsRepo.ts`, `server/src/routes/settings.ts`, `server/src/routes/settings.test.ts`, `client/src/settings/useSettings.ts`, `client/src/pages/Settings/Settings.tsx` (Display section only).

**Interfaces:**
- Produces:
  ```ts
  export const SettingsSchema: z.ZodObject<{ theme: 'dark' | 'light'; timeZone: string /* 'auto' or IANA */; detectedTimeZone: string | null; runeliteMode: 'automatic' | 'manual'; pollSeconds: number /* 2–300 */; billing: 'plan' | 'api_key'; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; maxTurns: number /* 1–100 */; budgetUsd: number | null }>;
  export const defaultSettings: Settings; // theme 'dark', timeZone 'auto', detectedTimeZone null, runeliteMode 'automatic', pollSeconds 5, billing 'plan', model 'claude-opus-5-5', effort 'medium', maxTurns 20, budgetUsd null
  export function effectiveTimeZone(s: Settings): string; // 'auto' → detectedTimeZone ?? 'UTC'
  export function localDayKey(iso: string, timeZone: string): string; // 'YYYY-MM-DD'
  export function formatTime(iso: string, timeZone: string, style: 'date' | 'datetime' | 'relative', now?: Date): string;
  export async function getSettings(db: Kysely<DB>): Promise<Settings>;
  export async function updateSettings(db: Kysely<DB>, patch: Partial<Settings>): Promise<Settings>;
  ```
- Routes: `GET /api/settings`, `PATCH /api/settings` (400 with Zod's message on invalid input). The client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` as `detectedTimeZone` on load, and applies `theme` to `<html data-theme>`.

- [x] **Step 1: Write the failing tests**
  - `time.test.ts`: `localDayKey('2026-10-28T03:00:00Z', 'America/Chicago') === '2026-10-27'`; `formatTime('2026-10-27T22:00:00Z', 'America/Chicago', 'datetime')` contains `5:00 PM`; `effectiveTimeZone({ ...defaultSettings, detectedTimeZone: 'Europe/London' }) === 'Europe/London'`; with neither set, `'UTC'`.
  - `settings.test.ts` (in-memory DB): `GET` returns `defaultSettings`; `PATCH { theme: 'light' }` then `GET` → `theme: 'light'`; `PATCH { pollSeconds: 1 }` → 400.
- [x] **Step 2: Run** both files. Expected: FAIL.
- [x] **Step 3: Implement**; the Display section has Theme (Dark, Light) and Time zone (Automatic, or a list from `Intl.supportedValuesOf('timeZone')`).
- [x] **Step 4: Verify** the tests PASS; switching the theme in Settings changes the app and survives a reload.
- [x] **Step 5: Checkpoint.**

---

## Phase 2: Accounts and online stats

Ends with: add an account by name and see its stats tiles, top kill counts and data freshness on Overview.

### Task 7: Shared request handler

Spec: Data sources → Fetching and caching (the request handler).

**Files:** Create `server/src/http/requester.ts`, `server/src/http/requester.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Requester = { json<T = unknown>(url: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T>; text(url: string): Promise<string>; bytes(url: string): Promise<Uint8Array> };
  export class SourceError extends Error { site: string; status: number | null } // constructor(site, status, message)
  export class NotFoundError extends SourceError {}
  export function createRequester(opts: { userAgent: string; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }): Requester;
  export const SPACING_MS: { 'api.wiseoldman.net': 3000; default: 1000 };
  ```
- Messages read like `Wise Old Man: server error (500)`, `Wise Old Man: too many requests (429)`, `Wise Old Man: no connection`. Site names by host: `secure.runescape.com` → Hiscores, `api.wiseoldman.net` → Wise Old Man, `templeosrs.com` → Temple, `oldschool.runescape.wiki` and `prices.runescape.wiki` → OSRS Wiki, `static.runelite.net` → RuneLite.

- [x] **Step 1: Write the failing tests** (fake `fetch`, fake clock and `sleep`):
  - sends exactly the given User-Agent header
  - two WOM requests start at least 3000 ms apart; two wiki requests at least 1000 ms apart; a WOM and a wiki request don't wait on each other
  - 429 with `Retry-After: 7` then 200 → slept 7000 ms, resolves
  - 500 four times → rejects `SourceError` with `status === 500` after exactly 4 calls
  - 404 → `NotFoundError` after 1 call
  - fetch throwing twice, then 200 → resolves (waits 1000 ms, then 2000 ms)
  - a WOM response with `RateLimit-Remaining: 1` and `RateLimit-Reset: 30` makes the next WOM request wait 30000 ms
- [x] **Step 2: Run** the file. Expected: FAIL.
- [x] **Step 3: Implement** one promise queue per host. Retries: up to 3 for 429, 5xx and network errors, waiting `Retry-After` seconds when present, else 1 s, 2 s, 4 s. Pause WOM when `RateLimit-Remaining <= 2`.
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 8: Names, source state and snapshots

Spec: Database → source_state, snapshots, History retention, Conventions (Names).

**Files:** Create `shared/src/names.ts`, `shared/src/names.test.ts`, `shared/src/accounts.ts`, `server/src/store/sourceState.ts`, `server/src/store/sourceState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function nameKey(name: string): string;
  export const AccountTypeSchema = z.enum(['regular', 'ironman', 'hardcore', 'ultimate', 'group', 'hardcore_group']); // shared/src/accounts.ts
  export type AccountType = z.infer<typeof AccountTypeSchema>;
  export type SourceKind = 'hiscores' | 'wom_player' | 'wom_gains_week' | 'wom_achievements' | 'temple_clog' | 'ce_character' | 'ce_quests' | 'ce_diaries' | 'ce_combat_achievements' | 'ce_bank' | 'ce_seed_vault' | 'ce_inventory' | 'ce_equipment';
  export function retentionFor(kind: SourceKind): 'every_change' | 'daily' | 'latest';
  export type SourceRow = { accountId: number; kind: SourceKind; data: string; hash: string; fetchedAt: string; fileMtime: string | null; error: string | null; errorAt: string | null };
  export async function saveSource(db: Kysely<DB>, input: { accountId: number; kind: SourceKind; data: string; fetchedAt: string; fileMtime?: string; timeZone: string }): Promise<{ changed: boolean }>;
  export async function getSource(db: Kysely<DB>, accountId: number, kind: SourceKind): Promise<SourceRow | null>;
  export async function markSourceError(db: Kysely<DB>, accountId: number, kind: SourceKind, message: string, at: string): Promise<void>;
  ```
- `every_change`: `hiscores`, `wom_player`, `temple_clog`, `ce_character`, `ce_quests`, `ce_diaries`, `ce_combat_achievements`. `daily`: `ce_bank`, `ce_seed_vault`. `latest`: `ce_inventory`, `ce_equipment`, `wom_gains_week`, `wom_achievements`. The hash is SHA-256 of `data`.

- [x] **Step 1: Write the failing tests**
  - `nameKey('Lumby_Pete') === nameKey('lumby-pete') === nameKey('Lumby\u00a0Pete') === 'lumby pete'`; `nameKey('  Iron  Pete ') === 'iron pete'`
  - identical data saved twice → second returns `{ changed: false }` and only 1 snapshot exists
  - an `every_change` kind saved with 3 different payloads → 3 snapshots
  - `daily` with `timeZone 'America/Chicago'`: changes at `2026-10-27T15:00Z` and `2026-10-28T03:00Z` (same Chicago day) → 1 snapshot holding the second payload; another change at `2026-10-28T15:00Z` → 2 snapshots
  - `latest` → never any snapshots; `source_state` holds the newest
  - `markSourceError` keeps `data` and sets `error`; the next successful `saveSource` clears `error`
- [x] **Step 2: Run** both files. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 9: Hiscores source

Spec: Data sources → What each API offers (Official hiscores).

**Files:** Create `server/src/sources/hiscores.ts`, `server/src/sources/hiscores.test.ts`, fixture `server/test/fixtures/hiscores/lynx-titan.json`

**Interfaces:**
- Consumes: `Requester`, `NotFoundError` (Task 7).
- Produces:
  ```ts
  export type HiscoreTable = 'hiscore_oldschool' | 'hiscore_oldschool_ironman' | 'hiscore_oldschool_hardcore_ironman' | 'hiscore_oldschool_ultimate';
  export type Hiscores = { name: string; skills: { name: string; rank: number; level: number; xp: number }[]; activities: { name: string; rank: number; score: number }[] };
  export function parseHiscores(json: unknown): Hiscores; // Zod; keeps the response's order; no hard-coded skill or boss list
  export async function fetchHiscores(req: Requester, rsn: string, table?: HiscoreTable): Promise<Hiscores | null>; // null on 404
  ```

- [x] **Step 1: Capture the fixture**: `curl -A "<UA>" "https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=Lynx%20Titan" -o server/test/fixtures/hiscores/lynx-titan.json`
- [x] **Step 2: Write the failing tests**: the fixture parses to 25 skills, first `Overall` and last `Sailing`, and 92 activities including `Collections Logged`; a copy with an extra skill `Testing` keeps it; a fake requester throwing `NotFoundError` → `null`; the URL for `Lumby Pete` ends `player=Lumby%20Pete`.
- [x] **Step 3: Run** the file. Expected: FAIL.
- [x] **Step 4: Implement.**
- [x] **Step 5: Run**: PASS.
- [x] **Step 6: Checkpoint.**

### Task 10: Wise Old Man source

Spec: Data sources → What each API offers (Wise Old Man); Tools → `calc_xp`.

**Files:** Create `server/src/sources/wom.ts`, `server/src/sources/wom.test.ts`, fixtures in `server/test/fixtures/wom/`: `player-phil03.json` (`GET /v2/players/phil03`), `gained-week.json` (`/players/phil03/gained?period=week`), `efficiency-rates-main.json` (`/efficiency/rates?metric=ehp&type=main`), `name-changes.json` (`/players/<any player with name changes>/names`).

**Interfaces:**
- Consumes: `Requester` (Task 7), `AccountType` (Task 8).
- Produces:
  ```ts
  export type WomPlayerType = 'regular' | 'ironman' | 'hardcore' | 'ultimate' | 'unknown';
  export type WomPlayer = { username: string; displayName: string; type: WomPlayerType; build: string; ehp: number; ehb: number; ttm: number; updatedAt: string | null; bosses: Record<string, { kills: number; rank: number }>; raw: unknown };
  export type WomGains = { startsAt: string; endsAt: string; skills: Record<string, { xpGained: number; levelStart: number; levelEnd: number }>; bosses: Record<string, { killsGained: number }>; activities: Record<string, { scoreGained: number }> };
  export type SkillRates = { skill: string; methods: { startExp: number; rate: number; description: string }[] };
  export type EfficiencyType = 'main' | 'ironman' | 'ultimate';
  export async function getPlayer(req: Requester, username: string): Promise<WomPlayer | null>;
  export async function getGains(req: Requester, username: string, range: { period: 'day' | 'week' | 'month' | 'year' } | { startDate: string; endDate: string }): Promise<WomGains>;
  export async function getAchievements(req: Requester, username: string): Promise<{ name: string; metric: string; createdAt: string }[]>;
  export async function getNameChanges(req: Requester, username: string): Promise<{ oldName: string; newName: string; resolvedAt: string | null }[]>;
  export async function getEfficiencyRates(req: Requester, type: EfficiencyType): Promise<SkillRates[]>;
  export async function updatePlayer(req: Requester, username: string): Promise<WomPlayer>; // POST /players/:username
  export function canRequestUpdate(player: WomPlayer | null, now: Date): boolean; // true when updatedAt is null or over 1 h old
  export function efficiencyTypeFor(accountType: AccountType): EfficiencyType; // regular → main; ironman, hardcore, group, hardcore_group → ironman; ultimate → ultimate
  ```
- Base URL `https://api.wiseoldman.net/v2`.

- [x] **Step 1: Capture the fixtures** with the commands in Files.
- [x] **Step 2: Write the failing tests**: the player fixture gives `type 'ironman'` and `displayName 'Phil03'`; `canRequestUpdate` is `false` at 30 min old, `true` at 2 h old and when `updatedAt` is `null`; `getGains` requests `/players/phil03/gained?period=week`, and the date-range form passes `startDate` and `endDate` as ISO strings; the week fixture maps `skills.attack.xpGained`; efficiency rates for `mining` start `{ startExp: 0, rate: 20000, description: 'Quests' }`; `efficiencyTypeFor('group') === 'ironman'`.
- [x] **Step 3: Run** the file. Expected: FAIL.
- [x] **Step 4: Implement** with Zod schemas over the captured shapes.
- [x] **Step 5: Run**: PASS.
- [x] **Step 6: Checkpoint.**

### Task 11: Freshness and refresh

Spec: Data sources → Fetching and caching; "When a source fails".

**Files:** Create `server/src/services/freshness.ts`, `server/src/services/freshness.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces:
  ```ts
  export type OnlineKind = 'hiscores' | 'wom_player' | 'wom_gains_week' | 'wom_achievements' | 'temple_clog';
  export const TTL_MS: Record<OnlineKind, number>; // 15 min except temple_clog 60 min
  export const REFRESH_FLOOR_MS = 60_000;
  export type Freshness = { kind: SourceKind; fetchedAt: string | null; stale: boolean; error: string | null };
  export type Fetchers = Record<OnlineKind, (account: AccountRow) => Promise<string>>; // raw JSON text to store
  export async function ensureFresh(deps: { db: Kysely<DB>; fetchers: Fetchers; wom: { getPlayer: typeof getPlayer; updatePlayer: typeof updatePlayer }; req: Requester; timeZone: string }, account: AccountRow, kinds: OnlineKind[], opts: { force: boolean; now: Date }): Promise<Freshness[]>;
  ```
- Never throws for source failures; on `SourceError` it calls `markSourceError` and returns `stale: true` with the error message. On a forced refresh, if `canRequestUpdate(currentWomPlayer, now)`, it calls `updatePlayer` before reading WOM.

- [x] **Step 1: Write the failing tests**: data fetched 5 min ago isn't refetched; `force` refetches data 2 min old but not 30 s old; a fetcher throwing `SourceError('Wise Old Man', 500, 'Wise Old Man: server error (500)')` → `stale: true`, that `error`, previous data unchanged; a forced refresh calls `updatePlayer` only when WOM's `updatedAt` is over 1 h old.
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 12: Accounts API and the add-account flow (server)

Spec: Frontend → Adding an account, Name changes; Database → accounts.

**Files:** Create `shared/src/osrs/combat.ts`, `shared/src/osrs/combat.test.ts`, `server/src/services/accounts.ts`, `server/src/routes/accounts.ts`, `server/src/routes/accounts.test.ts`. Modify `shared/src/accounts.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type Account = { id: number; name: string; type: AccountType; typeSource: 'wom' | 'manual'; createdAt: string };
  export type AccountLookup = { name: string; onHiscores: boolean; combatLevel: number | null; totalLevel: number | null; womType: AccountType | null; womTracked: boolean; characterExport: { found: boolean; lastWritten: string | null }; temple: { synced: boolean; lastChecked: string | null } };
  export function combatLevel(l: { attack: number; strength: number; defence: number; hitpoints: number; ranged: number; magic: number; prayer: number }): number;
  ```
- Routes: `GET /api/accounts`; `GET /api/accounts/lookup?name=`; `POST /api/accounts` `{ name, type, trackOnWom }` (409 when the `nameKey` exists); `PATCH /api/accounts/:id` `{ name?, type? }`; `DELETE /api/accounts/:id`; `POST /api/accounts/:id/refresh` → `{ freshness: Freshness[]; renameSuggestion: string | null }`.
- `characterExport` and `temple` in the lookup return `{ found: false, … }` until Tasks 17 and 18 fill them in.
- Rename suggestion: when the hiscores 404 an existing account on refresh, take the newest WOM name change whose `oldName` has the same `nameKey`.

- [x] **Step 1: Write the failing tests**
  - `combatLevel({ attack: 90, strength: 94, defence: 85, hitpoints: 92, ranged: 92, magic: 71, prayer: 74 }) === 113`
  - lookup for a name the hiscores 404 and WOM doesn't know → `onHiscores: false`, `womTracked: false`, status 200 (Review Focus 2)
  - adding `Lumby_Pete` when `Lumby Pete` exists → 409
  - deleting an account removes its data (cascade)
  - refresh with every fetcher failing → 200 with all freshness entries `stale: true` (Review Focus 4)
  - refresh where the hiscores 404 and WOM lists `{ oldName: 'Lumby Pete', newName: 'Lumby Peter' }` → `renameSuggestion: 'Lumby Peter'`
- [x] **Step 2: Run** both test files. Expected: FAIL.
- [x] **Step 3: Implement.** Combat formula: `base = 0.25 × (defence + hitpoints + floor(prayer / 2))`; `melee = 0.325 × (attack + strength)`; `range = 0.325 × floor(1.5 × ranged)`; `mage = 0.325 × floor(1.5 × magic)`; `floor(base + max(melee, range, mage))`. The WOM type `'regular'` maps to `'regular'`; `'unknown'` maps to `null`.
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 13: Game icons

Spec: Frontend → Game icons; Data sources → cache table (icons).

**Files:** Create `server/src/sources/icons.ts`, `server/src/routes/icons.ts`, `server/src/sources/icons.test.ts`, `client/src/components/Icon.tsx`

**Interfaces:**
- Produces: `GET /api/icons/wiki/:file` (e.g. `Attack_icon.png`) and `GET /api/icons/item/:id`, served with `Cache-Control: public, max-age=31536000, immutable`; `export function wikiIconFile(name: string, kind: 'skill' | 'boss'): string` (`'Vorkath' → 'Vorkath_icon.png'`, spaces → `_`); `<Icon kind="skill" name="Attack" />`, `<Icon kind="item" id={4151} />`.
- Sources: `https://oldschool.runescape.wiki/images/<file>` and `https://static.runelite.net/cache/item/icon/<id>.png`, fetched once through the requester and stored under `<dataDir>/icons/wiki/` and `<dataDir>/icons/item/`.
- `:file` must match `^[A-Za-z0-9_().'%-]+\.png$` and `:id` must be an integer (no path traversal).

- [x] **Step 1: Write the failing tests**: the first request fetches and writes the file, the second reads from disk with no fetch; `../x.png` → 400; `wikiIconFile("K'ril Tsutsaroth", 'boss') === "K'ril_Tsutsaroth_icon.png"`; a missing remote icon (404) → 404, nothing written.
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement**; `<Icon>` uses `image-rendering: pixelated` and an `alt` of the name.
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 14: Overview page, menu and add-account dialog

Spec: Frontend → Pages (Overview), Adding an account, Visual direction (stats tiles), Layout (menu).

**Files:** Create `shared/src/overview.ts`, `shared/src/osrs/statsLayout.ts`, `shared/src/osrs/statsLayout.test.ts`, `server/src/services/overview.ts`, `server/src/services/overview.test.ts`, `client/src/components/StatsTiles.tsx` (+ `.module.css`, test), `client/src/components/Menu.tsx`, `client/src/components/AddAccountDialog.tsx`, `client/src/pages/Overview/Overview.tsx`. Modify `server/src/routes/accounts.ts` (`GET /api/accounts/:id/overview`).

**Interfaces:**
- Produces:
  ```ts
  export const IN_GAME_ORDER = ['Attack','Hitpoints','Mining','Strength','Agility','Smithing','Defence','Herblore','Fishing','Ranged','Thieving','Cooking','Prayer','Crafting','Firemaking','Magic','Fletching','Woodcutting','Runecraft','Slayer','Farming','Construction','Hunter','Sailing'] as const;
  export function orderSkills<T extends { name: string }>(skills: T[]): T[]; // drops 'Overall'; known skills in IN_GAME_ORDER; unknown ones appended in response order
  export function isBoss(activityName: string, womBossMetrics: string[]): boolean; // compare lowercase letters+digits only: "K'ril Tsutsaroth" ~ 'kril_tsutsaroth'
  export type Overview = { account: Account; combatLevel: number | null; totalLevel: number | null; skills: { name: string; level: number; xp: number }[]; topKills: { name: string; kills: number }[]; allKills: { name: string; kills: number }[]; progress: { quests: { done: number; total: number } | null; diaryTiers: { done: number; total: number } | null; combatAchievements: { tier: string | null; points: number; nextTierPoints: number | null } | null; collectionLog: { obtained: number; total: number | null } | null }; worn: { slot: string; id: number; name: string }[]; freshness: Freshness[]; missing: { kind: SourceKind; fix: string }[] };
  ```
- `progress`, `worn` and `missing` stay `null` / empty until Tasks 17–19.
- `topKills`: the 5 highest boss scores above 0, from hiscores activities classified with `isBoss` against WOM's boss metrics.

- [x] **Step 1: Write the failing tests**
  - `orderSkills` of the Lynx Titan fixture puts `Attack`, `Hitpoints`, `Mining` first and `Sailing` last; with an extra `Testing` it comes last; `Overall` is dropped
  - `isBoss('Chambers of Xeric: Challenge Mode', ['chambers_of_xeric_challenge_mode'])` and `isBoss('TzKal-Zuk', ['tzkal_zuk'])` are true; `isBoss('Clue Scrolls (all)', [...])` is false
  - `topKills` has at most 5 entries, sorted by kills descending, none with kills ≤ 0
  - `StatsTiles` renders each skill's name next to its icon and level (`getByText('Attack')` and `getByText('90')` in the same tile)
- [x] **Step 2: Run** the test files. Expected: FAIL.
- [x] **Step 3: Implement** the service, the route, the stats tiles (dark: stone `#393227` tiles in a `#1f1c17` frame, names `#cfc3a8`, levels `#ffff00` in Silkscreen with a `1px 1px 0 #000` shadow; light: `#ebe2cb` tiles in a `#cdbd94` frame, names `#3d3122`, levels `#7a3a00` with a `1px 1px 0 #f7f0dd` shadow; 3 columns, total level under the grid), the Overview page (header with type, combat and total level; tiles; kill counts with boss icons, expandable; freshness and Refresh), the menu (accounts with Add account, then pages) and the add-account dialog (steps 1–5 of the spec).
- [ ] **Step 4: Verify** the tests PASS; with `npm run dev`, add a real account and see its tiles, kills and freshness.
- [x] **Step 5: Checkpoint.**

---

## Phase 3: Wiki, prices and local game data

Ends with: Overview's progress rows, and the Bank and gear and Collection log pages working, with Automatic and Manual updates.

### Task 15: Wiki source

Spec: Data sources → What each API offers (OSRS Wiki), Fetching and caching (wiki rows, Whole tables).

**Files:** Create `server/src/store/cache.ts`, `server/src/sources/wiki.ts`, `server/src/sources/wiki.test.ts`, fixtures in `server/test/fixtures/wiki/` (one per call below, captured from the live API). Modify `server/package.json` (`node-html-parser`).

**Interfaces:**
- Produces:
  ```ts
  export async function cached<T>(db: Kysely<DB>, key: string, kind: string, ttlMs: number, now: Date, load: () => Promise<T>): Promise<T>; // serves stale cache if load throws SourceError, rethrows if nothing cached
  export function wikiUrl(title: string, section?: string): string; // https://oldschool.runescape.wiki/w/Dragon_Slayer_II#Section
  export async function searchWiki(ctx: WikiCtx, query: string): Promise<{ title: string; snippet: string; url: string }[]>; // top 5
  export async function getSections(ctx: WikiCtx, title: string): Promise<{ index: string; line: string }[]>;
  export async function getSectionText(ctx: WikiCtx, title: string, index: string): Promise<{ title: string; section: string; text: string; url: string }>; // ≤ 4,000 chars, then "… (truncated; ask for a narrower section)"
  export async function latestRevisions(ctx: WikiCtx, titles: string[]): Promise<Record<string, number>>; // ≤ 50 titles per request
  export async function bucketQuery<T>(ctx: WikiCtx, query: string): Promise<T[]>;
  export async function expandTemplates(ctx: WikiCtx, text: string): Promise<string>;
  export type WikiCtx = { req: Requester; db: Kysely<DB>; now: () => Date };
  ```
- Endpoints (`https://oldschool.runescape.wiki/api.php`, `format=json&formatversion=2`): search `action=query&list=search&srsearch=&srlimit=5`; sections `action=parse&page=&prop=sections|revid`; section HTML `action=parse&page=&section=&prop=text&disableeditsection=1&disablelimitreport=1`; revisions `action=query&prop=revisions&rvprop=ids&titles=A|B`; Bucket `action=bucket&query=`; templates `action=expandtemplates&prop=wikitext&text=`.
- Page text: drop `sup.reference`, navboxes and edit links; keep headings, paragraphs, list items and table rows as `cell | cell`; links become their text.
- Page cache: key `page:<title>:<index>` with `revision`; older than 1 day → one `latestRevisions` call for all stale titles; re-download only changed pages.

- [x] **Step 1: Capture the fixtures** (search "Dragon Slayer II"; sections and section 1 of `Dragon_Slayer_II`; revisions for the 12 diary titles in `ARCHITECTURE.md` → Tools; Bucket `bucket('quest').select('page_name','requirements').where('page_name','Dragon Slayer II').run()`; expandtemplates of `{{Globals|ca elite points}}`).
- [x] **Step 2: Write the failing tests**: search returns `Dragon Slayer II` first with URL `https://oldschool.runescape.wiki/w/Dragon_Slayer_II`; section text has no `<` characters and is ≤ 4,000 + truncation note characters; a cached page 2 days old with an unchanged revision is not re-downloaded; with a changed revision it is; `cached` returns the stale value when `load` throws `SourceError`; `expandTemplates('{{Globals|ca elite points}}')` → `'1100'` from the fixture.
- [x] **Step 3: Run**. Expected: FAIL.
- [x] **Step 4: Implement.**
- [x] **Step 5: Run**: PASS.
- [x] **Step 6: Checkpoint.**

### Task 16: Prices and the item index

Spec: Data sources → What each API offers (OSRS Wiki prices); Tools → loose item matching.

**Files:** Create `server/src/sources/prices.ts`, `server/src/sources/prices.test.ts`, `server/src/items/itemIndex.ts`, `server/src/items/itemIndex.test.ts`, fixtures `server/test/fixtures/prices/mapping-sample.json` (20 items cut from `/mapping`), `latest-sample.json`.

**Interfaces:**
- Produces:
  ```ts
  export type MappingItem = { id: number; name: string; members: boolean; limit: number | null; value: number; highalch: number | null; lowalch: number | null; icon: string };
  export async function getMapping(ctx: WikiCtx): Promise<MappingItem[]>; // cached 1 day
  export async function getLatestPrices(ctx: WikiCtx): Promise<Map<number, { high: number | null; low: number | null }>>; // /latest, cached 5 min
  export function createItemIndex(items: { id: number; name: string }[]): { find(query: string, limit?: number): { id: number; name: string; score: number }[] };
  ```
- Matching: case-insensitive; exact name first; then every query word a prefix of a name word in order ("dragon scim" → Dragon scimitar); then substring.

- [x] **Step 1: Write the failing tests**: `find('dragon scim')[0].name === 'Dragon scimitar'`; `find('WHIP')[0].name === 'Abyssal whip'`; `find('zzz')` is empty; `/latest` is requested once within 5 min across two calls; prices above `2_147_483_647` round-trip unchanged.
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement** against `https://prices.runescape.wiki/api/v2/osrs/mapping` and `/latest`.
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 17: Character Export reader and update modes

Spec: RuneLite data (Character Export), including "When the files are read" and "Reading the files". Needs Task 0.

**Files:** Create `server/src/sources/characterExport.ts`, `server/src/sources/characterExport.schemas.ts`, `server/src/sources/characterExport.test.ts`, fixtures `server/test/fixtures/character-export/Sample Name/*.json` (copied from Task 0's folder: player renamed to `Sample Name`, bank cut to 12 items, seed vault to 5), `client/src/data/useFileCheck.ts`. Modify `server/src/routes/accounts.ts` (`POST /api/accounts/:id/files/check`), `server/src/services/accounts.ts` (lookup's `characterExport`).

**Interfaces:**
- Produces:
  ```ts
  export const CE_FILES = { ce_character: 'character.json', ce_quests: 'quests.json', ce_diaries: 'diaries.json', ce_combat_achievements: 'combat_achievements.json', ce_bank: 'bank.json', ce_seed_vault: 'seed_vault.json', ce_inventory: 'inventory.json', ce_equipment: 'equipment.json' } as const;
  export async function findAccountFolder(runeliteDir: string, key: string): Promise<string | null>; // matches folder names by nameKey
  export async function checkFiles(deps: { db: Kysely<DB>; runeliteDir: string; timeZone: string; sleep?: (ms: number) => Promise<void> }, account: AccountRow): Promise<{ changed: SourceKind[]; missing: SourceKind[]; errors: { kind: SourceKind; message: string }[] }>;
  export const MISSING_FIX: Partial<Record<SourceKind, string>>; // e.g. ce_bank: 'Open your bank in game so Character Export saves it.'
  export type DiaryTier = 'easy' | 'medium' | 'hard' | 'elite';
  export type DiaryTierData = { complete: boolean; tasksDone: number; tasks: { name: string; complete: boolean }[] | null; namesAsOf: string | null; namesStale: boolean };
  export function mergeDiaryNames(latest: CeDiaries, earlier: { data: CeDiaries; takenAt: string }[]): Record<string, Record<DiaryTier, DiaryTierData>>;
  // Per area and tier: `tasks` from the latest file when present (namesAsOf = its exported_at), else from the most recent earlier snapshot that has them (namesAsOf = that snapshot's taken_at), else null. namesStale = names exist and their completed count ≠ tasksDone.
  ```
- File formats, confirmed against real files from plugin v0.6.0 (schemas use `.passthrough()`; the raw text is what gets stored):
  - Every file: `exported_at` (ISO with offset and up to 9 fractional digits, e.g. `2026-10-27T18:49:51.806569700-06:00`; `new Date()` parses it), `plugin_version`, `session_id`, `reason`.
  - `character.json`: `account_name`, `world`, `game_state`, `world_types` (e.g. `['MEMBERS']`), `stats`: skill name → `{ real_level, boosted_level, experience }` (24 skills, `Attack` … `Sailing`).
  - `quests.json`: `summary { finished, in_progress, not_started }`, `quests[] { id, name, state }` with `state` one of `FINISHED`, `IN_PROGRESS`, `NOT_STARTED`.
  - `diaries.json`: `summary { tiers_complete, tiers_possible, note }`, `diaries`: area name (`Ardougne`, …, `Kourend & Kebos`, `Lumbridge & Draynor`, `Western Provinces`, `Wilderness`) → lowercase tier (`easy`, `medium`, `hard`, `elite`) → `{ complete, tasks_done, tasks[] { name, complete } }`.
  - `combat_achievements.json`: `summary { total_tasks_completed, total_tiers_completed, named_data_available }`, `tiers`: lowercase tier (`easy` … `grandmaster`) → `{ complete, tasks_completed, tasks_total, tasks[] { id, name, complete } }`.
  - `bank.json`, `seed_vault.json`, `inventory.json`, `equipment.json`: `kind`, `item_count`, `items[] { slot, id, quantity, name }`. Inventory and equipment list only occupied slots. `seed_vault.json` hasn't been seen on a real account yet; the plugin writes it with the same code as the bank (`SEED_VAULT("seed_vault", "seed_vault.json", …)` in its source), so expect `kind: 'seed_vault'` and the same item shape. Its fixture is synthetic until a real one exists.
  - Named diary task lists can vanish from later exports: on 2026-10-27 a rewrite after re-logging kept `tasks` only for Karamja; the other tiers had `complete` and `tasks_done` but no `tasks` key.
  - `collection_log.json` exists but is ignored (Temple is the source).
- Inventory, equipment and seed vault files only appear after those containers change, or after pressing **Sync Available** in Character Export's side panel. Their `MISSING_FIX` text: inventory and equipment `Change your inventory or gear in game, or press Sync Available in Character Export's side panel.`; seed vault `Open your seed vault so Character Export saves it.`
- Reading: compare each file's `mtime` with `source_state.file_mtime`; read only changed files; on invalid JSON wait 250 ms and retry, 3 attempts in total, then `markSourceError` and keep the old data.
- `useFileCheck(accountId)`: in Automatic mode, calls the endpoint every `pollSeconds` while `document.visibilityState === 'visible'`, then invalidates the account's queries when anything changed; in Manual mode, only Refresh calls it. Chat turns call `checkFiles` server-side before answering (Task 28).

- [x] **Step 1: Write the failing tests** (temp dirs; fake `sleep`):
  - a folder named `Sample\u00a0Name` is found for `nameKey('sample_name')` (Review Focus 1)
  - a second `checkFiles` with no `mtime` changes reads nothing (spy on `readFile`)
  - a bank file that's invalid JSON on the first read and valid on the second is saved; `changed` includes `ce_bank` (Review Focus 3)
  - a file still invalid after 3 attempts → `errors` has it, the previous data is kept
  - no `bank.json` → `missing` includes `ce_bank`, and `MISSING_FIX.ce_bank` is the text above
  - every fixture file parses with its schema, and `exported_at` `2026-10-27T18:49:51.806569700-06:00` becomes `2026-10-28T00:49:51.806Z`
  - a folder with only the six files Task 0 produced → `missing` is exactly `ce_seed_vault`, `ce_inventory`, `ce_equipment`, each with its fix text
  - `mergeDiaryNames`: an earlier snapshot with Ardougne `easy` names (10 tasks) and a latest file without them → Ardougne `easy` keeps the 10 names with `namesAsOf` = the earlier snapshot's time; Karamja names come from the latest file; when `tasks_done` is higher than the names' completed count, `namesStale` is true
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Verify** the tests PASS; in the app, play with Automatic mode on and see Overview update within `pollSeconds`.
- [x] **Step 5: Checkpoint.**

### Task 18: Temple source

Spec: Data sources → What each API offers (TempleOSRS).

**Files:** Create `server/src/sources/temple.ts`, `server/src/sources/temple.test.ts`, fixtures `server/test/fixtures/temple/clog-mikael.json` (`player_collection_log.php?player=Mikael&categories=all&includenames=1&includemissingitems=1`, trimmed to 3 categories), `categories.json` (`categories.php`).

**Interfaces:**
- Produces:
  ```ts
  export type TempleTab = 'bosses' | 'raids' | 'clues' | 'minigames' | 'other';
  export type CollectionLog = { lastChecked: string | null; lastChanged: string | null; obtained: number; total: number; categories: { key: string; tab: TempleTab; name: string; items: { id: number; name: string; count: number; date: string | null; obtained: boolean }[] }[] };
  export async function getCollectionLog(req: Requester, rsn: string): Promise<CollectionLog | null>; // null when the player has never synced
  export async function getCategoryTabs(ctx: WikiCtx): Promise<Record<string, TempleTab>>; // from categories.php, cached 1 day
  ```
- Base `https://templeosrs.com/api/collection-log/`. Category display names come from the key (`vorkath` → `Vorkath`, `chambers_of_xeric` → `Chambers of Xeric`). Fill the lookup's `temple` field.

- [x] **Step 1: Capture the fixtures.**
- [x] **Step 2: Write the failing tests**: the fixture gives `obtained === 587`, `total === 1734`; every category gets a tab; an item with a count has `obtained: true` and its date; the "never synced" response → `null`.
- [x] **Step 3: Run**. Expected: FAIL.
- [x] **Step 4: Implement.**
- [x] **Step 5: Run**: PASS.
- [x] **Step 6: Checkpoint.**

### Task 19: Overview progress rows and combat achievement tiers

Spec: Frontend → Overview; Goals → Combat achievements.

**Files:** Create `server/src/calc/combatAchievements.ts`, `server/src/calc/combatAchievements.test.ts`. Modify `server/src/services/overview.ts`, `client/src/pages/Overview/Overview.tsx`.

**Interfaces:**
- Produces:
  ```ts
  export type CaTier = 'Easy' | 'Medium' | 'Hard' | 'Elite' | 'Master' | 'Grandmaster';
  export type CaThresholds = Record<CaTier, { pointsPerTask: number; pointsRequired: number }>;
  export async function getCaThresholds(ctx: WikiCtx): Promise<CaThresholds>; // one expandtemplates call, cached 1 day
  export function caProgress(completedByTier: Record<CaTier, number>, t: CaThresholds): { points: number; tier: CaTier | null; nextTier: CaTier | null; nextTierPoints: number | null };
  ```
- Thresholds come from `{{Globals|ca <t> points}}`; points per task = `{{Globals|ca <t> task points}}` ÷ `{{Globals|ca <t> tasks}}`, with `<t>` in `easy, medium, hard, elite, master, gm`. On 2026-10-27 the required points were 41, 169, 436, 1100, 1965, 2697.

- Collection log row: from Temple; when Temple has no data, `obtained` falls back to the hiscores' `Collections Logged` score with `total: null` (shown as "812 logged, sync Temple for details").
- [x] **Step 1: Write the failing tests**: with the fixture thresholds, completed `{ Easy: 41, Medium: 64, Hard: 89, Elite: 0, … }` and points per task 1, 2, 3 → `points === 41 + 128 + 267 === 436`, `tier === 'Hard'`, `nextTier === 'Elite'`, `nextTierPoints === 1100`; the Overview service fills `quests`, `diaryTiers`, `combatAchievements` and `collectionLog` from the fixtures; with no Temple data, `collectionLog` is `{ obtained: <Collections Logged score>, total: null }`; `missing` lists `ce_bank` with its fix when there's no bank.
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement**, and show the four rows with icons (`Quest_point_icon.png`, `Achievement_Diaries_icon.png`, `Combat_achievements_icon.png`, `Collection_log.png`), the worn gear row, and each `missing` entry's fix.
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

### Task 20: Bank and gear page

Spec: Frontend → Pages (Bank and gear); Tools → `get_bank`, `get_gear`.

**Files:** Create `shared/src/bank.ts`, `server/src/services/bank.ts`, `server/src/services/bank.test.ts`, `client/src/pages/BankGear/BankGear.tsx` (+ `.module.css`). Modify `server/src/routes/accounts.ts` (`GET /api/accounts/:id/bank?search=`).

**Interfaces:**
- Produces:
  ```ts
  export type OwnedItem = { id: number; name: string; quantity: number; where: 'bank' | 'seed_vault' | 'inventory' | 'equipment'; slot: number | null; unitPrice: number | null };
  export type BankView = { bankSeenAt: string | null; totalValue: number | null; mostValuable: OwnedItem[]; worn: OwnedItem[]; inventory: (OwnedItem | null)[] /* 28 */; search: OwnedItem[] | null; ironmanNote: boolean };
  export async function getBankView(deps, accountId: number, search: string | null): Promise<BankView>;
  ```
- Value: quantity × the `/latest` high price, else low, else the mapping `value`; coins (`id 995`) count at 1 each. `mostValuable`: top 8. `search` uses the item index across all four containers. `ironmanNote` is true for every type except `regular`.
- Worn layout (3 columns × 5 rows): head; cape, neck, ammo; weapon, body, shield; legs; hands, feet, ring.
- Equipment `slot` numbers (confirmed on real files): 0 head, 1 cape, 2 neck, 3 weapon, 4 body, 5 shield, 7 legs, 9 hands, 10 feet, 12 ring, 13 ammo. A two-handed weapon leaves 5 empty. Inventory items carry their slot (0–27); fill the 28-slot array by `slot`, `null` elsewhere.

- [x] **Step 1: Write the failing tests**: total value from the fixture equals the hand-computed sum; `mostValuable[0]` is the priciest stack; `search('blood')` finds the blood runes with `where: 'bank'`; inventory items at slots 0, 1, 3, 4 and 10 give a 28-entry array with `null` at the other 23; an equipment item with `slot: 13` lands in the ammo position and slot 5 stays empty for a two-handed weapon; an ironman account has `ironmanNote: true`.
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement** the service and the page as in the approved mockup.
- [x] **Step 4: Run**: PASS; check the page in the app.
- [x] **Step 5: Checkpoint.**

### Task 21: Collection log page

Spec: Frontend → Pages (Collection log).

**Files:** Create `client/src/pages/CollectionLog/CollectionLog.tsx` (+ `.module.css`, test). Modify `server/src/routes/accounts.ts` (`GET /api/accounts/:id/collection-log` → `CollectionLog`).

- [x] **Step 1: Write the failing test**: with the Temple fixture, the Bosses tab lists entries with `obtained of total`; a complete entry has the done class; selecting an item shows `First obtained <date>` in the user's time zone; missing items render greyed (`data-missing="true"`).
- [x] **Step 2: Run**. Expected: FAIL.
- [x] **Step 3: Implement** tabs Bosses, Raids, Clues, Minigames, Other; the entry list; the item grid with icons and counts; totals and "Synced with Temple <relative time>".
- [x] **Step 4: Run**: PASS.
- [x] **Step 5: Checkpoint.**

---

## Phase 4: Calculations

Ends with: XP, requirement and gear-upgrade calculations tested against real wiki data (they power goals and the AI).

### Task 22: XP and time estimates

Spec: Tools → `calc_xp`; Goals → Skill.

**Files:** Create `shared/src/osrs/xp.ts`, `shared/src/osrs/xp.test.ts`, `server/src/calc/estimates.ts`, `server/src/calc/estimates.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function xpForLevel(level: number): number; // 1–126 virtual levels
  export function levelForXp(xp: number): number;
  export function hoursToTarget(rates: SkillRates, fromXp: number, toXp: number): { hours: number; methods: string[] }; // walks rate brackets
  ```

- [ ] **Step 1: Write the failing tests**: `xpForLevel(2) === 83`, `xpForLevel(70) === 737627`, `xpForLevel(75) === 1210421`, `xpForLevel(99) === 13034431`; `levelForXp(850000) === 71`; with the mining rates fixture, 0 → 35,025 XP is `35025 / 20000` hours with methods `['Quests']`, and a range across the 35,025 boundary sums both brackets.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** the standard formula: `xpForLevel(L) = floor(Σ_{l=1}^{L-1} floor(l + 300 × 2^(l/7)) / 4)`.
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 23: Quest and diary requirement checks

Spec: Tools → `check_quest_requirements`, `check_diary_requirements`; Data sources (Quest bucket, diary pages).

**Files:** Create `server/src/calc/requirements.ts`, `server/src/calc/requirements.test.ts`, fixtures `server/test/fixtures/wiki/quest-dragon-slayer-ii.json` (Task 15's Bucket capture), `diary-ardougne.wikitext` (`Ardougne_Diary?action=raw`).

**Interfaces:**
- Produces:
  ```ts
  export type SkillReq = { skill: string; level: number; boostable: boolean; toStart: boolean };
  export type QuestReqs = { quest: string; skills: SkillReq[]; questPoints: number | null; quests: { name: string; children: QuestReqs['quests'] }[]; other: string[]; url: string };
  export function parseQuestRequirements(quest: string, requirementsHtml: string): QuestReqs;
  export type DiaryTask = { tier: 'Easy' | 'Medium' | 'Hard' | 'Elite'; number: number; task: string; skills: SkillReq[]; quests: string[]; other: string[] };
  export function parseDiaryPage(area: string, wikitext: string): DiaryTask[];
  export type Check = { met: boolean; skills: (SkillReq & { have: number; met: boolean })[]; quests: { name: string; state: 'finished' | 'in_progress' | 'not_started' | 'unknown'; met: boolean }[]; questPoints: { need: number; have: number; met: boolean } | null; unchecked: string[]; url: string };
  export function checkQuest(reqs: QuestReqs, account: { levels: Record<string, number>; quests: Record<string, string>; questPoints: number }): Check;
  export function checkDiaryTier(tasks: DiaryTask[], tier: DiaryTask['tier'], account: { levels: Record<string, number>; quests: Record<string, string> }): Check & { tasks: { number: number; task: string; met: boolean }[] };
  export async function loadAllQuestRequirements(ctx: WikiCtx): Promise<Map<string, QuestReqs>>; // bucket('quest').select('page_name','requirements').limit(2000).run(), cached 1 day
  export async function loadDiaryPages(ctx: WikiCtx): Promise<Map<string, DiaryTask[]>>; // the 12 titles, cached by revision
  ```
- Quest parsing: skills from `data-skill="<Skill>" data-level="<n>"`, with `not boostable` and `required to start` read from the `<sup>` right after; `Quest points` becomes `questPoints`; the list under "Completion of the following quests" becomes a tree by `*` depth, taking each line's first `[[link]]`; any other line goes to `other` with `[[a|b]]` → `b` and tags stripped.
- Diary parsing: per `data-diary-tier="<Tier>"` table, each row is a task cell (number and text) and a requirements cell; `{{SCP|<Skill>|<n>}}` gives skills (`{{SCP|Quest}}` marks quest lines), `[[Quest name]]` links on quest lines give quests, anything else goes to `other`.
- Unparsed requirements are never dropped: they land in `other` / `unchecked`.

- [ ] **Step 1: Write the failing tests**
  - Dragon Slayer II: 9 skills including `{ skill: 'Magic', level: 75, boostable: false, toStart: true }`; `questPoints === 200`; top-level quests include Legends' Quest, Dream Mentor, A Tail of Two Cats, Animal Magnetism, Ghosts Ahoy, Bone Voyage and Client of Kourend; `other` contains the pyre ship (Barbarian Training) line, and `100 Kudos` appears somewhere in the tree's `other` or `unchecked`
  - `checkQuest` with Magic 71 and Dream Mentor not started → `met: false`; Magic shows `have: 71, met: false`; Dream Mentor `met: false`
  - Ardougne Easy task 1 requires the quest Rune Mysteries; `checkDiaryTier` for Easy with Rune Mysteries unfinished → task 1 `met: false`
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 24: Gear upgrades and item info

Spec: Tools → `find_gear_upgrades`, `get_item_info`, `get_prices`.

**Files:** Create `server/src/calc/gear.ts`, `server/src/calc/gear.test.ts`, `server/src/services/itemInfo.ts`, `server/src/services/itemInfo.test.ts`, fixtures `server/test/fixtures/wiki/recommended-vorkath.json` (`bucket('recommended_equipment').select('page_name','page_name_sub','json').where('page_name','Vorkath/Strategies').run()`), `bonuses-abyssal-whip.json`, `drops-draconic-visage.json`.

**Interfaces:**
- Produces:
  ```ts
  export type RecommendedSetup = { page: string; style: string; slots: Record<string, string[][]> }; // slot → tiers (best first) → alternative item names
  export function parseRecommended(row: { page_name: string; json: string }): RecommendedSetup;
  export function findUpgrades(setup: RecommendedSetup, owned: Set<string>, prices: (name: string) => number | null, opts: { budget: number | null; canBuy: boolean }): { slot: string; current: string | null; upgrades: { name: string; price: number | null; buyable: boolean }[] }[]; // up to 3 better items per slot
  export async function getItemInfo(ctx: WikiCtx, names: string[]): Promise<{ name: string; stats: Record<string, number | string> | null; price: number | null; limit: number | null; members: boolean | null; dropSources: { source: string; rarity: string; quantity: string }[] }[]>; // ≤ 5 drop sources per item
  ```
- Tier strings: alternatives split on ` / `; item names from `[[Name|Text]]` links; strip `'"\`UNIQ--ref-…-QINU\`"'` markers. "Better" means a tier above the best tier containing an owned item. `canBuy` is false for every type except `regular`; then `buyable: false` and prices are shown for reference only.
- Stats from `bucket('infobox_bonuses')`; drops from `bucket('dropsline').select('page_name','item_name','drop_json').where('item_name', <name>)` using `Dropped from`, `Rarity` and `Drop Quantity`.

- [ ] **Step 1: Write the failing tests**: the Vorkath fixture's `head` slot first tier contains `Masori mask (f)` and `Void ranger helm`; owning `Crystal helm` → `head` upgrades are from the tiers above it, at most 3; a budget filters out items priced over it; with `canBuy: false` every upgrade is `buyable: false`; `getItemInfo(['Draconic visage'])` lists `King Black Dragon` at `1/5,000`; the whip's `slash_attack_bonus` is present.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 5: This week and goals

Ends with: the This week and Goals pages working on real data.

### Task 25: This week

Spec: Frontend → Pages (This week); Data sources → where This week's data comes from; Tools → `get_gains`.

**Files:** Create `shared/src/gains.ts`, `server/src/services/gains.ts`, `server/src/services/gains.test.ts`, `client/src/pages/ThisWeek/ThisWeek.tsx` (+ `.module.css`). Modify `server/src/routes/accounts.ts` (`GET /api/accounts/:id/gains?period=day|week|month` or `?start=&end=`).

**Interfaces:**
- Produces:
  ```ts
  export type Gains = { start: string; end: string; summary: string; skills: { name: string; xpGained: number; levelFrom: number; levelTo: number }[]; kills: { name: string; gained: number; icon: string }[]; progress: { kind: 'quest' | 'diary' | 'combat_achievement' | 'achievement' | 'goal'; title: string; at: string }[]; newCollectionLogItems: { id: number; name: string; at: string }[] };
  export async function buildGains(deps, accountId: number, range: { period: 'day' | 'week' | 'month' } | { start: string; end: string }, now: Date): Promise<Gains>;
  ```
- XP and kills come from WOM gains (`day`, `week` and `month` map to WOM periods; custom ranges use `startDate`/`endDate`). Progress items come from diffing the first and last `every_change` snapshots of `ce_quests`, `ce_diaries` and `ce_combat_achievements` inside the range, Wise Old Man achievements created inside it (kind `achievement`, e.g. "99 Slayer"), and goals completed in it. New log items: Temple items whose `date` falls inside the range. Summary: `"<XP> XP, <kills> boss kills and <n> new collection log items in the last 7 days."` with compact numbers (`1.24M`).

- [ ] **Step 1: Write the failing tests**: with two quest snapshots where Monkey Madness II goes `in_progress` → `finished`, `progress` contains `{ kind: 'quest', title: 'Completed Monkey Madness II' }` dated at the later snapshot; a WOM achievement created inside the range appears with kind `achievement`, one outside it doesn't; skills with 0 XP gained are omitted and the rest sorted by XP descending; the summary formats `1240000` as `1.24M`; Temple items outside the range are excluded.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** the service and the page (period chips Today, 7 days, 30 days, Custom; sections Experience, Kills and clues, Progress, New collection log items).
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 26: Goals model, progress and API

Spec: Goals.

**Files:** Create `shared/src/goals.ts`, `server/src/goals/progress.ts`, `server/src/goals/progress.test.ts`, `server/src/goals/goalsService.ts`, `server/src/routes/goals.ts`, `server/src/routes/goals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GoalTarget =
    | { kind: 'skill'; skill: string; level?: number; xp?: number; startXp: number }
    | { kind: 'quest'; quest: string }
    | { kind: 'diary'; area: string; tier: 'Easy' | 'Medium' | 'Hard' | 'Elite' }
    | { kind: 'combat_achievement'; task?: string; tier?: CaTier }
    | { kind: 'boss_kills'; boss: string; kills: number }
    | { kind: 'collection_log'; item?: string; entry?: string }
    | { kind: 'item'; item: string }
    | { kind: 'custom' };
  export type Goal = { id: number; title: string; target: GoalTarget; status: 'active' | 'done' | 'dropped'; position: number; createdAt: string; completedAt: string | null };
  export type GoalProgress = { done: boolean; fraction: number | null; detail: string; stillNeeded: { label: string; status: 'red' | 'yellow' }[] };
  export type AccountData = { account: AccountRow; levels: Record<string, { level: number; xp: number }>; quests: Record<string, 'finished' | 'in_progress' | 'not_started'>; questPoints: number; diaries: Record<string, Record<DiaryTier, DiaryTierData>> /* from mergeDiaryNames (Task 17); the wiki's tier names are capitalized ('Easy'), Character Export's lowercase ('easy') */; combatAchievements: { id: number; name: string; tier: CaTier; complete: boolean }[]; kills: Record<string, number>; collectionLog: CollectionLog | null; owned: OwnedItem[]; rates: SkillRates[] | null /* Wise Old Man efficiency rates for the account's type */ };
  export async function loadAccountData(deps, accountId: number): Promise<AccountData>; // one place that assembles every source; goals and tools (Task 29) both use it
  export function goalProgress(target: GoalTarget, data: AccountData): GoalProgress;
  export async function syncGoalCompletion(deps, accountId: number, now: Date): Promise<Goal[]>; // marks reached goals done with completedAt; returns the newly completed ones
  ```
- Routes: `GET /api/accounts/:id/goals` (each with progress); `POST` (sets `startXp` for skill goals from current XP); `PATCH /api/goals/:id` (`title`, `status` done/active/dropped, `position`); `POST /api/accounts/:id/goals/reorder` `{ ids: number[] }`.
- `syncGoalCompletion` runs after every refresh and file check. Custom goals only complete by hand.
- Skill detail text: `Level 71. 360k XP to go, about 6 hours at efficient rates.` (hours from Task 22, rounded; omitted without rates).

- [ ] **Step 1: Write the failing tests**: skill goal 75 Magic with `startXp 814445`, current XP 850000 → `fraction ≈ 0.0898`, detail starts `Level 71. 360k XP to go`; a quest goal for Dragon Slayer II lists Magic 75 and Dream Mentor in `stillNeeded`; reaching a boss-kill target marks the goal done on sync with `completedAt` set; a custom goal never auto-completes; reorder persists positions; a dropped goal disappears from active but is still returned with `status 'dropped'`.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 27: Goals page

Spec: Goals → Page; the approved mockup.

**Files:** Create `client/src/pages/Goals/Goals.tsx` (+ `.module.css`, test), `client/src/pages/Goals/AddGoalDialog.tsx`.

**Interfaces:**
- Consumes: Task 26's routes. "Suggest goals" calls `onSuggestGoals()`, which Task 32 wires to the chat; until then the button is present but disabled with the tooltip "Available once the chat is set up".

- [ ] **Step 1: Write the failing tests**: active goals render in `position` order with their progress text; dragging (keyboard: select, then Alt+↑) calls reorder with the new order; Done lists title and date; the Add goal dialog's kind picker offers the 8 kinds.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** as in the approved mockup (drag handle, kind label, progress bar for skill and combat achievement goals, "Still needed" with status dots, "Ask the AI for a plan" link, custom checkbox, Done list).
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 6: The AI chat

Ends with: chatting about an account with tools, sources, approvals and Stop, billed to the user's plan.

### Task 28: Provider interface, chat service and SSE routes

Spec: AI layer (Provider interface, Streaming, Writes need approval, Sources, Context, Stored); Frontend → Chat column.

**Files:** Create `shared/src/chat.ts`, `server/src/ai/provider.ts`, `server/src/ai/fakeProvider.ts`, `server/src/ai/chatService.ts`, `server/src/ai/chatService.test.ts`, `server/src/routes/chats.ts`, `server/src/routes/chats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ToolContext = { accountId: number; timeZone: string; now: Date; addSource(page: { title: string; url: string }): void };
  export type ToolDef = { name: string; description: string; input: z.ZodRawShape; readOnly: boolean; label(args: any): string; summary?(args: any): string; run(args: any, ctx: ToolContext): Promise<unknown> };
  export type TurnInput = { systemPrompt: string; message: string; providerSessionId: string | null; tools: ToolDef[]; toolContext: ToolContext; settings: Pick<Settings, 'model' | 'effort' | 'maxTurns' | 'billing' | 'budgetUsd'>; requestApproval(req: { toolName: string; summary: string }): Promise<boolean>; signal: AbortSignal };
  export type ProviderEvent =
    | { type: 'session'; providerSessionId: string }
    | { type: 'text'; delta: string }
    | { type: 'tool_started'; id: string; name: string; input: unknown }
    | { type: 'tool_finished'; id: string; isError: boolean }
    | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }
    | { type: 'error'; message: string };
  export interface ChatProvider { runTurn(input: TurnInput): AsyncIterable<ProviderEvent> }
  export type ChatEvent = // what the browser receives over SSE
    | { type: 'text'; delta: string }
    | { type: 'tool'; id: string; label: string; status: 'started' | 'done' | 'error' }
    | { type: 'approval'; requestId: string; summary: string }
    | { type: 'approval_resolved'; requestId: string; approved: boolean }
    | { type: 'sources'; pages: { title: string; url: string }[] }
    | { type: 'usage'; tokens: number; costUsd: number | null; billing: 'plan' | 'api_key' }
    | { type: 'error'; message: string; fix: string | null }
    | { type: 'done'; messageId: number };
  ```
- Routes: `GET /api/accounts/:id/chats`; `POST /api/accounts/:id/chats` → new session; `PATCH /api/chats/:id` `{ title }`; `DELETE /api/chats/:id`; `GET /api/chats/:id/messages`; `POST /api/chats/:id/messages` `{ text }` → `text/event-stream` of `ChatEvent`s (`data: <json>\n\n`); `POST /api/chats/:id/approvals/:requestId` `{ approve: boolean }`; `POST /api/chats/:id/stop`.
- Before each turn: run Task 17's `checkFiles` for the account (both update modes) and `syncGoalCompletion`. The first user message (first 60 characters) titles the session. The assistant message is stored when the turn ends, including after Stop or an error, with `content` `{ text, tools, approvals, sources }` and `usage`.
- Error fixes: a provider error mentioning `login`, `not logged in` or `authentication` → `fix: 'Claude Code isn't signed in on this computer. Open a terminal, run claude, then type /login and sign in with your Claude plan. Or switch billing to an API key in Settings.'`.
- Stop aborts the turn's `AbortController` and declines any pending approvals.

- [ ] **Step 1: Write the failing tests** (with `fakeProvider`, which plays a scripted list of `ProviderEvent`s and calls `requestApproval` when told to):
  - text deltas reach the SSE stream in order and the stored message's `text` is their concatenation
  - a tool that calls `ctx.addSource` twice for the same page yields one `sources` entry
  - an approval request emits `approval`; posting `{ approve: true }` resolves it and emits `approval_resolved`
  - Stop mid-turn ends the stream with `done`, stores the partial text, and declines a pending approval
  - a provider `error` "Not logged in · Please run /login" → `ChatEvent` error with the fix text above
  - a turn runs `checkFiles` first (spy), and a tool reading a failed source still lets the turn finish (Review Focus 4)
  - the session title is the first message cut to 60 characters
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 29: Tools

Spec: AI layer → Tools (every tool and "Rules for every tool").

**Files:** Create `server/src/ai/tools/account.ts`, `server/src/ai/tools/calculations.ts`, `server/src/ai/tools/knowledge.ts`, `server/src/ai/tools/goals.ts`, `server/src/ai/tools/index.ts`, `server/src/ai/tools/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 11–26.
- Produces: `export function buildTools(deps): ToolDef[]` returning, in this fixed order: `get_account_overview`, `get_boss_kills`, `get_quests`, `get_diaries`, `get_combat_achievements`, `get_collection_log`, `get_gains`, `get_bank`, `get_gear`, `check_quest_requirements`, `check_diary_requirements`, `calc_xp`, `find_gear_upgrades`, `search_wiki`, `get_wiki_page`, `get_item_info`, `get_prices`, `list_goals`, `add_goal`, `update_goal`. Only `add_goal` and `update_goal` have `readOnly: false` and a `summary` (`Add goal: Reach 75 Magic (skill)`).
- Every result is an object with `asOf` (ISO) and, when relevant, `stale` (`{ kind, error }[]`) and `missing` (`{ kind, fix }[]`). Knowledge tools call `ctx.addSource` for every page they read. `get_wiki_page` with no `section` returns the section list.
- Labels: `get_quests` → `Checking your quests…`, `get_wiki_page` → `Reading wiki: <title>…`, `check_quest_requirements` → `Checking requirements for <quest>…`; the others follow the same pattern.

- [ ] **Step 1: Write the failing tests**: the tool names and order match the list; every tool's input schema is a Zod object; for a fixture account each read tool's JSON is under 8,000 characters (a 900-item bank included: `get_bank` without `search` returns only the summary); `get_wiki_page` adds a source; `get_account_overview` with no bank lists `missing: [{ kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' }]`; `check_quest_requirements('Dragon Slayer II')` returns `met: false` with the Magic and Dream Mentor gaps; `calc_xp` returns the XP and hours from Task 22.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 30: Instructions

Spec: AI layer → Instructions.

**Files:** Create `server/src/ai/instructions.ts`, `server/src/ai/instructions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function buildSystemPrompt(account: { name: string; type: AccountType }): string; // the 9 rules of ARCHITECTURE.md → Instructions, as plain prose
  export function turnHeader(now: Date, timeZone: string): string; // 'Local time: Tuesday 27 October 2026, 17:00 (America/Chicago)'
  export function composeMessage(now: Date, timeZone: string, text: string): string; // header, blank line, text
  ```

- [ ] **Step 1: Write the failing tests**: the prompt names the account and its type; it mentions the Grand Exchange restriction, citing wiki pages, asking before guessing, declining botting and real-world trading, and approval before adding goals; it contains no date or time (`not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/)`, so the cached prefix stays stable); it's identical across two calls; `turnHeader(new Date('2026-10-27T22:00:00Z'), 'America/Chicago')` equals the example above.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 31: Claude provider (Agent SDK)

Spec: AI layer → Claude runs through the Claude Agent SDK, Agent SDK setup, Defaults, Writes need approval.

**Files:** Create `server/src/ai/claudeProvider.ts`, `server/src/ai/claudeProvider.test.ts`. Modify `server/package.json`: `@anthropic-ai/claude-agent-sdk@^0.3.312`, `zod@^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` (the SDK's peers). Modify `server/src/main.ts` (wire it into the chat service; working folder `<dataDir>/claude/`, created at startup).

**Interfaces:**
- Consumes: `query`, `tool`, `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`; Tasks 28–30.
- Produces: `export function createClaudeProvider(deps: { query: typeof query; cwd: string; env: NodeJS.ProcessEnv; apiKey: string | null }): ChatProvider;` (`query` is injected so tests never reach Claude).
- `query` options per turn:
  - `systemPrompt` (string from Task 30), `tools: []`, `settingSources: []`, `includePartialMessages: true`, `model`, `effort`, `maxTurns`, `cwd`, `resume: providerSessionId` when set, `abortController` (aborted on the turn's signal)
  - `mcpServers: { osrs: { ...createSdkMcpServer({ name: 'osrs', version, tools: sdkTools, alwaysLoad: true }), tools: [{ name: 'add_goal', permission_policy: 'always_ask' }, { name: 'update_goal', permission_policy: 'always_ask' }] } }`, `allowedTools: ['mcp__osrs__*']`
  - each `ToolDef` becomes `tool(name, description, input, handler, { annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } })`; the handler returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`, or `isError: true` with the message on failure
  - `canUseTool(toolName, input)`: for `mcp__osrs__add_goal` / `mcp__osrs__update_goal`, `requestApproval({ toolName, summary })` → `{ behavior: 'allow', updatedInput: input }` or `{ behavior: 'deny', message: 'The user declined this change.' }`; anything else → deny
  - `env`: billing `plan` → a copy of `env` without `ANTHROPIC_API_KEY`; `api_key` → `env` plus `ANTHROPIC_API_KEY` and `CLAUDE_CODE_PROMPT_CACHE_TTL: '1h'`, and `maxBudgetUsd: budgetUsd` when set
- Message mapping: `system`/`init` → `session` (with `session_id`); `stream_event` with a `content_block_delta` / `text_delta` → `text`; `assistant` `tool_use` blocks → `tool_started`; `user` `tool_result` blocks → `tool_finished` (`is_error`); `result` → `usage` (`usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `total_cost_usd`), and error subtypes → `error` with `errors.join('; ')`.

- [ ] **Step 1: Write the failing tests** with a fake `query` that records its options and yields scripted SDK messages:
  - options include `tools: []`, `settingSources: []`, `allowedTools: ['mcp__osrs__*']`, `model: 'claude-opus-5-5'`, `effort: 'medium'`, `maxTurns: 20`, the given `cwd`, and `resume` only when a session id exists
  - billing `plan` with `ANTHROPIC_API_KEY` in `env` → the passed `env` has no `ANTHROPIC_API_KEY`; billing `api_key` → it's present and `maxBudgetUsd` equals the setting
  - the scripted stream maps to `session`, `text` × n, `tool_started`, `tool_finished`, `usage` in order
  - `canUseTool('mcp__osrs__add_goal', …)` with approval false → `{ behavior: 'deny', … }`; with true → allow with the same input
  - aborting the turn's signal aborts the `abortController` passed to `query`
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Manual check (ask the user first; it uses their plan):** in `npm run dev`, ask "What should I work on next?" for a real account; tools run, the answer cites wiki pages, usage shows "on your plan". Check that Claude Code's session for it appears under the `<dataDir>/claude` project, not a coding project.
- [ ] **Step 6: Checkpoint.**

### Task 32: Chat UI and Suggest goals

Spec: Frontend → Chat column; Goals → Page (Suggest goals); the approved chat mockup.

**Files:** Create `client/src/chat/sse.ts`, `client/src/chat/sse.test.ts`, `client/src/chat/useChat.ts`, `client/src/chat/ChatColumn.tsx` (+ `.module.css`, test), `client/src/chat/Markdown.tsx` (headings, lists, bold, italics, links, code; links open in a new tab; no raw HTML). Modify `client/src/pages/Goals/Goals.tsx` (enable Suggest goals).

**Interfaces:**
- Produces: `export function parseSse(chunk: string, carry: string): { events: ChatEvent[]; carry: string };` and `useChat(accountId)` with `{ sessions, messages, send(text), approve(requestId, yes), stop(), newChat(), openChat(id) }`.
- Suggest goals sends: `Suggest a few goals for <account name> based on my progress and current goals.` with the note "From Suggest goals" under the message.
- A goal's "Ask the AI for a plan" sends: `Make me a plan for this goal: <goal title>.` with the note "From Goals".
- Usage text: plan → `8.2k tokens on your plan`; API key → `$0.04 with your API key`.

- [ ] **Step 1: Write the failing tests**: `parseSse` handles an event split across two chunks and two events in one chunk; tool events collapse to "Looked at 4 things" and expand to the labels; an approval row's Approve posts `{ approve: true }`; while waiting the input reads "Waiting for your approval…" and Stop is shown; usage renders `8.2k tokens on your plan` for 8,200 tokens; a new chat shows the four starter questions; an error event shows its `fix` text.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** per the mockup: header (account name, New chat, Earlier chats with rename and delete), collapsed tool activity with icons, serif answers, approval rows, sources and usage under each answer, input with "Enter to send, Shift+Enter for a new line", Stop while answering.
- [ ] **Step 4: Run**: PASS; in the app, Suggest goals posts into the chat and approvals add goals that appear on the Goals page.
- [ ] **Step 5: Checkpoint.**

---

## Phase 7: Finish

Ends with: every Settings section working, name changes handled, docs matching the code, and an end-to-end check on real accounts.

### Task 33: Settings page sections and backups

Spec: Frontend → Settings page; Database → Backups.

**Files:** Modify `client/src/pages/Settings/Settings.tsx` (+ sections `Accounts.tsx`, `GameData.tsx`, `Ai.tsx`, `About.tsx`), `server/src/routes/settings.ts` (`GET /api/about` → `{ dataDir, runeliteDir, runeliteFound, lastBackup, env: { CONTACT, PORT, DATA_DIR, RUNELITE_DIR, ANTHROPIC_API_KEY: 'set' | 'not set' } }`; `POST /api/backups` → `{ file }`). Test: `server/src/routes/about.test.ts`, `client/src/pages/Settings/Settings.test.tsx`.

- [ ] **Step 1: Write the failing tests**: `GET /api/about` never contains the API key's value; `POST /api/backups` creates a file; the AI section hides the spending cap unless billing is API key; the model list offers `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`; Delete account asks for confirmation naming the account; About shows "Game images © Jagex Ltd." and the CC BY-NC-SA 3.0 link.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** the Accounts, Game data, AI and About sections as specified.
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 34: Name changes, final docs and end-to-end check

Spec: Frontend → Name changes; the Status line at the top of `ARCHITECTURE.md`.

**Files:** Modify `client/src/pages/Overview/Overview.tsx` (show `renameSuggestion` as "This account may have been renamed to <name>. Rename it?" with Rename / Not now), `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`.

- [ ] **Step 1: Write the failing test**: a refresh returning `renameSuggestion: 'Lumby Peter'` shows the prompt; Rename calls `PATCH /api/accounts/:id { name: 'Lumby Peter' }` and the history stays attached.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Docs pass:** remove "planned" wording from `ARCHITECTURE.md` where the code exists, record any differences, refresh `README.md`'s setup and `CLAUDE.md`'s commands so they match `package.json`.
- [ ] **Step 6: End-to-end check with the user** on WSL and on Windows (`npm install` there first): add each real account; Overview, This week, Bank and gear, Collection log and Goals show real data; switch Automatic/Manual; ask the four questions in `README.md` → Goals ("What should I work on next?", "Can I do Dragon Slayer II yet? What am I missing?", "What's my best gear upgrade for under 20m?", "What did I get done this week?") and check each answer uses real data and cites wiki pages.
- [ ] **Step 7: Checkpoint.**
