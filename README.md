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

Built, from the phases in [PLAN.md](PLAN.md); what's left is checking it end to end on real accounts. What it does:

- **Accounts:** add one by name (looked up on the hiscores, Wise Old Man, TempleOSRS and Character Export's files); rename it, change its type or delete it in Settings; a renamed account is noticed on Refresh and offered the new name, keeping its history.
- **Overview:** the stats tiles, quests, diaries, combat achievements, the collection log, top boss kill counts, worn gear, what's missing and how to get it, where the data came from and when, and Refresh.
- **This week:** XP, kills and clues, what was completed and new collection log items, for today, the last 7 or 30 days, or days picked.
- **Bank and gear** and the **Collection log**, read from RuneLite's folder as you play (or on Refresh) and from TempleOSRS.
- **Goals:** eight kinds (a skill level or XP, a quest, a diary tier, combat achievements, boss kills, a collection log item or entry, an item, or your own), with progress from the account's data, what a quest or diary still needs, your own order, and goals that complete themselves as you play.
- **The chat:** ask about the account and Claude looks things up with the app's own tools (stats, quests, diaries, combat achievements, collection log, gains, bank and gear, requirement checks, XP and hours, gear upgrades, the wiki and prices, and your goals), shows what it looked at, cites the wiki pages it read, and asks before adding or changing a goal. With your Claude plan it uses the plan's usage; the model and effort are picked from the ones Claude Code lists.
- **Settings:** accounts, where the game data is read from and how often, the chat's billing, model and limits, the theme and time zone, and About: the data folder, backups (daily, and Back up now), the `.env` settings and the credits.

The design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Node.js 26, pinned in `mise.toml`. With [mise](https://mise.jdx.dev) installed, run `mise install` in the repo root.
- Claude Code signed in with your Claude plan (run `claude`, then `/login`, once on each machine), or an Anthropic API key. The chat runs Claude Code through the Claude Agent SDK, so with a plan it uses your plan's usage.
- RuneLite with these Plugin Hub plugins:
  - [Character Export](https://github.com/DZWNK/Character-Export): quests, diaries, combat achievements, bank and gear.
  - Temple OSRS: collection log. Temple keeps a sync only for a player it has a profile for, so first search your name on [templeosrs.com](https://templeosrs.com) and press Update. Then press the plugin's sync button in the collection log once, and turn on its automatic sync of new items and the in-game "Collection log – New addition notification" setting.

## Setup and running

1. `npm install` (again after switching between WSL and Windows on the same checkout).
2. Copy `.env.example` to `.env` (git-ignored) and fill in `CONTACT`.

   | Variable | Required | Default | Purpose |
   |---|---|---|---|
   | `CONTACT` | Yes | (none) | Your Discord name or email, sent in the User-Agent so Wise Old Man, Temple and the wiki can reach you |
   | `PORT` | No | `4747` | Port the server listens on |
   | `DATA_DIR` | No | Your OS's app-data folder | Database, backups, icons and the chat's Claude Code working folder |
   | `RUNELITE_DIR` | No | `~/.runelite` | Where RuneLite keeps Character Export's files. On WSL with RuneLite on Windows: `/mnt/c/Users/<you>/.runelite` |
   | `ANTHROPIC_API_KEY` | No | (none) | Only used if you switch the chat's billing to an API key |

3. `npm run dev` for development (open `http://localhost:5173`; it picks up code changes by itself, so reloading the page shows them), or `npm run build` then `npm start` (open `http://127.0.0.1:4747`).
4. `npm run check` runs type checking, linting and tests.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is put together, and why
- [PLAN.md](PLAN.md): the build plan, in phases

## Data sources and attribution

OSRS Hiscores (Jagex), [Wise Old Man](https://wiseoldman.net), [TempleOSRS](https://templeosrs.com) and the [OSRS Wiki](https://oldschool.runescape.wiki), with item icons from [RuneLite](https://runelite.net)'s icon server and Grand Exchange prices from the wiki's [real-time prices API](https://prices.runescape.wiki). Quests, diaries, bank and gear, which the hiscores don't include, come from the Character Export RuneLite plugin, which saves them to local JSON files and sends nothing anywhere. Wiki content is licensed CC BY-NC-SA 3.0, so answers always link back to the source page.

## License

The code is under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): anyone may use, change and share it for noncommercial purposes (personal use, hobby projects, study, research, noncommercial organizations), but not commercially. That covers this project's own code only:

- Wise Old Model is not affiliated with Jagex, Wise Old Man, TempleOSRS, the OSRS Wiki or RuneLite. Old School RuneScape is a trademark of Jagex Ltd., and game data and images are Jagex's. Game icons are downloaded when first used and never stored in this repository.
- Test fixtures in `server/test/fixtures` are samples of the data the app reads, some trimmed: responses captured from the public APIs above, and Character Export files renamed so they hold no real account's name. They remain their sources' data; anything taken from the OSRS Wiki stays under CC BY-NC-SA 3.0.
- The fonts (Alegreya, Alegreya Sans and Silkscreen) are under the SIL Open Font License 1.1 and are installed from npm through Fontsource.
