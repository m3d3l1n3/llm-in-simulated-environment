/**
 * Heuristic Baseline — 10 Minute Validation Run
 *
 * Purpose: Medium-length validation to cover night cycle, stone tools,
 * and early iron progression. No perturbations — clean run.
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
        name: 'Heuristic 10min Validation',
        description: '10-minute validation run covering night cycle and stone/early-iron progression',
        duration: 600000,  // 10 minutes
        seed: '-1613247987266390429',
        perturbations: []
    }
};
