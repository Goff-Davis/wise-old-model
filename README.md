# Wise Old Model

A personal, locally-run web app for Old School RuneScape. It brings together data about my own accounts (levels, boss KC, gains, collection log, quests, diaries, bank) and uses a remote AI model to give advice based on each account's actual state, citing the OSRS Wiki pages the advice is drawn from.

It is for personal use only: one user, a handful of accounts, running on `127.0.0.1`. It runs on Windows, macOS, Linux and WSL. It does not automate gameplay of any kind.

It rebuilds, for personal use, the idea behind "Waise Old Man" (the Gielinor bot): an AI that combined the OSRS Wiki, Wise Old Man and TempleOSRS to give advice about your account. That tool has shut down.

## Goals

- See every account in one place: levels, boss kill counts, recent gains and collection log progress.
- Chat with an AI that knows the selected account's actual state. It's done when it answers these correctly, from real data, citing the wiki pages it used:
  - "What should I work on next?"
  - "Can I do Dragon Slayer II yet? What am I missing?"
  - "What's my best gear upgrade for under 20m?"
  - "What did I get done this week?"
- Keep my own history of stat snapshots, independent of third-party sites.
- Track goals per account.

## Non-goals

- Multi-user support, logins, or public hosting.
- A Discord bot.
- Automating gameplay of any kind (anything resembling botting is against Jagex's rules).
- Training or fine-tuning a model on wiki content: pages are fetched when needed and linked.
- Commercial use.

## Status

Being built in phases. Phase 1, the skeleton, is in place: the local server, its database and settings, and the empty three-column app in both themes. There are no accounts, data sources or chat yet. The design is in [ARCHITECTURE.md](ARCHITECTURE.md) and the build steps, in phases, are in [PLAN.md](PLAN.md).

## Requirements

- Node.js 26, pinned in `mise.toml`. With [mise](https://mise.jdx.dev) installed, run `mise install` in the repo root.
- Claude Code signed in with your Claude plan (run `claude`, then `/login`, once on each machine), or an Anthropic API key. The chat runs Claude Code through the Claude Agent SDK, so with a plan it uses your plan's usage.
- RuneLite with these Plugin Hub plugins:
  - [Character Export](https://github.com/DZWNK/Character-Export): quests, diaries, combat achievements, bank and gear.
  - Temple OSRS: collection log. Press its sync button in the collection log once, then turn on its automatic sync of new items and the in-game "Collection log – New addition notification" setting.

## Setup and running

These steps run the skeleton that exists so far (see Status).

1. `npm install` (again after switching between WSL and Windows on the same checkout).
2. Copy `.env.example` to `.env` (git-ignored) and fill in `CONTACT`.

   | Variable | Required | Default | Purpose |
   |---|---|---|---|
   | `CONTACT` | Yes | (none) | Your Discord name or email, sent in the User-Agent so Wise Old Man, Temple and the wiki can reach you |
   | `PORT` | No | `4747` | Port the server listens on |
   | `DATA_DIR` | No | Your OS's app-data folder | Database, backups and icons |
   | `RUNELITE_DIR` | No | `~/.runelite` | Where RuneLite keeps Character Export's files. On WSL with RuneLite on Windows: `/mnt/c/Users/<you>/.runelite` |
   | `ANTHROPIC_API_KEY` | No | (none) | Only used if you switch the chat's billing to an API key |

3. `npm run dev` for development (open `http://localhost:5173`), or `npm run build` then `npm start` (open `http://127.0.0.1:4747`).
4. `npm run check` runs type checking, linting and tests.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is put together, and why
- [PLAN.md](PLAN.md): the build plan, in phases

## Data sources and attribution

OSRS Hiscores (Jagex), [Wise Old Man](https://wiseoldman.net), [TempleOSRS](https://templeosrs.com) and the [OSRS Wiki](https://oldschool.runescape.wiki). Quests, diaries, bank and gear, which the hiscores don't include, come from the Character Export RuneLite plugin, which saves them to local JSON files and sends nothing anywhere. Wiki content is licensed CC BY-NC-SA 3.0, so answers always link back to the source page.
