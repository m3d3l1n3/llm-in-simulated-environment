/**
 * Heuristic Baseline — Perturbed Variant
 *
 * Purpose: Fully deterministic rule-based agent with zero LLM cost,
 * subjected to the same perturbation schedule as research_autonomous.js.
 * Used for fair comparison: measures scripted progression under stress.
 */

module.exports = {
    // Bot Configuration
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'HeuristicBot',
        version: '1.20.4'
    },

    // Agent Configuration
    agent: {
        loopInterval: 5000,
        maxActionsPerLoop: 3,
        logDirectory: './runs',
        runName: null,
        inventoryDisplayInterval: 15000,
        maxReconnectAttempts: 10,
        statePersistIntervalMs: 60000
    },

    // LLM Configuration - uses heuristic engine instead of API
    llm: {
        provider: 'heuristic',
        // autonomousMode is intentionally left undefined (defaults to false-ish)
        // so that agent.js behavior guards (progression, night shelter, etc.)
        // remain active and assist the heuristic engine.

        // Heuristic-specific tuning
        explorationDistance: 35,
        targetLogs: 4,
        targetCobble: 12,
        targetCoal: 5,
        targetIronOre: 8,
        targetDiamond: 3
    },

    // Experiment Configuration
    experiment: {
        name: 'Heuristic Baseline Perturbed',
        description: 'Deterministic rule-based agent under identical perturbations to research_autonomous. Measures maximum scripted progression under stress.',
        duration: 3600000,  // 1 hour
        seed: '-1613247987266390429',

        // Same perturbation schedule as research_autonomous.js
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
