/**
 * Heuristic Baseline Smoke Test
 *
 * Purpose: 60-second validation run to verify the heuristic engine
 * initializes, spawns, and completes decision loops without crashing.
 */

module.exports = {
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'HeuristicBot',
        version: '1.20.4'
    },
    agent: {
        loopInterval: 5000,
        maxActionsPerLoop: 3,
        logDirectory: './runs',
        runName: null,
        inventoryDisplayInterval: 15000,
        maxReconnectAttempts: 10,
        statePersistIntervalMs: 60000
    },
    llm: {
        provider: 'heuristic',
        explorationDistance: 35,
        targetLogs: 4,
        targetCobble: 12,
        targetCoal: 5,
        targetIronOre: 8,
        targetDiamond: 3
    },
    experiment: {
        name: 'Heuristic Smoke Test',
        description: '60-second smoke test for heuristic baseline validation',
        duration: 60000,  // 60 seconds
        seed: '-1613247987266390429',
        perturbations: []
    }
};
