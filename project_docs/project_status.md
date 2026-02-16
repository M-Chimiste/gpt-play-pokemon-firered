# Project Status

## What Has Been Implemented
- Added provider-aware LLM configuration (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`) with defaults and validation.
- Switched OpenAI client initialization to use configurable base URL and published provider capabilities.
- Replaced OpenAI container-based pathfinding with a local deterministic pathfinder (grid-aware, directional constraints).
- Hardened cost/usage telemetry to tolerate unknown or local model pricing without noisy warnings.
- Updated README and CLAUDE docs to include LM Studio setup and LLM provider configuration.

## What Needs To Be Implemented Next
- Run OpenAI and LM Studio smoke validations (agent loop, tool-call flow, local pathfinding).
- Verify local pathfinding behavior on maps with ledges, spinners, arrow floors, and water currents.
- Consider optional penalties (e.g., tall grass) and transition-tile handling refinements if paths seem suboptimal.

## Detailed Debug Log
- Added LLM provider configuration and base URL override; OpenAI remains default.
- Implemented `localPathfinder` with A* over minimap grid; handles blocked edges, ledges, forced tiles, and water restrictions.
- Updated tool-call handling to treat zero-move paths as success when already at target.
- Adjusted cost calculation to accept missing pricing without warnings for local models.
- Documentation updated to reflect LM Studio usage and local pathfinding behavior.
- Smoke validations not executed in this environment; manual runtime checks still required.
- Runtime log indicates missing `tmp_screenshots/gba_raw.png`; likely bridge/emulator not producing screenshots yet.
- Checked workspace: `tmp_screenshots/gba_raw.png` still missing; agent will pause until bridge writes it.
- Updated `.env` to use an absolute `FIRERED_SCREENSHOT_DIR` so mGBA writes screenshots to the repo path.
- Fixed LM Studio `service_tier` default to a valid enum (`default`) to avoid 400 errors.
- Added `LLM_ALLOW_IMAGES` config and gated image inputs to support text-only models.
- LM Studio `/v1/models` shows `minimax-m2.5` is text-only; vision-capable options include `qwen/qwen3-vl-4b`, `qwen3-vl-30b-a3b-instruct-mlx`, `zai-org/glm-4.6v-flash`.
