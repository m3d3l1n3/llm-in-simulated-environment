/**
 * Baseline Configuration - Minimal Minecraft Agent
 * 
 * Purpose: Test basic autonomous behavior with core Minecraft actions
 * Actions: break, gather, move, look, craft, place, hunt
 */

module.exports = {
    // Bot Configuration
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'Baseline_Agent',
        version: '1.20.4'
    },

    // Agent Configuration
    agent: {
        loopInterval: 5000,        // Decision loop every 5 seconds
        maxActionsPerLoop: 3,      // Max 3 actions per decision
        logDirectory: './runs',
        runName: null
    },

    // LLM Configuration
    llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        // apiKey: set in .env as OPENAI_API_KEY, or pass explicitly here
        temperature: 0.3,
        maxTokens: 300,
        systemPrompt: `You are a Minecraft survival AI playing like a smart human player.

CORE RULES:
1. Follow the NEXT STEP instruction each turn unless a PRIORITY_ALERT overrides it.
2. NEVER repeat the same action more than 3 times in a row.
3. CHECK INVENTORY before crafting - don't duplicate tools.
4. NEVER craft crafting_table more than once.
5. Only suggest 1-3 actions per response.

SURVIVAL (override all other goals):
- Health low + have food: eat immediately.
- Drowning/low oxygen: swim_up NOW.
- Taking damage from hostiles: flee_from first, eat, then reassess.
- Night time: build_shelter or sleep_if_possible.

GAMEPLAY LOOP:
1. Gather wood -> craft planks -> sticks -> crafting_table (once)
2. Craft wooden_pickaxe -> mine stone -> craft stone tools
3. Build shelter at night, craft bed (3 wool + 3 planks)
4. Hunt animals for food when hungry
5. Explore, mine coal for torches, upgrade tools

KEY ACTIONS: chop_tree, craft, mine, attack, eat, explore, build_shelter, sleep_if_possible, flee_from, swim_up, dig_to_surface, break_around, pillar_up

Respond with JSON: { "goal": "...", "reasoning": "...", "actions": [{ "name": "...", "params": {...} }] }`
    },

    // Experiment Configuration
    experiment: {
        name: 'Baseline',
        description: 'Basic autonomous behavior test',
        duration: 180000,          // 3 minutes
        seed: '-1613247987266390429',
        perturbations: []
    }
};
