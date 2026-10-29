# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working rules

- **Git is read-only for Claude.** Only run read-only git commands (`status`, `diff`, `log`, `show`, `branch --show-current`, etc.). Never commit, stage, stash, reset, checkout, or push; the user does all commits.
- **Work on whatever branch is currently checked out.** Never create or switch branches.
- **Keep the docs up to date** with every change that affects them: `README.md` (what the app does, installation, configuration, usage, commands), the root `ARCHITECTURE.md` (the system as a whole: data flow, key decisions, platforms, security), and each package's `ARCHITECTURE.md` (`server/`, `client/`, `shared/`: modules, schema, routes, sources, tools, UI). They're written for human readers: explain, don't list every edge case; the code and tests are the detailed reference.
- **When work is done, give the user a commit message**: brief, listing only the changes made, with no trailers (no `Co-Authored-By`, no Claude session links). This overrides any default attribution guidance.

## The user's data and outside sites

- **Never open the real data folder** (`~/.local/share/wise-old-model`, or `%LOCALAPPDATA%\wise-old-model` on Windows): not its database, backups or icons, not even to copy or measure. Manual and dev runs use a temp `DATA_DIR`, a temp `RUNELITE_DIR` and a spare `PORT`.
- **Never read or print `.env`.**
- Make live requests to Wise Old Man, Temple, the hiscores or the wiki only when the task needs them, one at a time. Tests use the captured fixtures in `server/test/fixtures`.
- Ask before anything that uses the user's Claude plan (a real chat turn).
- Subagents don't inherit these rules: paste them into every subagent prompt.

## Where things are documented

Built and in use. Start here, then read what the task touches:

- `README.md`: what the app does (including the four questions the chat must answer well), what's out of scope, installation, configuration and usage.
- `ARCHITECTURE.md`: the system as a whole, with diagrams: packages, how data flows in and out, the chat turn, key decisions and why, platforms, security.
- `server/ARCHITECTURE.md`: the server's layers and folders, the outbound requester and each data source, freshness and caching, Character Export, the database schema, page services, goals, the AI layer (chat service, Claude provider, tools, instructions) and the API routes.
- `client/ARCHITECTURE.md`: routes, layout, the data layer (query keys, invalidation, the file check), pages, the chat, the look and its tokens, testing.
- `shared/ARCHITECTURE.md`: the shared schemas and helpers, by module.

The docs describe the code as it is; keep them that way as the code changes.

## What this is

A personal, single-user, locally-run OSRS account advisor: an Express + TypeScript backend aggregates data from OSRS Hiscores, Wise Old Man, TempleOSRS, the OSRS Wiki (MediaWiki + prices APIs) and the JSON files written by the Character Export RuneLite plugin (Plugin Hub) into SQLite (Node's built-in `node:sqlite` through Kysely), and a React (Vite) frontend shows a per-account dashboard plus a chat panel backed by a remote LLM with tool calling. Top-level split: `/server`, `/client` and `/shared` (npm workspaces).

The backend exists for two reasons: Jagex hiscores send no CORS headers, and the LLM API key must never reach the browser.

## Design rules

- **LLM provider is behind an interface.** The user will use Claude but wants it swappable, so nothing outside that module should depend on a provider SDK.
- **Claude runs through the Claude Agent SDK** so usage can bill to the user's Max plan. Never read, copy or store the Claude sign-in token or call the API with it; Claude Code handles sign-in itself (Anthropic's terms forbid apps from handling Claude.ai credentials). An API key is the optional alternative. See `server/ARCHITECTURE.md` → The AI layer.
- **Do math in code, not in the model.** XP remaining, requirement checks, costs, and time estimates are computed in code and exposed as tools; the model only interprets results.
- **Keep tool outputs small**: summarize the bank, return only the relevant wiki section. Everything a tool returns is sent to the remote LLM provider, so tools must not expose anything beyond account/game data.
- Advice must respect account type (e.g. ironmen can't use the GE); the system prompt carries the selected account's RSN and type. Answers cite wiki pages as links (wiki content is CC BY-NC-SA 3.0) and say when data is missing or stale. Refuse botting/RWT topics.
- **All outbound HTTP goes through one shared request handler** that sets a descriptive `User-Agent` with the contact info from `.env` (the OSRS Wiki blocks generic UAs), sends one request at a time per site, obeys Wise Old Man's `RateLimit-*` headers (its 20/min, 500/h and 3,000/day per-IP limits are shared with the user's WOM RuneLite plugin), and retries 429/5xx with backoff. Only Refresh requests a WOM player update, and only when WOM's data is over an hour old. No background fetching or scheduled jobs. Details in `server/ARCHITECTURE.md` → Talking to other sites.
- **Use the wiki prices API v2** (`/api/v2/osrs`) with bulk requests, never one request per item.
- **Store raw API responses** as snapshots (only when the data changed) so parsers can be improved later without losing history.
- **Never hard-code the hiscores skill/boss list**; derive it from the response (new skills like Sailing get added). Hiscores use a different table per game mode (`hiscore_oldschool_ironman`, etc.).
- Normalize RSNs consistently (case, spaces vs `_`/`-`).
- The endpoints in `server/ARCHITECTURE.md` → The sources were verified against the live APIs on 2026-10-27; recheck an API's docs before relying on anything not listed there.
- Character Export's file format belongs to a third party: store raw file contents in snapshots, parse defensively, and retry when a file fails to parse (the plugin overwrites files in place, so a read can catch one half-written).

## Toolchain

- Node 26, pinned in `mise.toml`; the user manages runtimes with mise (not nvm). `node`/`npm`/`npx` resolve to mise's Node 26 directly.
- npm workspaces `server/`, `client/`, `shared/`; `"engines": { "node": ">=26" }`.
- The server's TypeScript runs directly on Node (type stripping, no build step): only erasable syntax (no enums, namespaces or parameter properties), and relative imports use `.ts` extensions. TypeScript 7 is for type checking only (`noEmit`).
- Biome lints and formats (not ESLint/Prettier: typescript-eslint doesn't support TypeScript 7). Run `./node_modules/.bin/biome check --write <paths>` before `npm run check`; don't use `--unsafe` on client files. Biome skips Markdown. Vitest 5 for tests; tests never call Claude.
- Scripts (root): `npm run dev` (server and client together), `npm run dev:server`, `npm run dev:client`, `npm run build`, `npm start`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run check` (type check, lint, tests). One test file: `npx vitest run <path>`.
- `@wom/shared` exports only its `src/index.ts`; re-export every shared module from there.

## Conventions

- **Platform-agnostic:** must run on Windows, macOS, Linux and WSL. Development happens on WSL; the finished app will likely run on Windows. No shell-specific npm scripts (set environment variables in scripts with `cross-env`), build paths with Node's `path`, and no OS-specific assumptions. See `ARCHITECTURE.md` → Running on different systems.
- Config and secrets live in `.env` (git-ignored). The committed `.env.example` lists every variable with its default; keep it and `README.md` → Configuration in sync when variables change.
- The server binds to `127.0.0.1` only, and requests must pass its `Host` check (and `Origin` for writes): see `server/ARCHITECTURE.md` → Startup and the HTTP layer.
- Stay within the scope in `README.md` (no multi-user, hosting, bots or gameplay automation).

## Verifying changes

- Server tests run against an in-memory database and fake requesters; client tests use `client/src/test/fakeApi.ts`, which fails a test on any request it doesn't expect, so add the route rather than loosening it.
- jsdom can't check layout, and browser screenshots aren't available here: verify UI behaviour with tests, and ask the user to look at anything visual (CSS, spacing).
