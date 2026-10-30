# Wise Old Model

A personal, locally-run advisor for Old School RuneScape. It brings together everything about your own accounts (levels, boss kill counts, gains, quests, diaries, combat achievements, the collection log, bank and gear) in one dashboard, and pairs it with a chat with an AI model of your choice (Claude by default, or Gemini, or any model with an OpenAI-compatible API, local ones included) that knows each account's real state and cites the OSRS Wiki pages its advice comes from.

It rebuilds, for personal use, the idea behind "Waise Old Man" (the Gielinor bot), an AI that combined the OSRS Wiki, Wise Old Man and TempleOSRS to give account advice; that tool has shut down.

It's for one person and a handful of accounts, running on your own computer (`127.0.0.1`), on Windows, macOS, Linux or WSL.

## What it does

- **Accounts:** add an account by name. The app looks it up on the hiscores, Wise Old Man, TempleOSRS and RuneLite's files first. You can rename an account, change its type or delete it, and a renamed account is noticed and offered its new name, keeping its history.
- **Overview:** stats tiles like the in-game stats tab, combat and total level, quests, diaries, combat achievements, the collection log, top boss kill counts, worn gear, what's missing and how to get it, and when each source was last fetched.
- **This week:** XP, kills and clues, what you completed and new collection log items, for today, the last 7 or 30 days, or any days you pick.
- **Bank and gear:** your bank's value, one search across bank, seed vault, inventory and gear, and your equipment and inventory laid out as in game.
- **Collection log:** tabs and entries like the in-game log, from TempleOSRS.
- **Goals:** a skill level or XP, a quest, a diary tier, combat achievements, boss kills, a collection log item or entry, an item, or your own. Progress comes from your data, quest and diary goals list what's still needed, and goals complete themselves as you play.
- **The chat:** ask about the selected account, and the AI looks things up with the app's own tools, shows what it looked at, cites the wiki pages it read, and asks before adding or changing a goal. It's built to answer questions like:
  - "What should I work on next?"
  - "Can I do Dragon Slayer II yet? What am I missing?"
  - "What's my best gear upgrade for under 20m?"
  - "What did I get done this week?"

The app keeps its own history of your stats, independent of third-party sites, and when a site is down it shows the last good data, marked stale with the reason.

## Requirements

