/**
 * Quick validation script for LLM implementation changes
 * Tests prompt building, JSON parsing, and computeNextStep without needing a running server
 */

const LLMInterface = require('./llm');

// --- Test 1: buildTurnPrompt with new sections ---
console.log('=== Test 1: buildTurnPrompt ===');
const llm = new LLMInterface({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    autonomousMode: true
});

const mockObservation = {
    player: {
        position: { x: 100.5, y: 64.2, z: -50.3 },
        health: 18,
        food: 14,
        oxygen: 20,
        isInWater: false
    },
    inventory: {
        slots: [
            { name: 'oak_log', count: 5 },
            { name: 'oak_planks', count: 12 },
            { name: 'stick', count: 4 },
            { name: 'stone_pickaxe', count: 1 },
            { name: 'cobblestone', count: 32 }
        ],
        emptySlots: 31,
        totalItems: 54,
        equippedToolDurability: { item: 'stone_pickaxe', remaining: 65, max: 131, pct: 50 }
    },
    entities: { mobs: [{ name: 'sheep', distance: 8 }, { name: 'zombie', distance: 15 }], players: [], items: [] },
    environment: {
        timeOfDay: 6000,
        isRaining: false,
        nearbyCraftingTable: { distance: 3, position: { x: 98, y: 64, z: -52 } },
        lightLevel: { effective: 14, mobSpawnRisk: false }
    },
    blocks: {
        resources: { oak_log: { found: true, distance: 6 }, stone: { found: true, distance: 3 } },
        summary: 'Trees and stone nearby'
    }
};

const mockContext = {
    strategicContext: { currentTier: 'stone_tools', nextMilestone: 'iron_tools', missing: ['coal', 'iron_ore'] },
    memorySummary: {
        recentSummary: 'Last 3 loops: gathered wood, crafted stone pickaxe',
        achievements: ['reached_stone_tier'],
        knownLocations: ['stone@(100,64,-50)'],
        deathContext: null
    },
    loopCount: 15,
    escapeCooldownUntilLoop: -1,
    blockedActions: ['chop_tree', 'mine'],
    recentActions: [
        { action: 'chop_tree', success: false, error: 'No path to tree' },
        { action: 'mine', success: false, error: 'No pickaxe equipped' },
        { action: 'explore', success: true },
        { action: 'eat', success: true },
        { action: 'craft', success: true }
    ],
    goalHistory: [
        { goal: 'gather_wood', reasoning: 'Need logs for planks' },
        { goal: 'craft_tools', reasoning: 'Need stone pickaxe for mining' }
    ]
};

let promptAllPass = true;
try {
    const prompt = llm.buildTurnPrompt(mockObservation, mockContext);
    const checks = [
        ['PREVIOUS STRATEGY', prompt.includes('PREVIOUS STRATEGY')],
        ['RECENT ACTIONS', prompt.includes('RECENT ACTIONS')],
        ['AVAILABLE ACTIONS', prompt.includes('AVAILABLE ACTIONS')],
        ['Blocked with reason', prompt.includes('chop_tree (No path to tree)')],
        ['Recent action errors', prompt.includes('mine: FAILED — No pickaxe equipped')],
        ['Goal history', prompt.includes('gather_wood') && prompt.includes('craft_tools')],
        ['Death context readable', !prompt.includes('"causeHint"')] // Should not be raw JSON
    ];
    for (const [name, pass] of checks) {
        console.log(`  ${pass ? '✓' : '✗'} ${name}`);
        if (!pass) promptAllPass = false;
    }
    if (promptAllPass) console.log('  All prompt checks passed!\n');
    else console.log('  Some prompt checks FAILED!\n');
} catch (e) {
    console.error('  ✗ buildTurnPrompt crashed:', e.message);
    promptAllPass = false;
}

// --- Test 2: parseResponse with various edge cases ---
console.log('=== Test 2: parseResponse ===');
const parseTests = [
    {
        name: 'Clean JSON',
        input: '{ "goal": "test", "reasoning": "r", "actions": [{"name":"explore","params":{}}] }',
        expectSuccess: true
    },
    {
        name: 'Markdown fences',
        input: '```json\n{ "goal": "test", "reasoning": "r", "actions": [{"name":"explore","params":{}}] }\n```',
        expectSuccess: true
    },
    {
        name: 'Trailing commas',
        input: '{ "goal": "test", "reasoning": "r", "actions": [{"name":"explore","params":{},}], }',
        expectSuccess: true
    },
    {
        name: 'Text before JSON',
        input: 'Here is my response:\n{ "goal": "test", "reasoning": "r", "actions": [{"name":"explore","params":{}}] }',
        expectSuccess: true
    },
    {
        name: 'Multiple JSON objects',
        input: '{ "extra": true } { "goal": "test", "reasoning": "r", "actions": [{"name":"explore","params":{}}] }',
        expectSuccess: true
    },
    {
        name: 'Invalid structure (missing actions)',
        input: '{ "goal": "test", "reasoning": "r" }',
        expectSuccess: false
    }
];

let parseAllPass = true;
for (const test of parseTests) {
    try {
        const result = llm.parseResponse({ content: test.input });
        if (test.expectSuccess) {
            console.log(`  ✓ ${test.name}: parsed successfully`);
        } else {
            console.log(`  ✗ ${test.name}: should have failed but parsed`);
            parseAllPass = false;
        }
    } catch (e) {
        if (!test.expectSuccess) {
            console.log(`  ✓ ${test.name}: correctly rejected`);
        } else {
            console.log(`  ✗ ${test.name}: should have parsed but failed (${e.message})`);
            parseAllPass = false;
        }
    }
}
if (parseAllPass) console.log('  All parser checks passed!\n');
else console.log('  Some parser checks FAILED!\n');

// --- Test 3: computeNextStep with colored wool ---
console.log('=== Test 3: computeNextStep (colored wool) ===');
const testObs = (woolName) => ({
    inventory: {
        slots: [
            { name: woolName, count: 3 },
            { name: 'oak_planks', count: 4 },
            { name: 'stick', count: 4 },
            { name: 'stone_pickaxe', count: 1 },
            { name: 'stone_axe', count: 1 }
        ]
    },
    player: { position: { y: 64 }, health: 20, food: 20 },
    environment: { timeOfDay: 6000, nearbyCraftingTable: { distance: 2 } },
    entities: { mobs: [] }
});

const strategic = { currentTier: 'stone_tools', missing: [] };

const woolTests = [
    ['white_wool', 'white_bed'],
    ['orange_wool', 'orange_bed'],
    ['blue_wool', 'blue_bed'],
    ['black_wool', 'black_bed']
];

let woolAllPass = true;
for (const [wool, expectedBed] of woolTests) {
    const step = llm.computeNextStep(testObs(wool), strategic);
    const pass = step && step.includes(expectedBed);
    console.log(`  ${pass ? '✓' : '✗'} ${wool} → ${expectedBed}`);
    if (!pass) woolAllPass = false;
}
if (woolAllPass) console.log('  All wool color checks passed!\n');
else console.log('  Some wool color checks FAILED!\n');

// --- Summary ---
console.log('=== Validation Summary ===');
if (promptAllPass && parseAllPass && woolAllPass) {
    console.log('✓ All validations passed. Changes are ready for testing.');
    process.exit(0);
} else {
    console.log('✗ Some validations failed. Review output above.');
    process.exit(1);
}
