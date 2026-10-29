# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working rules

- **Git is read-only for Claude.** Only run read-only git commands (`status`, `diff`, `log`, `show`, `branch --show-current`, etc.). Never commit, stage, stash, reset, checkout, or push; the user does all commits.
- **Work on whatever branch is currently checked out.** Never create or switch branches.
- **Keep `README.md` and `ARCHITECTURE.md` up to date** with every change that affects them (setup/run/test commands, layout, data flow, schema, routes, design decisions).
- **When work is done, give the user a commit message**: brief, listing only the changes made, with no trailers (no `Co-Authored-By`, no Claude session links). This overrides any default attribution guidance.

## Project status

Built from `PLAN.md`, phase by phase (ticked checkboxes mark finished tasks); the end-to-end check on real accounts is the last step. The design lives in `ARCHITECTURE.md`, the source of truth, which describes the code as it is: keep it that way as the code changes. Goals, non-goals and the four questions that define "done" are in `README.md`.

## What this is

A personal, single-user, locally-run OSRS account advisor: an Express + TypeScript backend aggregates data from OSRS Hiscores, Wise Old Man, TempleOSRS, the OSRS Wiki (MediaWiki + prices APIs) and the JSON files written by the Character Export RuneLite plugin (Plugin Hub) into SQLite (Node's built-in `node:sqlite` through Kysely), and a React (Vite) frontend shows a per-account dashboard plus a chat panel backed by a remote LLM with tool calling. Top-level split: `/server`, `/client` and `/shared` (npm workspaces).

The backend exists for two reasons: Jagex hiscores send no CORS headers, and the LLM API key must never reach the browser.

## Design rules

- **LLM provider is behind an interface.** The user will use Claude but wants it swappable, so nothing outside that module should depend on a provider SDK.
- **Claude runs through the Claude Agent SDK** so usage can bill to the user's Max plan. Never read, copy or store the Claude sign-in token or call the API with it; Claude Code handles sign-in itself (Anthropic's terms forbid apps from handling Claude.ai credentials). An API key is the optional alternative. See `ARCHITECTURE.md` → AI layer.
- **Do math in code, not in the model.** XP remaining, requirement checks, costs, and time estimates are computed in code and exposed as tools; the model only interprets results.
- **Keep tool outputs small**: summarize the bank, return only the relevant wiki section. Everything a tool returns is sent to the remote LLM provider, so tools must not expose anything beyond account/game data.
- Advice must respect account type (e.g. ironmen can't use the GE); the system prompt carries the selected account's RSN and type. Answers cite wiki pages as links (wiki content is CC BY-NC-SA 3.0) and say when data is missing or stale. Refuse botting/RWT topics.
- **All outbound HTTP goes through one shared request handler** that sets a descriptive `User-Agent` with the contact info from `.env` (the OSRS Wiki blocks generic UAs), sends one request at a time per site, obeys Wise Old Man's `RateLimit-*` headers (its 20/min, 500/h and 3,000/day per-IP limits are shared with the user's WOM RuneLite plugin), and retries 429/5xx with backoff. Only Refresh requests a WOM player update, and only when WOM's data is over an hour old. No background fetching or scheduled jobs. Details in `ARCHITECTURE.md` → Data sources.
- **Use the wiki prices API v2** (`/api/v2/osrs`) with bulk requests, never one request per item.
- **Store raw API responses** as snapshots (only when the data changed) so parsers can be improved later without losing history.
- **Never hard-code the hiscores skill/boss list**; derive it from the response (new skills like Sailing get added). Hiscores use a different table per game mode (`hiscore_oldschool_ironman`, etc.).
- Normalize RSNs consistently (case, spaces vs `_`/`-`).
- The endpoints in `ARCHITECTURE.md` → Data sources were verified against the live APIs on 2026-10-27; recheck an API's docs before relying on anything not listed there.
- Character Export's file format belongs to a third party: store raw file contents in snapshots, parse defensively, and retry when a file fails to parse (the plugin overwrites files in place, so a read can catch one half-written).

## Toolchain

- Node 26, pinned in `mise.toml`; the user manages runtimes with mise (not nvm). `node`/`npm`/`npx` resolve to mise's Node 26 directly.
- npm workspaces `server/`, `client/`, `shared/`; `"engines": { "node": ">=26" }`.
- The server's TypeScript runs directly on Node (type stripping, no build step): only erasable syntax (no enums, namespaces or parameter properties), and relative imports use `.ts` extensions. TypeScript 7 is for type checking only (`noEmit`).
- Biome lints and formats (not ESLint/Prettier: typescript-eslint doesn't support TypeScript 7). Vitest 5 for tests; tests never call Claude.
- Scripts (root): `npm run dev` (server and client together), `npm run dev:server`, `npm run dev:client`, `npm run build`, `npm start`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run check` (type check, lint, tests). One test file: `npx vitest run <path>`. Details in `ARCHITECTURE.md` → Repo and tooling.
- `@wom/shared` exports only its `src/index.ts`; re-export every shared module from there.

## Conventions

- **Platform-agnostic:** must run on Windows, macOS, Linux and WSL. Development happens on WSL; the finished app will likely run on Windows. No shell-specific npm scripts (set environment variables in scripts with `cross-env`), build paths with Node's `path`, and no OS-specific assumptions. See `ARCHITECTURE.md` → Platforms.
- Server binds to `127.0.0.1` only.
- Config and secrets live in `.env` (git-ignored). The committed `.env.example` lists every variable with its default; keep it, `README.md` and `ARCHITECTURE.md` → Configuration in sync when variables change.
- Server requests must pass the `Host` check (and `Origin` for writes) described in `ARCHITECTURE.md` → Backend.
- Out of scope: multi-user/auth, public hosting, Discord bot, any gameplay automation, fine-tuning on wiki content, commercial use.