- **Node.js 26**, pinned in `mise.toml`. With [mise](https://mise.jdx.dev) installed, `mise install` in the repo root sets it up.
- **An AI for the chat**, one or more of:
  - **Claude** (the default): Claude Code signed in with your Claude plan. Run `claude`, then `/login`, once on each machine. The chat runs Claude Code through the Claude Agent SDK, so it uses your plan's usage. An Anthropic API key works instead.
  - **Any OpenAI-compatible API**: a hosted one with its key (OpenAI, OpenRouter, Groq, Mistral and others), or a model running on your own computer with Ollama or LM Studio, which needs no key.
  - **Gemini**: an API key from [Google AI Studio](https://aistudio.google.com/apikey).

  See Configuration → Choosing the AI.
- **RuneLite** with two Plugin Hub plugins:
  - [Character Export](https://github.com/DZWNK/Character-Export): writes your quests, diaries, combat achievements, bank and gear to local files, which the app reads. It sends nothing anywhere.
  - **Temple OSRS**: syncs your collection log to TempleOSRS.

## Installation

1. Install the packages:

   ```sh
   npm install
   ```

2. Create your configuration from the example and fill in `CONTACT` (see Configuration):

   ```sh
   cp .env.example .env
   ```

3. Set up the game side, once per account:
   - In RuneLite, log in with Character Export on, then open your bank, your seed vault and each achievement diary journal once, so every file is written.
   - Temple keeps a sync only for a player it has a profile for: search your name on [templeosrs.com](https://templeosrs.com) and press Update. Then press the Temple OSRS plugin's sync button in the collection log once, and turn on its automatic sync of new items (and the in-game "Collection log – New addition notification" setting).
   - If Wise Old Man doesn't track the account yet, the app offers to start tracking it when you add it.

## Configuration

Settings that rarely change, and secrets, live in `.env` in the repo root. It's git-ignored; `.env.example` lists every variable.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CONTACT` | Yes | (none) | Your Discord name or email. It's sent in the User-Agent so Wise Old Man, Temple and the wiki can reach you if something goes wrong. Plain ASCII only. |
| `PORT` | No | `4747` | The port the server listens on (on `127.0.0.1` only). |
| `DATA_DIR` | No | Your OS's app-data folder | Where the database, backups, icons and (with Claude) Claude Code's working folder go. |
| `RUNELITE_DIR` | No | `~/.runelite` | Where RuneLite keeps Character Export's files. |
| `ANTHROPIC_API_KEY` | No | (none) | Claude only: used if you switch Claude's billing to an API key in Settings. |
| `OPENAI_COMPAT_BASE_URL` | No | (none) | Turns on an OpenAI-compatible AI: its API's address, such as `https://api.openai.com/v1`. |
| `OPENAI_COMPAT_API_KEY` | No | (none) | Its key. A local server (Ollama, LM Studio) needs none. |
| `OPENAI_COMPAT_NAME` | No | `OpenAI-compatible` | What the app calls it ("OpenRouter", "Ollama"), up to 40 characters. |
| `OPENAI_COMPAT_MODEL` | No | The first of its models by name | The model it answers with until you pick one in Settings. |
| `GEMINI_API_KEY` | No | (none) | Turns on Gemini. |
| `GEMINI_MODEL` | No | The first it lists that thinks | The Gemini model it answers with until you pick one in Settings. |

The default data folder is `%LOCALAPPDATA%\wise-old-model` on Windows, `~/Library/Application Support/wise-old-model` on macOS and `~/.local/share/wise-old-model` on Linux and WSL. Folder settings accept `~` for your home folder. The server checks every value at startup and stops with a message saying what to fix.

### Choosing the AI

Claude is always available. Each other AI is turned on by its lines in `.env` (restart the app after changing them), and you can set up several at once. Then pick which one answers in **Settings → AI**, at any time and without restarting. Each AI remembers its own model and effort, and a chat keeps its conversation when you switch: the new AI gets the earlier questions and answers (the latest 20 messages), and looks up your account's data again itself.

Some examples for `.env`:

```sh
# OpenAI
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_API_KEY=sk-...
OPENAI_COMPAT_NAME=OpenAI
OPENAI_COMPAT_MODEL=gpt-5

# OpenRouter (hundreds of models behind one key; answers show what they cost)
OPENAI_COMPAT_BASE_URL=https://openrouter.ai/api/v1
OPENAI_COMPAT_API_KEY=sk-or-...
OPENAI_COMPAT_NAME=OpenRouter

# Ollama, on this computer (no key; LM Studio is http://localhost:1234/v1)
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
OPENAI_COMPAT_NAME=Ollama
OPENAI_COMPAT_MODEL=qwen3:14b

# Gemini
GEMINI_API_KEY=AIza...
```

Only one OpenAI-compatible API can be set up at a time. Setting `OPENAI_COMPAT_MODEL` is worth it for an API that lists many models (OpenAI, OpenRouter): otherwise the chat starts with the first of them by name, which is rarely the one you want.

The chat needs a model that can call tools: it has twenty, and a good answer often takes several rounds of them. Small local models may call them poorly or not at all; the chat says so when a model can't use tools. Gemini's thinking stays at each model's own setting, as the API doesn't say which levels a model takes.

### In the app

Everything else is set in the app, on the Settings page:

- **Game data:** Automatic (an open page re-reads Character Export's files every few seconds as you play; the interval is adjustable) or Manual (only when you press Refresh).
- **AI:** which AI answers (any `.env` sets up), its model and effort (picked from the models it lists), the most tool rounds per question, and, for Claude, its billing (your plan, or an API key) and a spending cap per question with a key.
- **Display:** dark or light theme, and the time zone (automatic, or any zone).

## Usage

Start the app:

```sh
npm run build   # build the client (again after updating)
npm start       # then open http://127.0.0.1:4747
```

For development, `npm run dev` runs the server and the Vite dev server together; open `http://localhost:5173`. Both pick up code changes by themselves, so reloading the page shows them.

Then:

1. **Add an account** by name. The app shows what the hiscores, Wise Old Man, Temple and Character Export know about it, and what to do in game if something's missing.
2. **Play with the page open.** In Automatic mode the dashboard follows Character Export's files as they change. Online data (hiscores, Wise Old Man, Temple) is fetched when a page needs it and its copy is old; **Refresh** fetches everything again.
3. **Ask the chat.** Continue the latest chat or start a new one, use a starter question, or ask from a page (Suggest goals, or "Ask the AI for a plan" on a goal). Changes the AI proposes appear as Approve / Decline. Stop ends an answer.
4. **Back up** whenever you like from Settings → About; the app also backs up daily when it starts.

On a narrow window, the page and menu fold behind a Menu button so the chat keeps the screen.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Server and client together, reloading on changes |
| `npm run dev:server`, `npm run dev:client` | Each on its own |
| `npm run build` | Build the client for `npm start` |
| `npm start` | Run the app |
| `npm test` | Run every test |
| `npm run typecheck`, `npm run lint` | Type check; lint and format check |
| `npm run check` | Type check, lint and tests together |

A single test file: `npx vitest run <path>`.

## Privacy

Everything stays on your computer except:

- requests to the hiscores, Wise Old Man, TempleOSRS, the OSRS Wiki and its prices API, and RuneLite's icon server, each carrying your `CONTACT` in the User-Agent;
- what the chat's tools return about the selected account (names, stats, bank contents), and the chat itself, which are sent to the AI you picked to answer you: Anthropic for Claude, Google for Gemini, or wherever `OPENAI_COMPAT_BASE_URL` points. With a model on your own computer (Ollama, LM Studio), they stay on it.

The app never reads or stores your Claude sign-in; Claude Code handles it. The other AIs' keys stay in `.env`, on the server: the page only ever learns whether each is set.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is put together, and why.
- [server/ARCHITECTURE.md](server/ARCHITECTURE.md), [client/ARCHITECTURE.md](client/ARCHITECTURE.md) and [shared/ARCHITECTURE.md](shared/ARCHITECTURE.md): each package in detail.
- [CLAUDE.md](CLAUDE.md): working notes for AI coding assistants.

## Data sources and attribution

OSRS Hiscores (Jagex), [Wise Old Man](https://wiseoldman.net), [TempleOSRS](https://templeosrs.com) and the [OSRS Wiki](https://oldschool.runescape.wiki), with item icons from [RuneLite](https://runelite.net)'s icon server and Grand Exchange prices from the wiki's [real-time prices API](https://prices.runescape.wiki). Quests, diaries, bank and gear come from the Character Export RuneLite plugin. Wiki content is licensed CC BY-NC-SA 3.0, so answers link back to the source page.

## License

The code is under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): anyone may use, change and share it for noncommercial purposes (personal use, hobby projects, study, research, noncommercial organizations), but not commercially. That covers this project's own code only:

- Wise Old Model is not affiliated with Jagex, Wise Old Man, TempleOSRS, the OSRS Wiki or RuneLite. Old School RuneScape is a trademark of Jagex Ltd., and game data and images are Jagex's. Game icons are downloaded when first used and never stored in this repository.
- Test fixtures in `server/test/fixtures` are samples of the data the app reads, some trimmed: responses captured from the public APIs above, and Character Export files renamed so they hold no real account's name. They remain their sources' data; anything taken from the OSRS Wiki stays under CC BY-NC-SA 3.0.
- The fonts (Alegreya, Alegreya Sans and Silkscreen) are under the SIL Open Font License 1.1 and are installed from npm through Fontsource.
