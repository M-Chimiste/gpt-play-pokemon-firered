# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An autonomous AI agent that plays Pokemon FireRed in real time using OpenAI or local LLMs via LM Studio, with a live web dashboard for monitoring. The system uses a 4-layer architecture:

1. **Emulator** — mGBA + Lua socket server (`mgba/scripts/FireRedBridgeSocketServer.lua`)
2. **Bridge** — Python FastAPI server (`firered_mgba_bridge.py` + `firered_bridge/`) reads game memory and sends inputs
3. **Agent** — Node.js server (`server/`) runs the AI decision loop via OpenAI-compatible structured tool calling
4. **Dashboard** — Static HTML/CSS/JS frontend (`frontend/`) connects via WebSocket

## Commands

### Install dependencies
```bash
python -m pip install -r requirements.txt
cd server && npm install
```

### Start components (must be started in order)
```bash
# 1. Start mGBA, load ROM, then load mgba/scripts/FireRedBridgeSocketServer.lua via Tools → Scripting
# 2. Start Python bridge
python firered_mgba_bridge.py
# 3. Start Node.js agent
cd server && npm start
# 4. (Optional) Start dashboard
cd frontend && python -m http.server 5173
```

### Development mode (auto-reload)
```bash
cd server && npm run dev
```

### Health checks
```bash
curl http://127.0.0.1:8000/requestData   # Python bridge
curl http://127.0.0.1:9885/health         # Node.js agent
```

## Architecture Details

### Python Bridge (`firered_bridge/`)
Reads game state directly from mGBA memory via socket. Key subsystems:
- `memory/` — mGBA socket client, symbol table reader, memory reader
- `player/` — bag, party, PC storage, save data, snapshots
- `ui/` — battle, dialog, fly map, menu, pokedex readers
- `world/` — collision, events, map reading, viewport
- `state/` — state builders that compose the above into a game state response
- `constants/` — memory addresses, tile behaviors, game constants
- `fog_of_war.py` — progressive map discovery system

Bridge API (port 8000): `GET /requestData`, `GET /minimapSnapshot`, `POST /sendCommands`, `POST /restartConsole`

### Node.js Agent (`server/`)
- `index.js` — entry point, Express + WebSocket server setup
- `src/core/gameLoop.js` — main AI decision loop
- `src/core/openaiClient.js` — OpenAI-compatible API integration with structured tool calling
- `src/ai/tools.js` — Zod-schema'd tools available to the LLM (keypress, memory, objectives, markers, pathfinding, map viewing)
- `src/ai/prompts.js` — system prompt construction from `prompts/` templates
- `src/ai/history.js` — conversation history management with token-aware pruning
- `src/core/progress.js` — 22-milestone game progress tracker (starter → champion)
- `src/state/` — state management for game data, summaries, criticism
- `src/utils/` — cost tracking, token counting, file I/O, timing
- `prompts/game.txt` — main system prompt (~55KB), defines agent behavior and game knowledge

### Dashboard (`frontend/`)
Static site connecting via WebSocket to port 9885. Shows real-time stats, trainer info, team, bag, minimap, objectives, and AI reasoning logs.

### Runtime Data
Agent state persists in `server/gpt_data/` (gitignored): history, memory, objectives, markers, summaries, progress, token/time usage.

## Configuration

Two `.env` files (see `.env.example` and `server/.env.example`):
- Root `.env` — mGBA transport settings, directories, savestate backup config
- `server/.env` — LLM provider (`LLM_PROVIDER`, `LLM_BASE_URL`), API key, model selection, token limits, WebSocket port

## Key Technical Notes

- ROM must be Pokemon FireRed (USA), MD5: `e26ee0d44e809351c8ce2d73c7400cdd`
- Symbol file `pokefirered.sym` maps memory addresses for the bridge
- `pokefirered/` is a git submodule (pret/pokefirered decompilation) — init with `git submodule update --init --recursive`
- Lua socket protocol uses `<|END|>` termination markers
- No test suite or linting configuration exists in the project
- Node.js codebase is plain JavaScript (no TypeScript)
- The agent uses Express 5 and the OpenAI SDK (OpenAI-compatible) with Zod schemas for tool definitions
