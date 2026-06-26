module.exports = {
    // Bot Configuration
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'LLM_Guided',
        version: '1.20.4'
    },

    // Agent Configuration
    agent: {
        loopInterval: 5000,
        maxActionsPerLoop: 3,
        logDirectory: './runs',
        runName: null,
        inventoryDisplayInterval: 15000,
        maxReconnectAttempts: 3,
        statePersistIntervalMs: 60000
    },

    // LLM Configuration - GPT-4o-mini (weak model, fully guided)
    // Purpose: comparison baseline against research_autonomous.js
    // Research question: how much does heavy guarding compensate for a weaker model?
    llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        // apiKey: set in .env as OPENAI_API_KEY, or pass explicitly here
        temperature: 0.3,
        maxTokens: 500,
        tokenBudget: 1000000,

        // autonomousMode not set (defaults to false) — NEXT STEP directive and all progression
        // guards remain active. The agent drives most decisions via behavior guards.

        systemPrompt: `You are a Minecraft survival AI playing like a smart human player.

CORE RULES:
1. Follow the NEXT STEP instruction each turn unless a PRIORITY_ALERT overrides it.
2. NEVER repeat the same action more than 3 times in a row. If an action keeps failing, try something different.
3. CHECK INVENTORY before crafting - don't duplicate tools you already have.
4. NEVER craft crafting_table more than once. It auto-places and persists.
5. Only suggest 1-3 actions per response.

SURVIVAL (override all other goals):
- Health low + have food: eat immediately.
- Drowning/low oxygen: swim_up NOW.
- Taking damage from hostiles: flee_from first, eat, then reassess.
- Night time: build_shelter or sleep_if_possible (if you have a bed).

GAMEPLAY LOOP (like a human player):
1. Gather wood (chop_tree) -> craft planks -> craft sticks -> craft crafting_table (once)
2. Craft wooden_pickaxe -> mine stone -> craft stone tools
3. Build shelter at night, craft bed (need 3 wool from sheep + 3 planks)
4. Hunt animals for food when hungry (attack cow/pig/sheep -> eat)
5. Explore, mine coal for torches, upgrade tools

KEY ACTIONS: chop_tree, craft, mine, attack, eat, explore, build_shelter, sleep_if_possible, flee_from, swim_up, dig_to_surface, break_around, pillar_up

Respond with JSON: { "goal": "...", "reasoning": "...", "actions": [{ "name": "...", "params": {...} }] }`
    },

    // Experiment Configuration
    experiment: {
        name: 'Guided Baseline',
        description: 'Guided comparison run: weak model (gpt-4o-mini) with full behavior guards and NEXT STEP directive',
        duration: 3600000,   // 60 minutes
        seed: '-1613247987266390429',

        // Perturbation schedule matches research_autonomous.js for fair benchmarking
        perturbations: [
            {
                type: 'FORCED_DEATH',
                time: 600000,        // 10 min
                params: {}
            },
            {
                type: 'TELEPORT',
                time: 1200000,       // 20 min
                params: { x: 500, z: 500, maxRange: 100 }
            },
            {
                type: 'INVENTORY_WIPE',
                time: 1800000,       // 30 min
                params: {}
            }
        ]
    }
};
