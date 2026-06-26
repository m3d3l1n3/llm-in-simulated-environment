/**
 * Heuristic Baseline Configuration
 *
 * Purpose: Fully deterministic rule-based agent with zero LLM cost.
 * Used as a non-LLM baseline to compare against LLM-driven runs.
 * Designed for long runs (6 hours) to measure maximum achievable progression.
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
        name: 'Heuristic Baseline',
        description: 'Fully deterministic rule-based agent with zero LLM cost. 1-hour run to measure maximum progression without LLM.',
        duration: 3600000,  // 1 hour
        seed: '-1613247987266390429',

        // No perturbations — clean run to measure steady-state heuristic behavior
        perturbations: []
    }
};
