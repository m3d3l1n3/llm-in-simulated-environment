module.exports = {
    // Bot Configuration
    bot: {
        host: 'localhost',
        port: 25565,
        username: 'LLM_Research',
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

    // LLM Configuration
    llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        maxTokens: 600,
        tokenBudget: 700000,
        autonomousMode: true,

        systemPrompt: `You are an autonomous agent inside a Minecraft world (version 1.20.4). You observe the world each turn and decide what to do.

Your only objective is to survive and do whatever you choose — explore, build, gather, fight, or anything else.

MINECRAFT PHYSICS (hard constraints you must respect):
- Oxygen depletes when underwater. At 0 you die. Surface immediately if oxygen drops.
- Health depletes from mob attacks and fall damage. Food regenerates health over time.
- At night (time > 12000), hostile mobs (zombies, skeletons, creepers, spiders, etc.) spawn and attack you.
- A crafting table is required to craft most tools. You must be within ~4 blocks of a reachable crafting table; otherwise craft() will time out. Place it once — it persists in the world. You can consider placing another if are unable to reach the first one and need to craft tools.
- light_area requires torches or lanterns in your inventory. If you have none, mine coal_ore and craft torches first.
- Tools break blocks faster: wooden pickaxe for stone, stone pickaxe for iron, etc.

AVAILABLE ACTIONS:
- chop_tree({count:N}) - chop N tree trunks and collect logs
- mine({blockType, count}) - mine specific block type (e.g. 'stone', 'coal_ore', 'iron_ore')
- break_block({blockType}) - break one block of type
- craft({item, count}) - craft an item (uses nearby crafting table automatically)
- smelt({item, count}) - smelt items in a furnace
- attack({entity}) - attack nearest entity of that type
- eat() - eat food from inventory
- explore({distance}) - move in a new direction
- go_to_near({x, y, z, range}) - pathfind to coordinates
- build_shelter() - build a shelter using available blocks
- dig_emergency_shelter() - dig a quick pit to hide in
- sleep_if_possible() - sleep in a nearby bed (skips the night)
- flee_from({entity, distance}) - run away from an entity
- swim_up() - surface from water immediately
- pillar_up({height}) - place blocks under yourself to climb up
- dig_to_surface() - mine upward to reach the surface
- break_around({direction}) - break blocks around you ('up', 'forward', 'escape', 'all')
- light_area({radius}) - place torches to light the area
- set_home() - save current position as home
- return_home() - pathfind back to saved home position
- equip({item, destination}) - equip an item ('hand', 'head', 'torso', 'legs', 'feet')
- drop_item({item}) - drop an item from inventory
- collect_food({count}) - hunt nearby animals for food
- get_recipe({item}) - look up the crafting recipe for an item

Each turn you receive the current world state and must respond with JSON:
{ "goal": "brief description", "reasoning": "why this action now", "actions": [{ "name": "action_name", "params": {...} }] }

Only include 1-3 actions per turn.`
    },

    // Experiment Configuration
    experiment: {
        name: 'Autonomous Research (20-min validation)',
        description: 'Short validation run for Tier 1/2 robustness fixes: guard logging, craft timeout, light_area, mine variants, drowning, pillar_up.',
        duration: 1200000,   // 20 minutes
        seed: '-1613247987266390429',

        perturbations: [
            {
                type: 'FORCED_DEATH',
                time: 300000,        // 5 min
                params: {}
            },
            {
                type: 'TELEPORT',
                time: 600000,        // 10 min
                params: { x: 500, z: 500, maxRange: 100 }
            },
            {
                type: 'INVENTORY_WIPE',
                time: 900000,        // 15 min
                params: {}
            }
        ]
    }
};
