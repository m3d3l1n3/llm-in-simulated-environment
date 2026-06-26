# Exploring the Autonomous Behavior of Large Language Models in Simulated Environments - Experiment Harness

This directory contains the Node.js application that connects a Large Language Model (or a deterministic heuristic engine) to a Minecraft 1.20.4 survival server via `mineflayer`.

This should be a given, but Minecraft with local server is also needed in order to be able to run these bot configurations. For stability purposes my chosen version was 1.20.4 Java Edition.

## Quick Start

```bash
# 1. Install dependencies
cd mc_agent
npm install

# 2. Configure API keys (only needed for LLM configs)
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY and/or ANTHROPIC_API_KEY

# 3. Start the Minecraft server with a FRESH world (from ../Minecraft/server)
cd ../Minecraft/server
rm -rf world/
java -Xmx2G -jar server.jar nogui

# 4. Run an experiment
cd mc_agent

# Smoke / dev tests
node run_experiment.js configs/baseline.js                 # 3-minute smoke test
node run_experiment.js configs/openai_test.js              # 5-minute OpenAI test
node run_experiment.js configs/anthropic_test.js           # 5-minute Anthropic test
node run_experiment.js configs/heuristic_smoke_test.js     # 60-second heuristic sanity check

# Research runs
node run_experiment.js configs/research_autonomous.js      # 60-min primary research run (Claude, 3 perturbations)
node run_experiment.js configs/research_autonomous_20min.js # 20-min abbreviated research run
node run_experiment.js configs/guided_baseline.js          # 60-min guided baseline (GPT-4o-mini, 3 perturbations)

# Deterministic heuristic baselines (zero API cost)
node run_experiment.js configs/heuristic_baseline.js              # 60-min clean run
node run_experiment.js configs/heuristic_baseline.js    # 60-min with 3 perturbations
node run_experiment.js configs/heuristic_10min_test.js            # 10-min validation run
```

A fresh world is required before every experimental run so that placed blocks, explored terrain, and mob state do not confound behavior.

## Entry Point

- **`run_experiment.js`** — Creates the bot, wires subsystems, starts the decision loop, and handles respawn / log rotation.

## Core Modules

| File | Role |
|------|------|
| `agent.js` | Decision loop, behavior guards, state persistence |
| `actions.js` | ~60 action primitives (movement, crafting, combat, survival) |
| `observation.js` | Structured world-state extraction |
| `llm.js` | Prompt construction + HTTP calls to OpenAI / Anthropic |
| `logging.js` | JSONL output, death rotation, run summaries |
| `supervisor.js` | Run timer, perturbation schedule, stall watchdog |
| `goal_manager.js` | Progression tier inference + thrash detection |
| `memory.js` | Known locations, achievements, death context |
| `heuristic_engine.js` | Deterministic rule-based baseline (zero API cost) |

## Documentation

- **`../AGENTS.md`** — Full project overview, build/run commands, architecture, conventions, and known issues. This is the single source of truth for agent-facing documentation.
- **`../docs/architecture.md`** — Component map, data flow, guard priorities
- **`../docs/actions.md`** — Complete action reference (~60 actions, aliases, params)
- **`../docs/prompts.md`** — Observation schema and prompt section order
- **`../docs/configs.md`** — Config comparison matrix and purpose descriptions
- **`../docs/decisions.md`** — Rationale for key design choices
- **`../docs/gotchas.md`** — Non-obvious bugs and silent failures
- **`../docs/evaluation.md`** — Thesis results: methodology, per-config aggregates, cross-config comparison, discussion
- **`../docs/tables.md`** — Result tables and figures

## Technology Stack

- **Runtime:** Node.js 18+ (CommonJS)
- **Bot framework:** mineflayer 4.33.0 + mineflayer-pathfinder 2.4.5
- **Minecraft server:** 1.20.4, seed `-1613247987266390429`, `online-mode=false`
- **LLM transport:** Raw Node.js `https` (no OpenAI or Anthropic SDK installed)

## Output

Each run writes to `runs/{runName}_{HH-MM-SS}/`. On death, logs rotate into `life_01/`, `life_02/`, … subdirectories within the same run folder.

- `observations.jsonl` — World state per loop
- `actions.jsonl` — Executed actions with results
- `goals.jsonl` — LLM decisions + guard overrides (`isGuard` flag)
- `llm_requests.jsonl` — Full prompt + raw response per LLM call
- `events.jsonl` — Critical events (deaths, perturbations, errors)
- `memory_summaries.jsonl` — Periodic memory snapshots
- `metadata.json` — Run configuration snapshot
- `runtime_state.json` — Persisted GoalManager + MemoryManager state
- `summary.json` — Aggregate statistics for the current life
- `experiment_summary.json` — Aggregate statistics across all lives
- `behavioral_analysis.json` — Goal completion rate, action distribution, failure patterns

## Results

Aggregated results from the evaluated configs are in **`../docs/evaluation.md`**. The three main conditions are:

- `heuristic_baseline_perturbed.js` — deterministic rule engine under stress
- `guided_baseline.js` — GPT-4o-mini with full guards and `NEXT STEP`
- `research_autonomous.js` — Claude Sonnet 4.6 with high autonomy and safety-only guards

All three use the same perturbation schedule (forced death @ 10 min, teleport @ 20 min, inventory wipe @ 30 min) for fair comparison.
