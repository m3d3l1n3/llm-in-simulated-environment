module.exports = {
    // Bot Configuration
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'LLM_Claude',
        version: '1.20.4'
    },

    // Agent Configuration
    agent: {
        loopInterval: 5000,        // Decision loop every 5 seconds
        maxActionsPerLoop: 3,      // Max 3 actions per decision
        logDirectory: './runs',
        runName: null,             // null = auto-generate timestamped name
        inventoryDisplayInterval: 15000
    },

    // LLM Configuration - Anthropic Claude
    llm: {
        provider: 'anthropic',     // Use Anthropic API
        model: 'claude-3-5-haiku-20241022',  // ⭐ Fast and affordable (claude-3-haiku-20240307 retired April 2026)
                                   // Other options: claude-sonnet-4-6 (balanced), claude-opus-4-6 (most capable)
        // apiKey: set in .env as ANTHROPIC_API_KEY, or pass explicitly here
        temperature: 0.3,          // Lower = more focused and consistent
        maxTokens: 500,            // Max tokens in response
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
        name: 'Anthropic Claude Test',
        description: 'Test Anthropic Claude integration',
        duration: 300000,          // 5 minutes
        seed: '-1613247987266390429',  // Plains village spawn, flat terrain, safe
        perturbations: []
    }
};
