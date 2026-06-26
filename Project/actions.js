/**
 * Minecraft Bot Actions - Complete Implementation for LLM Simulation
 * Mineflayer 4.33.0 / Minecraft 1.20.4
 * 
 * Categories:
 * - Sensing: get_status, get_inventory, scan_blocks, scan_entities, get_nearby_summary
 * - Locomotion: go_to_near, explore, follow
 * - Manipulation: break_block, place_block, equip, open_container, transfer_items
 * - Production: ensure_crafted, smelt, mine, chop_tree, collect_food
 * - Survival: eat, sleep_if_possible, flee_from, attack, light_area, build_shelter, set_home, return_home
 */

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalXZ, GoalFollow, GoalInvert, GoalGetToBlock } = goals;
const Vec3 = require('vec3');

// Debug logging - set to false for cleaner output
const DEBUG = false;
const log = (tag, msg) => { if (DEBUG) console.log(`[${tag}] ${msg}`); };

class Actions {
    constructor(bot) {
        this.bot = bot;
        this.mcData = require('minecraft-data')(bot.version);
        this.shouldInterrupt = null; // Set by AgentRuntime for reactive danger interrupts
        this.visitedChunks = new Set(); // Coarse grid of explored chunk coords (chunkX_chunkZ)
        
        // Load pathfinder plugin if not already loaded
        if (!bot.pathfinder) {
            bot.loadPlugin(pathfinder);
        }
        
        // Configure movements
        this.movements = new Movements(bot);
        this.movements.canDig = true;
        this.movements.digCost = 40;
        this.movements.allowParkour = true;
        this.movements.allowSprinting = true;
        this.movements.scafoldingBlocks = [];
        this.movements.maxDropDown = 2;  // Conservative: avoid cliff falls (>2 block drops)
        this.movements.liquidCost = 100;  // Heavily penalize water paths to avoid drowning loops
        this.movements.infiniteLiquidDropdownDistance = false;  // Respect maxDropDown for water landings
        
        // Allow breaking through leaves (they're not real obstacles)
        const leafBlocks = ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 
                           'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
                           'azalea_leaves', 'flowering_azalea_leaves'];
        for (const leafName of leafBlocks) {
            const leafData = this.mcData.blocksByName[leafName];
            if (leafData) {
                this.movements.blocksCantBreak.delete(leafData.id);
            }
        }
        
        bot.pathfinder.setMovements(this.movements);
        
        // Pathfinding timeout (ms)
        this.pathfindTimeout = 15000; // 15 seconds max for pathfinding
        
        // Home position storage
        this.homePosition = null;
        
        // Action history for tracking
        this.actionHistory = [];
        
        // Current open container reference
        this.currentContainer = null;
        
        // Cache for web lookups (avoid repeated queries)
        this.recipeCache = new Map();
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Wait for specified milliseconds
     */
    async wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get distance to a position
     */
    distanceTo(pos) {
        return this.bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z));
    }
    
    /**
     * Look up a Minecraft recipe or tip from the web
     * Uses the Minecraft Wiki API
     * @param {string} query - What to look up (e.g., "iron pickaxe recipe")
     */
    async webLookup(query) {
        // Check cache first
        const cacheKey = query.toLowerCase().trim();
        if (this.recipeCache.has(cacheKey)) {
            log("webLookup", `Cache hit for: ${query}`);
            return this.recipeCache.get(cacheKey);
        }
        
        const https = require('https');
        
        // Try Minecraft Wiki API
        const searchUrl = `https://minecraft.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
        
        try {
            const searchResult = await this.httpGet(searchUrl);
            const data = JSON.parse(searchResult);
            
            if (data.query && data.query.search && data.query.search.length > 0) {
                const pageTitle = data.query.search[0].title;
                const snippet = data.query.search[0].snippet.replace(/<[^>]*>/g, ''); // Remove HTML tags
                
                const result = {
                    success: true,
                    title: pageTitle,
                    summary: snippet,
                    source: 'minecraft.wiki'
                };
                
                // Cache the result
                this.recipeCache.set(cacheKey, result);
                log("webLookup", `Found: ${pageTitle}`);
                return result;
            }
            
            return { success: false, error: 'No results found' };
        } catch (error) {
            log("webLookup", `Error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Helper for HTTP GET requests
     */
    httpGet(url) {
        const https = require('https');
        const http = require('http');
        const protocol = url.startsWith('https') ? https : http;
        
        return new Promise((resolve, reject) => {
            const req = protocol.get(url, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }
    
    /**
     * Get recipe info from built-in database (faster than web lookup)
     * @param {string} itemName - Name of item to get recipe for
     */
    getRecipeInfo(itemName) {
        // Built-in recipe database for common items
        const recipes = {
            // Basic crafting
            'oak_planks': { ingredients: ['oak_log x1'], result: 'oak_planks x4', table: false },
            'spruce_planks': { ingredients: ['spruce_log x1'], result: 'spruce_planks x4', table: false },
            'birch_planks': { ingredients: ['birch_log x1'], result: 'birch_planks x4', table: false },
            'stick': { ingredients: ['planks x2'], result: 'stick x4', table: false, pattern: 'vertical' },
            'crafting_table': { ingredients: ['planks x4'], result: 'crafting_table x1', table: false, pattern: '2x2' },
            
            // Tools
            'wooden_pickaxe': { ingredients: ['planks x3', 'stick x2'], result: 'wooden_pickaxe x1', table: true, pattern: 'pickaxe' },
            'wooden_axe': { ingredients: ['planks x3', 'stick x2'], result: 'wooden_axe x1', table: true, pattern: 'axe' },
            'wooden_shovel': { ingredients: ['planks x1', 'stick x2'], result: 'wooden_shovel x1', table: true, pattern: 'shovel' },
            'wooden_sword': { ingredients: ['planks x2', 'stick x1'], result: 'wooden_sword x1', table: true, pattern: 'sword' },
            'wooden_hoe': { ingredients: ['planks x2', 'stick x2'], result: 'wooden_hoe x1', table: true, pattern: 'hoe' },
            
            'stone_pickaxe': { ingredients: ['cobblestone x3', 'stick x2'], result: 'stone_pickaxe x1', table: true, pattern: 'pickaxe' },
            'stone_axe': { ingredients: ['cobblestone x3', 'stick x2'], result: 'stone_axe x1', table: true, pattern: 'axe' },
            'stone_shovel': { ingredients: ['cobblestone x1', 'stick x2'], result: 'stone_shovel x1', table: true, pattern: 'shovel' },
            'stone_sword': { ingredients: ['cobblestone x2', 'stick x1'], result: 'stone_sword x1', table: true, pattern: 'sword' },
            'stone_hoe': { ingredients: ['cobblestone x2', 'stick x2'], result: 'stone_hoe x1', table: true, pattern: 'hoe' },
            
            'iron_pickaxe': { ingredients: ['iron_ingot x3', 'stick x2'], result: 'iron_pickaxe x1', table: true, pattern: 'pickaxe' },
            'iron_axe': { ingredients: ['iron_ingot x3', 'stick x2'], result: 'iron_axe x1', table: true, pattern: 'axe' },
            'iron_shovel': { ingredients: ['iron_ingot x1', 'stick x2'], result: 'iron_shovel x1', table: true, pattern: 'shovel' },
            'iron_sword': { ingredients: ['iron_ingot x2', 'stick x1'], result: 'iron_sword x1', table: true, pattern: 'sword' },
            
            'diamond_pickaxe': { ingredients: ['diamond x3', 'stick x2'], result: 'diamond_pickaxe x1', table: true, pattern: 'pickaxe' },
            'diamond_axe': { ingredients: ['diamond x3', 'stick x2'], result: 'diamond_axe x1', table: true, pattern: 'axe' },
            'diamond_sword': { ingredients: ['diamond x2', 'stick x1'], result: 'diamond_sword x1', table: true, pattern: 'sword' },
            
            // Utility blocks
            'furnace': { ingredients: ['cobblestone x8'], result: 'furnace x1', table: true, pattern: 'hollow square' },
            'chest': { ingredients: ['planks x8'], result: 'chest x1', table: true, pattern: 'hollow square' },
            'torch': { ingredients: ['coal x1', 'stick x1'], result: 'torch x4', table: false, pattern: 'vertical' },
            'ladder': { ingredients: ['stick x7'], result: 'ladder x3', table: true, pattern: 'H shape' },
            'fence': { ingredients: ['planks x4', 'stick x2'], result: 'fence x3', table: true },
            'bed': { ingredients: ['wool x3', 'planks x3'], result: 'bed x1', table: true },
            
            // Armor
            'iron_helmet': { ingredients: ['iron_ingot x5'], result: 'iron_helmet x1', table: true },
            'iron_chestplate': { ingredients: ['iron_ingot x8'], result: 'iron_chestplate x1', table: true },
            'iron_leggings': { ingredients: ['iron_ingot x7'], result: 'iron_leggings x1', table: true },
            'iron_boots': { ingredients: ['iron_ingot x4'], result: 'iron_boots x1', table: true },
            'shield': { ingredients: ['planks x6', 'iron_ingot x1'], result: 'shield x1', table: true },
            
            // Food & farming
            'bread': { ingredients: ['wheat x3'], result: 'bread x1', table: true },
            'bowl': { ingredients: ['planks x3'], result: 'bowl x4', table: true },
            'bucket': { ingredients: ['iron_ingot x3'], result: 'bucket x1', table: true },
            
            // Smelting (furnace recipes)
            'iron_ingot': { ingredients: ['iron_ore x1', 'fuel'], result: 'iron_ingot x1', method: 'smelting' },
            'gold_ingot': { ingredients: ['gold_ore x1', 'fuel'], result: 'gold_ingot x1', method: 'smelting' },
            'glass': { ingredients: ['sand x1', 'fuel'], result: 'glass x1', method: 'smelting' },
            'stone': { ingredients: ['cobblestone x1', 'fuel'], result: 'stone x1', method: 'smelting' },
            'charcoal': { ingredients: ['log x1', 'fuel'], result: 'charcoal x1', method: 'smelting' },
            'cooked_beef': { ingredients: ['raw_beef x1', 'fuel'], result: 'cooked_beef x1', method: 'smelting' },
            'cooked_porkchop': { ingredients: ['raw_porkchop x1', 'fuel'], result: 'cooked_porkchop x1', method: 'smelting' },
            'cooked_chicken': { ingredients: ['raw_chicken x1', 'fuel'], result: 'cooked_chicken x1', method: 'smelting' },
        };
        
        const normalizedName = itemName.toLowerCase().replace(/ /g, '_');
        const recipe = recipes[normalizedName];
        
        if (recipe) {
            return {
                success: true,
                item: normalizedName,
                ...recipe,
                tip: recipe.table ? 'Requires crafting table' : 'Can craft in inventory (2x2)'
            };
        }
        
        // Try to find partial match
        const matches = Object.keys(recipes).filter(k => k.includes(normalizedName) || normalizedName.includes(k));
        if (matches.length > 0) {
            return {
                success: true,
                item: matches[0],
                ...recipes[matches[0]],
                tip: recipes[matches[0]].table ? 'Requires crafting table' : 'Can craft in inventory (2x2)',
                note: `Did you mean: ${matches.join(', ')}?`
            };
        }
        
        return {
            success: false,
            error: `Recipe not found for: ${itemName}`,
            tip: 'Try: wooden_pickaxe, stone_pickaxe, furnace, torch, chest'
        };
    }

    /**
     * Stop all current actions
     */
    stop() {
        this.bot.pathfinder.stop();
        this.bot.clearControlStates();
        try {
            if (this.bot.pathfinder.isMoving()) {
                this.bot.pathfinder.setGoal(null);
            }
        } catch (e) { }
    }

    // ==================== SENSING TOOLS ====================

    /**
     * Get bot status including health, food, position, etc.
     */
    getStatus() {
        const pos = this.bot.entity.position;
        return {
            health: this.bot.health,
            food: this.bot.food,
            saturation: this.bot.foodSaturation,
            oxygen: this.bot.oxygenLevel,
            position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            velocity: this.bot.entity.velocity,
            yaw: this.bot.entity.yaw,
            pitch: this.bot.entity.pitch,
            onGround: this.bot.entity.onGround,
            isInWater: this.bot.entity.isInWater,
            isInLava: this.bot.entity.isInLava,
            isRaining: this.bot.isRaining,
            experience: {
                level: this.bot.experience.level,
                points: this.bot.experience.points,
                progress: this.bot.experience.progress
            },
            gameMode: this.bot.game.gameMode,
            difficulty: this.bot.game.difficulty,
            time: this.bot.time.timeOfDay,
            isDay: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000
        };
    }

    /**
     * Get inventory contents
     */
    getInventory() {
        const items = this.bot.inventory.items();
        return {
            items: items.map(item => ({
                name: item.name,
                displayName: item.displayName,
                count: item.count,
                slot: item.slot,
                maxStackSize: item.stackSize
            })),
            emptySlots: this.bot.inventory.emptySlotCount(),
            selectedSlot: this.bot.quickBarSlot,
            heldItem: this.bot.heldItem ? {
                name: this.bot.heldItem.name,
                count: this.bot.heldItem.count
            } : null
        };
    }

    /**
     * Scan for blocks of specific types within range
     * @param {string|string[]} blockTypes - Block type(s) to search for
     * @param {number} maxDistance - Maximum search distance (default 32)
     * @param {number} count - Maximum number of blocks to find (default 10)
     */
    scanBlocks(blockTypes, maxDistance = 32, count = 10) {
        const types = Array.isArray(blockTypes) ? blockTypes : [blockTypes];
        const blockIds = [];
        
        for (const typeName of types) {
            const blockData = this.mcData.blocksByName[typeName];
            if (blockData) {
                blockIds.push(blockData.id);
            }
        }

        if (blockIds.length === 0) {
            return { blocks: [], error: `Unknown block types: ${types.join(', ')}` };
        }

        const positions = this.bot.findBlocks({
            matching: blockIds,
            maxDistance: maxDistance,
            count: count
        });

        const blocks = positions.map(pos => {
            const block = this.bot.blockAt(pos);
            return {
                name: block ? block.name : 'unknown',
                position: { x: pos.x, y: pos.y, z: pos.z },
                distance: this.distanceTo(pos)
            };
        });

        // Sort by distance
        blocks.sort((a, b) => a.distance - b.distance);

        return { blocks };
    }

    /**
     * Scan for entities within range
     * @param {string} entityType - Entity type to search for (optional, all if not specified)
     * @param {number} maxDistance - Maximum search distance (default 32)
     */
    scanEntities(entityType = null, maxDistance = 32) {
        const entities = [];
        const botPos = this.bot.entity.position;

        for (const entity of Object.values(this.bot.entities)) {
            if (entity === this.bot.entity) continue;
            
            const distance = entity.position.distanceTo(botPos);
            if (distance > maxDistance) continue;

            const searchType = entityType ? entityType.toLowerCase() : null;
            const matchesType = !searchType || 
                (entity.name && entity.name.toLowerCase() === searchType) || 
                (entity.name && entity.name.toLowerCase().includes(searchType)) ||
                (entity.displayName && entity.displayName.toLowerCase().includes(searchType));

            if (matchesType) {
                entities.push({
                    name: entity.name,
                    displayName: entity.displayName || entity.name,
                    type: entity.type,
                    position: {
                        x: Math.floor(entity.position.x),
                        y: Math.floor(entity.position.y),
                        z: Math.floor(entity.position.z)
                    },
                    distance: Math.floor(distance),
                    health: entity.health,
                    isHostile: this.isHostile(entity)
                });
            }
        }

        // Sort by distance
        entities.sort((a, b) => a.distance - b.distance);

        return { entities };
    }

    /**
     * Check if an entity is hostile
     */
    isHostile(entity) {
        const hostileMobs = [
            'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
            'slime', 'phantom', 'drowned', 'husk', 'stray', 'pillager',
            'vindicator', 'evoker', 'ravager', 'vex', 'warden', 'piglin_brute',
            'hoglin', 'zoglin', 'blaze', 'ghast', 'magma_cube', 'wither_skeleton'
        ];
        return hostileMobs.includes(entity.name?.toLowerCase());
    }

    /**
     * Get a summary of nearby environment
     * @param {number} range - Range to scan (default 16)
     */
    getNearbySummary(range = 16) {
        const pos = this.bot.entity.position;
        
        // Count block types nearby
        const blockCounts = {};
        const interestingBlocks = [
            'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
            'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'deepslate_coal_ore',
            'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore', 'deepslate_copper_ore',
            'crafting_table', 'furnace', 'chest', 'water', 'lava',
            'sand', 'gravel', 'clay', 'sugar_cane', 'wheat', 'carrots', 'potatoes'
        ];

        for (const blockName of interestingBlocks) {
            const blockData = this.mcData.blocksByName[blockName];
            if (blockData) {
                const found = this.bot.findBlocks({
                    matching: blockData.id,
                    maxDistance: range,
                    count: 64
                });
                if (found.length > 0) {
                    blockCounts[blockName] = found.length;
                }
            }
        }

        // Count entities
        const entityCounts = {};
        for (const entity of Object.values(this.bot.entities)) {
            if (entity === this.bot.entity) continue;
            const distance = entity.position.distanceTo(pos);
            if (distance <= range && entity.name) {
                entityCounts[entity.name] = (entityCounts[entity.name] || 0) + 1;
            }
        }

        // Get biome
        const biome = this.bot.blockAt(pos.floored())?.biome?.name || 'unknown';

        // Light level at bot position
        const blockAtBot = this.bot.blockAt(pos.floored());
        const lightLevel = blockAtBot ? blockAtBot.light : 0;

        return {
            position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            biome,
            lightLevel,
            isDay: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000,
            blocks: blockCounts,
            entities: entityCounts,
            nearbyPlayers: Object.values(this.bot.players)
                .filter(p => p.entity && p.entity.position.distanceTo(pos) <= range)
                .map(p => ({ name: p.username, distance: Math.floor(p.entity.position.distanceTo(pos)) }))
        };
    }

    // ==================== LOCOMOTION ====================

    /**
     * Move to a position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     * @param {number} range - How close to get (default 2)
     */
    async goToNear(x, y, z, range = 2) {
        // Guard: LLM sometimes passes string targets like "birch_log" instead of coordinates
        if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || isNaN(x) || isNaN(y) || isNaN(z)) {
            return {
                success: false,
                error: `Invalid target coordinates (${typeof x}, ${typeof y}, ${typeof z}). go_to_near requires numeric x, y, z. Use explore() to move to a general area, or pass specific coordinates.`,
                hint: 'Example: { "name": "go_to_near", "params": { "x": 100, "y": 64, "z": 200, "distance": 5 } }'
            };
        }

        const goal = new GoalNear(x, y, z, range);
        const targetPos = new Vec3(x, y, z);
        const startPos = this.bot.entity.position.clone();
        
        // Check if we're already in range
        const currentDist = this.bot.entity.position.distanceTo(targetPos);
        log("goToNear", `Target: (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}), distance: ${currentDist.toFixed(1)}, range: ${range}`);
        
        if (currentDist <= range) {
            log("goToNear", `Already in range`);
            return {
                success: true,
                position: {
                    x: Math.floor(this.bot.entity.position.x),
                    y: Math.floor(this.bot.entity.position.y),
                    z: Math.floor(this.bot.entity.position.z)
                }
            };
        }
        
        try {
            // Add timeout to pathfinding
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Pathfinding timeout')), this.pathfindTimeout || 10000)
            );
            
            log("goToNear", `Starting pathfinding...`);
            await Promise.race([this.bot.pathfinder.goto(goal), timeoutPromise]);
            log("goToNear", `Pathfinding completed`);
            return {
                success: true,
                position: {
                    x: Math.floor(this.bot.entity.position.x),
                    y: Math.floor(this.bot.entity.position.y),
                    z: Math.floor(this.bot.entity.position.z)
                }
            };
        } catch (error) {
            log("goToNear", `Pathfinding error: ${error.message}`);
            
            // Check if we got close enough despite the error
            const finalDist = this.bot.entity.position.distanceTo(targetPos);
            log("goToNear", `Final distance: ${finalDist.toFixed(1)}`);
            
            if (finalDist <= range + 1) {
                return {
                    success: true,
                    position: {
                        x: Math.floor(this.bot.entity.position.x),
                        y: Math.floor(this.bot.entity.position.y),
                        z: Math.floor(this.bot.entity.position.z)
                    }
                };
            }
            
            // Check if there are leaves blocking the path - break them
            const direction = targetPos.minus(this.bot.entity.position).normalize();
            for (let d = 1; d <= 3; d++) {
                const checkPos = this.bot.entity.position.offset(
                    Math.round(direction.x * d),
                    0,
                    Math.round(direction.z * d)
                ).floored();
                
                const blockInWay = this.bot.blockAt(checkPos);
                if (blockInWay && blockInWay.name.includes('leaves')) {
                    log("goToNear", `Breaking leaves at ${checkPos.x}, ${checkPos.y}, ${checkPos.z}`);
                    try {
                        await this.bot.dig(blockInWay);
                    } catch (e) { }
                }
            }
            
            // Check for danger interrupt before attempting slow fallback walk
            if (this.shouldInterrupt?.()) {
                throw new Error('Interrupted by danger system');
            }

            // Try simple walking as fallback
            try {
                log("goToNear", `Trying simple walk fallback...`);
                await this.bot.lookAt(targetPos, true);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true); // Jump over obstacles
                await this.wait(Math.min(finalDist * 300, 4000));
                this.bot.setControlState('forward', false);
                this.bot.setControlState('jump', false);
                
                // Check distance again
                const newDist = this.bot.entity.position.distanceTo(targetPos);
                log("goToNear", `After walk, distance: ${newDist.toFixed(1)}`);
                if (newDist <= range + 2) {
                    return {
                        success: true,
                        position: {
                            x: Math.floor(this.bot.entity.position.x),
                            y: Math.floor(this.bot.entity.position.y),
                            z: Math.floor(this.bot.entity.position.z)
                        }
                    };
                }
            } catch (e) {
                this.bot.setControlState('forward', false);
                this.bot.setControlState('jump', false);
            }
            
            // MICRO-JUMP FALLBACK: pathfinder often fails on 1-block ledges.
            // Only apply in guided/heuristic mode — autonomous should experience raw pathfinder
            // limitations as part of the emergent behavior dataset.
            const autonomousMode = this.bot?.agent?.config?.llm?.autonomousMode ?? false;
            if (!autonomousMode) {
            const microAttempts = [
                { name: 'step_up', pitch: -0.3, jump: true, ms: 600 },
                { name: 'step_down', pitch: 0.3, jump: false, ms: 600 },
                { name: 'level_retry', pitch: 0, jump: true, ms: 800 }
            ];
            
            for (const attempt of microAttempts) {
                const beforePos = this.bot.entity.position.clone();
                try {
                    log("goToNear", `Micro-jump: ${attempt.name}`);
                    // Look horizontally toward target but with pitch adjustment for step up/down
                    const lookYaw = Math.atan2(targetPos.x - this.bot.entity.position.x, targetPos.z - this.bot.entity.position.z);
                    await this.bot.look(lookYaw, attempt.pitch);
                    this.bot.setControlState('forward', true);
                    this.bot.setControlState('jump', attempt.jump);
                    await this.wait(attempt.ms);
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('jump', false);
                    
                    const afterPos = this.bot.entity.position;
                    const moved = afterPos.distanceTo(beforePos);
                    const newDist = afterPos.distanceTo(targetPos);
                    log("goToNear", `Micro-jump ${attempt.name}: moved ${moved.toFixed(2)}, dist now ${newDist.toFixed(1)}`);
                    
                    if (newDist <= range + 2) {
                        return {
                            success: true,
                            position: {
                                x: Math.floor(afterPos.x),
                                y: Math.floor(afterPos.y),
                                z: Math.floor(afterPos.z)
                            }
                        };
                    }
                    if (moved > 0.5) {
                        // Made progress — try normal pathfinding again from new position
                        log("goToNear", `Micro-jump made progress, retrying pathfinder`);
                        try {
                            const retryTimeout = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('retry timeout')), 5000)
                            );
                            await Promise.race([this.bot.pathfinder.goto(goal), retryTimeout]);
                            return {
                                success: true,
                                position: {
                                    x: Math.floor(this.bot.entity.position.x),
                                    y: Math.floor(this.bot.entity.position.y),
                                    z: Math.floor(this.bot.entity.position.z)
                                }
                            };
                        } catch (retryErr) {
                            // retry failed, continue to next micro-attempt
                        }
                    }
                } catch (e) {
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('jump', false);
                }
            }
            
            // FINAL FALLBACK: if we have placeable blocks, try placing one under feet
            // to step up onto a ledge, then jump
            const placeable = this.bot.inventory.items().find(i => 
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks')
            );
            if (placeable) {
                try {
                    log("goToNear", `Trying place-block step up with ${placeable.name}`);
                    await this.bot.equip(placeable, 'hand');
                    const feetPos = this.bot.entity.position.floored();
                    const blockBelow = this.bot.blockAt(feetPos.offset(0, -1, 0));
                    if (blockBelow && blockBelow.name !== 'air') {
                        await this.bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
                        await this.wait(200);
                        // Jump onto the placed block
                        this.bot.setControlState('jump', true);
                        await this.wait(500);
                        this.bot.setControlState('jump', false);
                        
                        const newDist = this.bot.entity.position.distanceTo(targetPos);
                        if (newDist <= range + 2) {
                            return {
                                success: true,
                                position: {
                                    x: Math.floor(this.bot.entity.position.x),
                                    y: Math.floor(this.bot.entity.position.y),
                                    z: Math.floor(this.bot.entity.position.z)
                                }
                            };
                        }
                    }
                } catch (e) {
                    log("goToNear", `Place-block step up failed: ${e.message}`);
                }
            }
            
            } // end if (!autonomousMode)
            
            // Movement validation: detect if bot didn't move at all (truly stuck)
            const distanceMoved = this.bot.entity.position.distanceTo(startPos);
            if (distanceMoved < 1.5) {
                throw new Error(`Truly stuck: no movement toward (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}). Pathfinding and walk fallback both failed.`);
            }

            throw new Error(`Failed to reach (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}): ${error.message}`);
        }
    }

    /**
     * Explore in a random direction
     * @param {number} distance - How far to explore (default 50)
     */
    async explore(distance = 50) {
        const pos = this.bot.entity.position.floored();

        // Record current chunk as visited
        const curChunkKey = `${Math.floor(pos.x / 16)}_${Math.floor(pos.z / 16)}`;
        this.visitedChunks.add(curChunkKey);

        const dirs = [
            { x: 1, z: 0, name: 'east' },
            { x: -1, z: 0, name: 'west' },
            { x: 0, z: 1, name: 'south' },
            { x: 0, z: -1, name: 'north' },
            { x: 1, z: 1, name: 'south_east' },
            { x: -1, z: 1, name: 'south_west' },
            { x: 1, z: -1, name: 'north_east' },
            { x: -1, z: -1, name: 'north_west' }
        ];

        const scored = dirs.map(dir => {
            let hazardPenalty = 0;
            let waterDetected = false;
            let cliffDetected = false;
            for (let d = 1; d <= 10; d++) {
                const foot = this.bot.blockAt(pos.offset(dir.x * d, -1, dir.z * d));
                const body = this.bot.blockAt(pos.offset(dir.x * d, 0, dir.z * d));
                const head = this.bot.blockAt(pos.offset(dir.x * d, 1, dir.z * d));
                if (!foot || foot.name === 'air') {
                    // Check how deep the drop is — 1-2 blocks is fine, 3+ is dangerous
                    let dropDepth = 0;
                    for (let drop = 1; drop <= 4; drop++) {
                        const below = this.bot.blockAt(pos.offset(dir.x * d, -1 - drop, dir.z * d));
                        if (below && below.name !== 'air' && below.name !== 'water') break;
                        dropDepth++;
                    }
                    if (dropDepth >= 3) {
                        hazardPenalty += 15;
                        cliffDetected = true;
                    } else if (dropDepth >= 1) {
                        hazardPenalty += 4; // Minor drop
                    }
                    if (d <= 3 && dropDepth >= 2) break; // Early termination for nearby cliffs
                }
                if (foot?.name === 'water' || body?.name === 'water' || head?.name === 'water') {
                    if (!waterDetected) {
                        hazardPenalty += 12;
                        waterDetected = true;
                    }
                    if (d <= 3) hazardPenalty += 6; // Extra penalty for nearby water
                }
                if (foot?.name === 'lava' || body?.name === 'lava') hazardPenalty += 25;
            }
            // Penalise directions that lead into already-explored chunks
            const targetChunkX = Math.floor((pos.x + dir.x * distance) / 16);
            const targetChunkZ = Math.floor((pos.z + dir.z * distance) / 16);
            const alreadyVisited = this.visitedChunks.has(`${targetChunkX}_${targetChunkZ}`);
            const visitedPenalty = alreadyVisited ? 5 : 0;

            const random = Math.random() * 3;
            return { dir, score: random - hazardPenalty - visitedPenalty, waterDetected, cliffDetected };
        }).sort((a, b) => b.score - a.score);

        const chosen = scored[0].dir;
        const targetX = pos.x + chosen.x * distance;
        const targetZ = pos.z + chosen.z * distance;
        const goal = new GoalXZ(targetX, targetZ);
        
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Explore timeout')), this.pathfindTimeout || 15000)
            );
            await Promise.race([this.bot.pathfinder.goto(goal), timeoutPromise]);
            const distanceTraveled = this.bot.entity.position.distanceTo(pos);
            if (distanceTraveled < 2) {
                return {
                    success: false,
                    error: `Pathfinder claimed success but only moved ${distanceTraveled.toFixed(1)} blocks`,
                    distanceTraveled,
                    direction: chosen.name,
                    position: {
                        x: Math.floor(this.bot.entity.position.x),
                        y: Math.floor(this.bot.entity.position.y),
                        z: Math.floor(this.bot.entity.position.z)
                    }
                };
            }
            return {
                success: true,
                position: {
                    x: Math.floor(this.bot.entity.position.x),
                    y: Math.floor(this.bot.entity.position.y),
                    z: Math.floor(this.bot.entity.position.z)
                },
                distanceTraveled,
                direction: chosen.name
            };
        } catch (error) {
            // Retry once with a shorter distance when pathing fails.
            try {
                const fallbackGoal = new GoalXZ(pos.x + chosen.x * Math.max(10, Math.floor(distance / 2)), pos.z + chosen.z * Math.max(10, Math.floor(distance / 2)));
                const fallbackTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Explore fallback timeout')), this.pathfindTimeout || 15000)
                );
                await Promise.race([this.bot.pathfinder.goto(fallbackGoal), fallbackTimeout]);
                const fallbackDistance = this.bot.entity.position.distanceTo(pos);
                if (fallbackDistance < 2) {
                    return {
                        success: false,
                        error: `Fallback pathfinder claimed success but only moved ${fallbackDistance.toFixed(1)} blocks`,
                        distanceTraveled: fallbackDistance,
                        direction: chosen.name,
                        position: {
                            x: Math.floor(this.bot.entity.position.x),
                            y: Math.floor(this.bot.entity.position.y),
                            z: Math.floor(this.bot.entity.position.z)
                        }
                    };
                }
                return {
                    success: true,
                    fallback: true,
                    direction: chosen.name,
                    distanceTraveled: fallbackDistance,
                    position: {
                        x: Math.floor(this.bot.entity.position.x),
                        y: Math.floor(this.bot.entity.position.y),
                        z: Math.floor(this.bot.entity.position.z)
                    }
                };
            } catch (retryError) {
                // fall through
            }
            // Pathfinding failed — likely stuck in trees or blocked by obstacles.
            // Break surrounding blocks to create a path, then try walking forward.
            try {
                log("explore", `Pathfinding failed at Y=${pos.y}, breaking surrounding blocks`);
                await this.breakAround('escape');
                await this.wait(300);
            } catch (e) {
                log("explore", `breakAround failed: ${e.message}`);
            }
            // MICRO-JUMP FALLBACK: pathfinder often fails on 1-block ledges.
            // Try targeted step-up, step-down, and place-block movements.
            const lookYaw = Math.atan2(chosen.x, chosen.z);
            const microAttempts = [
                { name: 'step_up', pitch: -0.3, jump: true, ms: 600 },
                { name: 'step_down', pitch: 0.3, jump: false, ms: 600 },
                { name: 'level_retry', pitch: 0, jump: true, ms: 800 }
            ];
            
            for (const attempt of microAttempts) {
                const beforePos = this.bot.entity.position.clone();
                try {
                    log("explore", `Micro-jump: ${attempt.name}`);
                    await this.bot.look(lookYaw, attempt.pitch);
                    this.bot.setControlState('forward', true);
                    this.bot.setControlState('jump', attempt.jump);
                    await this.wait(attempt.ms);
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('jump', false);
                    
                    const afterPos = this.bot.entity.position;
                    const moved = afterPos.distanceTo(beforePos);
                    log("explore", `Micro-jump ${attempt.name}: moved ${moved.toFixed(2)}`);
                    
                    if (moved > 0.5) {
                        // Made progress — try normal pathfinding again from new position
                        log("explore", `Micro-jump made progress, retrying pathfinder`);
                        try {
                            const retryGoal = new GoalXZ(pos.x + chosen.x * Math.max(10, Math.floor(distance / 2)), pos.z + chosen.z * Math.max(10, Math.floor(distance / 2)));
                            const retryTimeout = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('retry timeout')), 5000)
                            );
                            await Promise.race([this.bot.pathfinder.goto(retryGoal), retryTimeout]);
                            const retryDist = this.bot.entity.position.distanceTo(pos);
                            if (retryDist >= 1) {
                                return {
                                    success: true,
                                    direction: chosen.name,
                                    distanceTraveled: retryDist,
                                    position: {
                                        x: Math.floor(this.bot.entity.position.x),
                                        y: Math.floor(this.bot.entity.position.y),
                                        z: Math.floor(this.bot.entity.position.z)
                                    }
                                };
                            }
                        } catch (retryErr) {
                            // retry failed, continue to next micro-attempt
                        }
                    }
                } catch (e) {
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('jump', false);
                }
            }
            
            // FINAL FALLBACK: place-block step up if we have blocks
            const placeable = this.bot.inventory.items().find(i => 
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks')
            );
            if (placeable) {
                try {
                    log("explore", `Trying place-block step up with ${placeable.name}`);
                    await this.bot.equip(placeable, 'hand');
                    const feetPos = this.bot.entity.position.floored();
                    const blockBelow = this.bot.blockAt(feetPos.offset(0, -1, 0));
                    if (blockBelow && blockBelow.name !== 'air') {
                        await this.bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
                        await this.wait(200);
                        this.bot.setControlState('jump', true);
                        await this.wait(500);
                        this.bot.setControlState('jump', false);
                        
                        const placeDist = this.bot.entity.position.distanceTo(pos);
                        if (placeDist >= 1) {
                            return {
                                success: true,
                                direction: chosen.name,
                                distanceTraveled: placeDist,
                                position: {
                                    x: Math.floor(this.bot.entity.position.x),
                                    y: Math.floor(this.bot.entity.position.y),
                                    z: Math.floor(this.bot.entity.position.z)
                                }
                            };
                        }
                    }
                } catch (e) {
                    log("explore", `Place-block step up failed: ${e.message}`);
                }
            }
            return {
                success: false,
                error: error.message,
                distanceTraveled: this.bot.entity.position.distanceTo(pos)
            };
        }
    }

    /**
     * Follow an entity
     * @param {string} entityName - Name of entity to follow
     * @param {number} range - How close to stay (default 3)
     * @param {number} duration - How long to follow in ms (default 5000)
     */
    async follow(entityName, range = 3, duration = 5000) {
        const entity = this.bot.nearestEntity(e => 
            e.name === entityName || 
            e.displayName?.toLowerCase() === entityName.toLowerCase() ||
            e.username?.toLowerCase() === entityName.toLowerCase()
        );

        if (!entity) {
            return { success: false, error: `Entity '${entityName}' not found nearby` };
        }

        const goal = new GoalFollow(entity, range);
        this.bot.pathfinder.setGoal(goal, true); // Dynamic goal

        // Follow for specified duration
        await this.wait(duration);
        
        this.bot.pathfinder.setGoal(null);

        return {
            success: true,
            followedEntity: entityName,
            finalPosition: {
                x: Math.floor(this.bot.entity.position.x),
                y: Math.floor(this.bot.entity.position.y),
                z: Math.floor(this.bot.entity.position.z)
            }
        };
    }

    // ==================== MANIPULATION ====================

    /**
     * Break a block at specific position or find and break nearest of type
     * @param {number|string} xOrBlockType - X coordinate or block type name
     * @param {number} y - Y coordinate (optional if using block type)
     * @param {number} z - Z coordinate (optional if using block type)
     */
    async breakBlock(xOrBlockType, y = null, z = null) {
        let targetBlock;
        let targetPos;

        log("breakBlock", `Called with: ${xOrBlockType}, ${y}, ${z}`);
        log("breakBlock", `Bot game mode: ${this.bot.game?.gameMode}`);

        if (typeof xOrBlockType === 'string') {
            // Find nearest block of this type
            const blockType = xOrBlockType;
            const blockData = this.mcData.blocksByName[blockType];
            
            if (!blockData) {
                throw new Error(`Unknown block type: ${blockType}`);
            }

            log("breakBlock", `Looking for ${blockType} (id: ${blockData.id})`);

            const positions = this.bot.findBlocks({
                matching: blockData.id,
                maxDistance: 32,
                count: 16
            });

            log("breakBlock", `Found ${positions.length} blocks`);
            if (positions.length > 0) {
                log("breakBlock", `First 3 positions: ${positions.slice(0, 3).map(p => `(${p.x},${p.y},${p.z})`).join(', ')}`);
            }

            if (positions.length === 0) {
                throw new Error(`No ${blockType} found within 32 blocks`);
            }

            // Sort by distance and try each
            positions.sort((a, b) => 
                this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
            );

            for (const pos of positions) {
                const block = this.bot.blockAt(pos);
                if (block && block.name !== 'air') {
                    targetBlock = block;
                    targetPos = pos;
                    break;
                }
            }

            if (!targetBlock) {
                throw new Error(`Could not find valid ${blockType} block`);
            }
        } else {
            // Use coordinates
            targetPos = new Vec3(Math.floor(xOrBlockType), Math.floor(y), Math.floor(z));
            targetBlock = this.bot.blockAt(targetPos);
            
            if (!targetBlock || targetBlock.name === 'air') {
                throw new Error(`No block at position ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
            }
        }

        // Danger interrupt: abort before starting a long dig
        if (this.shouldInterrupt?.()) {
            log("breakBlock", "Interrupted by danger system before dig");
            return { success: false, interrupted: true, reason: 'danger_interrupt', hint: 'Aborted for survival. Flee or swim_up first.' };
        }

        // Equip best tool for this block
        await this.equipBestToolForBlock(targetBlock);

        // Pre-flight check: stone-class blocks need a pickaxe — fail fast rather than mining bare-handed
        // (bare-handed cobblestone can take 60+ seconds, triggering the watchdog)
        const blockNameLower = (targetBlock.name || '').toLowerCase();
        const requiresPickaxe = blockNameLower.includes('stone') || blockNameLower.includes('cobble') ||
            blockNameLower.includes('ore') || blockNameLower.includes('brick') || blockNameLower.includes('basalt');
        const heldItem = this.bot.heldItem;
        if (requiresPickaxe && (!heldItem || !heldItem.name.includes('pickaxe'))) {
            throw new Error(`No pickaxe to mine ${targetBlock.name}. Craft one first.`);
        }

        // Move close enough to dig (within 4.5 blocks which is the reach distance)
        const distance = this.bot.entity.position.distanceTo(targetPos);
        log("breakBlock", `Distance to block: ${distance.toFixed(2)}, bot at (${this.bot.entity.position.x.toFixed(2)}, ${this.bot.entity.position.y.toFixed(2)}, ${this.bot.entity.position.z.toFixed(2)})`);
        if (distance > 4) {
            log("breakBlock", `Need to move closer, calling goToNear`);
            await this.goToNear(targetPos.x, targetPos.y, targetPos.z, 2); // Move to range 2 for auto-pickup
            log("breakBlock", `After move, now at (${this.bot.entity.position.x.toFixed(2)}, ${this.bot.entity.position.y.toFixed(2)}, ${this.bot.entity.position.z.toFixed(2)})`);
        }

        // Re-fetch the block after moving (important!)
        targetBlock = this.bot.blockAt(targetPos);
        if (!targetBlock || targetBlock.name === 'air') {
            return { success: true, message: 'Block already removed' };
        }

        // Check line of sight - make sure there's no block between us and the target
        const botEye = this.bot.entity.position.offset(0, 1.6, 0); // Eye level
        const blockCenter = targetPos.offset(0.5, 0.5, 0.5);
        const raycastResult = this.bot.world.raycast(botEye, blockCenter.minus(botEye).normalize(), 6);
        
        if (raycastResult && raycastResult.position) {
            const hitPos = raycastResult.position;
            // Check if we hit a different block than our target
            if (hitPos.x !== targetPos.x || hitPos.y !== targetPos.y || hitPos.z !== targetPos.z) {
                log("breakBlock", `Line of sight blocked by ${raycastResult.block?.name} at ${hitPos.x},${hitPos.y},${hitPos.z}`);
                // Try to break the blocking block first
                const blockingBlock = this.bot.blockAt(hitPos);
                if (blockingBlock && blockingBlock.name !== 'air') {
                    log("breakBlock", `Breaking obstructing block ${blockingBlock.name} first`);
                    targetBlock = blockingBlock;
                    targetPos = hitPos;
                }
            }
        }

        // Verify we can dig this block
        if (!this.bot.canDigBlock(targetBlock)) {
            throw new Error(`Cannot reach block at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
        }

        // Get a FRESH block reference right before digging
        // This is critical - the old reference may be stale
        targetBlock = this.bot.blockAt(targetPos);
        if (!targetBlock || targetBlock.name === 'air') {
            log("breakBlock", `Block is already air before dig attempt`);
            return { success: true, message: 'Block already removed' };
        }
        const blockName = targetBlock.name;
        log("breakBlock", `Fresh block reference: ${blockName} at ${targetPos.x},${targetPos.y},${targetPos.z}`);

        // Look at the center of the block with force
        const lookTarget = targetPos.offset(0.5, 0.5, 0.5);
        await this.bot.lookAt(lookTarget, true); // force = true

        // Small delay to ensure look is registered
        await this.wait(100);
        
        // Double-check the block is still there before digging
        const preCheckBlock = this.bot.blockAt(targetPos);
        log("breakBlock", `Pre-dig check: block at ${targetPos.x},${targetPos.y},${targetPos.z} is ${preCheckBlock ? preCheckBlock.name : 'null'}`);
        if (!preCheckBlock || preCheckBlock.name === 'air') {
            log("breakBlock", `WARNING: Block was already air before digging!`);
            return { success: true, message: 'Block already removed' };
        }
        
        // Get another FRESH block reference immediately before dig
        const digBlock = this.bot.blockAt(targetPos);
        log("breakBlock", `Digging ${digBlock.name} at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);

        if (this.shouldInterrupt?.()) {
            return { success: false, interrupted: true, reason: 'danger_interrupt', hint: 'Aborted for survival.' };
        }

        // Water/lava safety: don't mine blocks that are directly adjacent to water or lava
        // This prevents accidentally breaching into underwater caves or lava pools
        const adjacentPositions = [
            targetPos.offset(1, 0, 0), targetPos.offset(-1, 0, 0),
            targetPos.offset(0, 1, 0), targetPos.offset(0, -1, 0),
            targetPos.offset(0, 0, 1), targetPos.offset(0, 0, -1)
        ];
        const waterLavaAdjacent = adjacentPositions.some(p => {
            const b = this.bot.blockAt(p);
            return b && (b.name === 'water' || b.name === 'lava');
        });
        if (waterLavaAdjacent) {
            log("breakBlock", `WARNING: Water or lava adjacent to ${blockName} at ${targetPos.x},${targetPos.y},${targetPos.z}! Aborting for safety.`);
            return {
                success: false,
                error: `Water or lava adjacent to ${blockName} — too dangerous to mine from this angle`,
                hint: 'Approach from a different direction or find a different block.'
            };
        }

        const samePosition = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
        const currentlyDiggingSame = this.bot.targetDigBlock && samePosition(this.bot.targetDigBlock.position, targetPos);
        
        try {
            if (currentlyDiggingSame) {
                // Already digging this block (e.g. pathfinder or previous tick) - wait for it to finish instead of aborting
                log("breakBlock", "Already digging this block, waiting for completion...");
                await new Promise((resolve) => {
                    const onDone = () => {
                        this.bot.removeListener('diggingCompleted', onDone);
                        this.bot.removeListener('diggingAborted', onDone);
                        resolve();
                    };
                    this.bot.once('diggingCompleted', onDone);
                    this.bot.once('diggingAborted', onDone);
                });
                await this.wait(100);
                const stillThere = this.bot.blockAt(targetPos);
                if (stillThere && stillThere.name !== 'air') {
                    await this.bot.dig(stillThere, 'ignore');
                }
            } else {
                // Digging a different block or nothing - stop current dig only if it's a different block to avoid "partial break then restore"
                if (this.bot.targetDigBlock) {
                    try {
                        this.bot.stopDigging();
                    } catch (e) {
                        // Ignore
                    }
                    await this.wait(50);
                }
                await this.bot.dig(digBlock, 'ignore'); // 'ignore' = don't stop on errors
            }
            log("breakBlock", `Dig completed for ${blockName}`);
        } catch (digError) {
            log("breakBlock", `Dig error: ${digError.message}`);
            // Check if block was actually broken
            const checkBlock = this.bot.blockAt(targetPos);
            if (checkBlock && checkBlock.name !== 'air') {
                throw new Error(`Failed to dig ${blockName}: ${digError.message}`);
            }
            // Block is gone, dig succeeded despite error
            log("breakBlock", `Block is gone despite error`);
        }

        // Verify block was broken
        await this.wait(100);
        const afterBlock = this.bot.blockAt(targetPos);
        log("breakBlock", `After dig, block is: ${afterBlock ? afterBlock.name : 'null'}`);
        if (afterBlock && afterBlock.name === blockName) {
            throw new Error(`Block ${blockName} was not broken - may need better tool`);
        }

        // Wait a moment for items to drop and be auto-collected
        await this.wait(500);
        
        // Check for nearby items that dropped
        const droppedItems = Object.values(this.bot.entities).filter(e => 
            e.name === 'item' && 
            e.position && 
            e.position.distanceTo(targetPos) < 3
        );
        if (droppedItems.length > 0) {
            log("breakBlock", `Found ${droppedItems.length} dropped items near block`);
        } else {
            log("breakBlock", `No items dropped near block position`);
        }
        
        // Check if we picked up anything
        const invItems = this.bot.inventory.items();
        log("breakBlock", `Inventory after dig: ${invItems.map(i => `${i.name}x${i.count}`).join(', ') || 'empty'}`);

        return {
            success: true,
            block: blockName,
            position: { x: targetPos.x, y: targetPos.y, z: targetPos.z }
        };
    }

    /**
     * Break blocks in all adjacent directions to clear a path when stuck
     * This does NOT use pathfinding - it directly digs blocks next to the bot
     * @param {string} direction - Optional: 'up', 'down', 'forward', 'all'. Default 'all'
     * @returns {Object} Result with blocks broken
     */
    async breakAround(direction = 'all') {
        log("breakAround", `Clearing path in direction: ${direction}`);
        const pos = this.bot.entity.position;
        const broken = [];
        
        // Get bot's facing direction
        const yaw = this.bot.entity.yaw;
        const forward = new Vec3(
            -Math.sin(yaw),
            0,
            -Math.cos(yaw)
        );
        
        // Define blocks to check based on direction
        // 'escape' = up + forward + sides, NEVER down (safe when stuck in a hole)
        const escapeMode = direction === 'escape';
        const includeDown = (direction === 'down' || direction === 'all') && !escapeMode;
        const includeUp = direction === 'up' || direction === 'all' || escapeMode;
        const includeForward = direction === 'forward' || direction === 'all' || escapeMode;
        const includeCardinals = direction === 'all' || escapeMode;

        const offsets = [];

        if (includeUp) {
            offsets.push({ offset: new Vec3(0, 2, 0), name: 'above head' });
            offsets.push({ offset: new Vec3(0, 1, 0), name: 'at head' });
        }

        if (includeDown) {
            offsets.push({ offset: new Vec3(0, -1, 0), name: 'below feet' });
        }

        if (includeForward) {
            const fwd = new Vec3(Math.round(forward.x), 0, Math.round(forward.z));
            offsets.push({ offset: fwd.offset(0, 0, 0), name: 'forward feet' });
            offsets.push({ offset: fwd.offset(0, 1, 0), name: 'forward head' });
        }

        if (includeCardinals) {
            const cardinals = [
                new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1), new Vec3(0, 0, -1)
            ];
            for (const dir of cardinals) {
                offsets.push({ offset: dir.clone(), name: 'side feet' });
                offsets.push({ offset: dir.offset(0, 1, 0), name: 'side head' });
            }
        }

        // Equip best escape tool first so we never dig barehanded (pickaxe > axe > shovel)
        const pickaxe = this.bot.inventory.items().find(i => i.name.includes('pickaxe'));
        const axe = this.bot.inventory.items().find(i => i.name.includes('_axe'));
        const shovel = this.bot.inventory.items().find(i => i.name.includes('shovel'));
        const bestTool = pickaxe || axe || shovel;
        if (bestTool) {
            try {
                await this.bot.equip(bestTool, 'hand');
                log("breakAround", `Equipped ${bestTool.name} for escape`);
            } catch (e) { /* may already equipped */ }
        }
        
        // Try to break blocks at each offset
        for (const { offset, name } of offsets) {
            const blockPos = pos.offset(offset.x, offset.y, offset.z).floored();
            const block = this.bot.blockAt(blockPos);
            
            if (!block || block.name === 'air' || block.name === 'water' || 
                block.name === 'lava' || block.name === 'bedrock') {
                continue;
            }
            
            log("breakAround", `Found ${block.name} at ${name} (${blockPos.x}, ${blockPos.y}, ${blockPos.z})`);
            
            // Equip appropriate tool
            const blockName = block.name.toLowerCase();
            if (blockName.includes('stone') || blockName.includes('ore') || blockName.includes('cobble')) {
                if (pickaxe) await this.bot.equip(pickaxe, 'hand');
            } else if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks') || blockName.includes('crafting')) {
                if (axe) await this.bot.equip(axe, 'hand');
            } else if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel')) {
                if (shovel) await this.bot.equip(shovel, 'hand');
            }
            
            // Try to dig it — refresh block reference first to avoid stale data
            try {
                const freshBlock = this.bot.blockAt(blockPos);
                if (freshBlock && this.bot.canDigBlock(freshBlock)) {
                    await this.bot.lookAt(blockPos.offset(0.5, 0.5, 0.5), true);
                    await this.wait(50);
                    await this.bot.dig(freshBlock, 'ignore');
                    broken.push({ block: freshBlock.name, position: blockPos, location: name });
                    log("breakAround", `Broke ${freshBlock.name} at ${name}`);
                }
            } catch (e) {
                log("breakAround", `Failed to break block: ${e.message}`);
            }
        }
        
        return {
            success: broken.length > 0,
            blocksCleared: broken.length,
            blocks: broken,
            hint: broken.length > 0 ? 
                `Cleared ${broken.length} blocks! Try moving or exploring now.` : 
                'No blocks to clear nearby. Try pillar_up or dig_to_surface if stuck.'
        };
    }

    /**
     * Clear any leaves surrounding the bot - call this when stuck in a tree
     * @returns {number} Number of leaves cleared
     */
    async clearSurroundingLeaves() {
        const pos = this.bot.entity.position.floored();
        let cleared = 0;
        
        // Check a 3x3x3 cube around the bot
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = -1; dy <= 2; dy++) {  // -1 to +2 (feet to above head)
                    const checkPos = pos.offset(dx, dy, dz);
                    const block = this.bot.blockAt(checkPos);
                    if (block && block.name.includes('leaves')) {
                        try {
                            await this.bot.dig(block);
                            cleared++;
                            await this.wait(30);
                        } catch (e) { 
                            // Ignore errors - just try to clear what we can
                        }
                    }
                }
            }
        }
        
        if (cleared > 0) {
            log("clearSurroundingLeaves", `Cleared ${cleared} leaves around bot`);
        }
        
        return cleared;
    }

    /**
     * Check if a block position has water or lava in any of its 6 neighboring faces.
     * Used to prevent digging into water-filled caves or lava pools.
     * @param {Vec3} pos - Block position to check
     * @returns {boolean} True if any neighbor is water or lava
     */
    hasLiquidNeighbor(pos) {
        const neighbors = [
            pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
            pos.offset(0, 1, 0), pos.offset(0, -1, 0),
            pos.offset(0, 0, 1), pos.offset(0, 0, -1)
        ];
        for (const checkPos of neighbors) {
            const block = this.bot.blockAt(checkPos);
            if (block && (block.name === 'water' || block.name === 'lava')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if bot is stuck (hasn't moved much) and try to unstick
     * @param {Vec3} lastPosition - Previous position to compare
     * @returns {boolean} True if bot was stuck and tried to unstick
     */
    async checkAndUnstick(lastPosition) {
        if (!lastPosition) return false;
        
        const currentPos = this.bot.entity.position;
        const distance = currentPos.distanceTo(lastPosition);
        
        // If we haven't moved more than 0.5 blocks, we might be stuck
        if (distance < 0.5) {
            log("checkAndUnstick", `Bot hasn't moved much (${distance.toFixed(2)} blocks), checking for obstructions`);
            
            // First, clear any leaves around us
            const leavesCleared = await this.clearSurroundingLeaves();
            
            if (leavesCleared > 0) {
                // Try to walk forward after clearing
                await this.wait(200);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true);
                await this.wait(500);
                this.bot.setControlState('forward', false);
                this.bot.setControlState('jump', false);
                return true;
            }
        }
        
        return false;
    }

    /**
     * Equip the best tool for a specific block
     */
    async equipBestToolForBlock(block) {
        const items = this.bot.inventory.items();
        if (items.length === 0) return;

        // Simple tool matching based on block type
        const blockName = block.name.toLowerCase();
        let bestTool = null;

        // Determine what tool type we need
        if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks')) {
            // Need an axe
            bestTool = items.find(i => i.name.includes('_axe'));
        } else if (blockName.includes('stone') || blockName.includes('ore') || 
                   blockName.includes('cobble') || blockName.includes('brick')) {
            // Need a pickaxe
            bestTool = items.find(i => i.name.includes('_pickaxe'));
        } else if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand') || 
                   blockName.includes('gravel') || blockName.includes('clay')) {
            // Need a shovel
            bestTool = items.find(i => i.name.includes('_shovel'));
        }

        if (bestTool) {
            try {
                await this.bot.equip(bestTool, 'hand');
            } catch (e) {
                // May fail if already equipped
            }
        }
    }

    /**
     * Place a block at position
     * @param {string} blockName - Name of block to place
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     */
    async placeBlock(blockName, x, y, z) {
        const targetPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
        
        // Check if position is already occupied
        const existingBlock = this.bot.blockAt(targetPos);
        if (existingBlock && existingBlock.name !== 'air' && existingBlock.name !== 'water' && existingBlock.name !== 'lava') {
            throw new Error(`Position ${targetPos.x}, ${targetPos.y}, ${targetPos.z} is occupied by ${existingBlock.name}`);
        }

        // Find item in inventory
        const item = this.bot.inventory.items().find(i => i.name === blockName);
        if (!item) {
            throw new Error(`No ${blockName} in inventory`);
        }

        // Equip the block
        await this.bot.equip(item, 'hand');

        // Find a reference block to place against
        const adjacentOffsets = [
            new Vec3(0, -1, 0),  // Below
            new Vec3(0, 1, 0),   // Above
            new Vec3(-1, 0, 0),  // West
            new Vec3(1, 0, 0),   // East
            new Vec3(0, 0, -1),  // North
            new Vec3(0, 0, 1)    // South
        ];

        for (const offset of adjacentOffsets) {
            const refPos = targetPos.plus(offset);
            const refBlock = this.bot.blockAt(refPos);
            
            if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water' && refBlock.name !== 'lava') {
                // Move close enough if needed
                const distance = this.bot.entity.position.distanceTo(refPos);
                if (distance > 4) {
                    await this.goToNear(targetPos.x, targetPos.y, targetPos.z, 3);
                }

                // Look at the face we're placing against
                const faceVector = offset.scaled(-1); // Invert to get the face direction
                await this.bot.lookAt(refPos.offset(0.5, 0.5, 0.5));
                await this.wait(50);

                // Place the block
                await this.bot.placeBlock(refBlock, faceVector);
                
                return {
                    success: true,
                    block: blockName,
                    position: { x: targetPos.x, y: targetPos.y, z: targetPos.z }
                };
            }
        }

        throw new Error(`No valid surface to place ${blockName} at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
    }

    /**
     * Equip an item from inventory
     * @param {string} itemName - Name of item to equip
     * @param {string} destination - Where to equip: 'hand', 'off-hand', 'head', 'torso', 'legs', 'feet'
     */
    async equip(itemName, destination = 'hand') {
        const item = this.bot.inventory.items().find(i => 
            i.name === itemName || i.name.includes(itemName)
        );

        if (!item) {
            throw new Error(`No ${itemName} in inventory`);
        }

        await this.bot.equip(item, destination);

        return {
            success: true,
            item: item.name,
            destination: destination
        };
    }

    /**
     * Open a container (chest, furnace, etc.)
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     */
    async openContainer(x, y, z) {
        const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
        const block = this.bot.blockAt(pos);

        if (!block) {
            throw new Error(`No block at ${x}, ${y}, ${z}`);
        }

        const containerBlocks = ['chest', 'trapped_chest', 'ender_chest', 'barrel', 
            'shulker_box', 'furnace', 'blast_furnace', 'smoker', 'hopper', 'dropper', 'dispenser'];
        
        if (!containerBlocks.some(c => block.name.includes(c))) {
            throw new Error(`Block ${block.name} is not a container`);
        }

        // Move close enough
        const distance = this.bot.entity.position.distanceTo(pos);
        if (distance > 4) {
            await this.goToNear(x, y, z, 2);
        }

        // Open the container
        const container = await this.bot.openContainer(block);

        // Get container contents
        const items = container.containerItems().map(item => ({
            name: item.name,
            count: item.count,
            slot: item.slot
        }));

        // Store reference for transfer operations
        this.currentContainer = container;

        return {
            success: true,
            containerType: block.name,
            position: { x, y, z },
            items: items
        };
    }

    /**
     * Transfer items between inventory and container
     * @param {string} direction - 'put' or 'take'
     * @param {string} itemName - Name of item to transfer
     * @param {number} count - How many to transfer (default all)
     */
    async transferItems(direction, itemName, count = null) {
        if (!this.currentContainer) {
            throw new Error('No container is currently open. Use openContainer first.');
        }

        const container = this.currentContainer;

        if (direction === 'put') {
            // Transfer from inventory to container
            const item = this.bot.inventory.items().find(i => i.name === itemName || i.name.includes(itemName));
            if (!item) {
                throw new Error(`No ${itemName} in inventory`);
            }

            const transferCount = count || item.count;
            await container.deposit(item.type, null, transferCount);

            return {
                success: true,
                direction: 'put',
                item: item.name,
                count: transferCount
            };
        } else if (direction === 'take') {
            // Transfer from container to inventory
            const item = container.containerItems().find(i => i.name === itemName || i.name.includes(itemName));
            if (!item) {
                throw new Error(`No ${itemName} in container`);
            }

            const transferCount = count || item.count;
            await container.withdraw(item.type, null, transferCount);

            return {
                success: true,
                direction: 'take',
                item: item.name,
                count: transferCount
            };
        } else {
            throw new Error(`Invalid direction: ${direction}. Use 'put' or 'take'.`);
        }
    }

    /**
     * Close currently open container
     */
    async closeContainer() {
        if (this.currentContainer) {
            this.currentContainer.close();
            this.currentContainer = null;
        }
        return { success: true };
    }

    /**
     * Priority for dropping when freeing space: lower = drop first. Important items have high values (never drop).
     */
    getDropPriority(itemName) {
        const name = (itemName || '').toLowerCase();
        if (!name) return 50;
        // Drop first (least relevant)
        if (name === 'dirt') return 0;
        if (name === 'gravel') return 1;
        if (name === 'sand' || name === 'red_sand') return 2;
        if (name === 'cobblestone') return 3;
        if (name.includes('sapling')) return 4;
        if (name === 'rotten_flesh' || name === 'bone') return 5;
        if (name.includes('flower') && !name.includes('dye')) return 6;
        if (name.includes('seed') || name === 'wheat_seeds' || name === 'beetroot_seeds' || name === 'melon_seeds' || name === 'pumpkin_seeds') return 7;
        if (name === 'flint' || name === 'clay_ball') return 8;
        // Keep more (still droppable when full)
        if (name.includes('_planks')) return 15;
        if (name === 'stick') return 16;
        if (name.includes('_log')) return 20;
        if (name === 'coal' || name === 'charcoal') return 55;
        if (name.includes('ore') && !name.includes('iron') && !name.includes('gold') && !name.includes('diamond')) return 40;
        if (name.includes('iron_ingot') || name.includes('gold_ingot') || name === 'raw_iron' || name === 'raw_gold') return 60;
        if (name.includes('diamond') || name.includes('emerald')) return 70;
        // Food: keep
        if (name.includes('beef') || name.includes('pork') || name.includes('chicken') || name.includes('mutton') || name.includes('bread') || name.includes('apple') || name.includes('carrot') || name.includes('potato') || name.includes('cooked')) return 80;
        // Important utility
        if (name === 'torch') return 85;
        if (name.includes('bed')) return 88;
        if (name === 'crafting_table' || name === 'furnace' || name === 'chest') return 95;
        // Never drop: tools, weapons, armor
        if (name.includes('pickaxe') || name.includes('axe') || name.includes('sword') || name.includes('shovel') || name.includes('hoe')) return 100;
        if (name.includes('helmet') || name.includes('chestplate') || name.includes('leggings') || name.includes('boots')) return 100;
        return 50;
    }

    /**
     * Drop some of an item to free inventory space. If item is 'auto' or omitted with freeSpace, drops the least valuable stack.
     * @param {string} itemName - Item name (e.g. 'cobblestone', 'dirt'), or 'auto' to drop least valuable
     * @param {number} count - How many to drop (default: half stack or 32)
     * @param {boolean} freeSpace - If true and no item specified, drop least valuable stack to free space
     */
    async dropItem(itemName, count, freeSpace = false) {
        let item;
        const normalized = (itemName || '').toLowerCase().trim();
        const useAuto = freeSpace || normalized === 'auto' || normalized === '';

        if (useAuto) {
            const items = this.bot.inventory.items();
            if (items.length === 0) return { success: false, error: 'Inventory empty', dropped: 0 };
            const byPriority = items
                .map(i => ({ item: i, priority: this.getDropPriority(i.name) }))
                .filter(({ priority }) => priority < 90);
            if (byPriority.length === 0) return { success: false, error: 'No droppable (low-value) items; keep tools and food', dropped: 0 };
            byPriority.sort((a, b) => a.priority - b.priority || b.item.count - a.item.count);
            item = byPriority[0].item;
        } else {
            item = this.bot.inventory.items().find(i => i.name === normalized || i.name.includes(normalized));
            if (!item) return { success: false, error: `No ${itemName} in inventory`, dropped: 0 };
        }

        const toDrop = count != null ? Math.min(count, item.count) : Math.min(32, Math.floor(item.count / 2)) || item.count;
        try {
            if (toDrop >= item.count) {
                await this.bot.tossStack(item);
            } else {
                await this.bot.toss(item.type, item.metadata, toDrop);
            }
            return { success: true, dropped: toDrop, item: item.name, auto: useAuto };
        } catch (err) {
            return { success: false, error: err.message, dropped: 0 };
        }
    }

    // ==================== PRODUCTION ====================

    /**
     * Ensure an item is crafted (craft if not in inventory)
     * @param {string} itemName - Name of item to craft
     * @param {number} count - How many to have in inventory
     */
    async ensureCrafted(itemName, count = 1) {
        // Check current inventory
        const currentItems = this.bot.inventory.items().filter(i => i.name === itemName || i.name.includes(itemName.replace('oak_', '').replace('spruce_', '')));
        const currentCount = currentItems.reduce((sum, i) => sum + i.count, 0);

        // For planks and sticks, always craft if we have logs and less than a reasonable amount
        const isBasicResource = itemName.includes('planks') || itemName === 'stick';
        const hasLogs = this.bot.inventory.items().some(i => i.name.includes('_log'));
        const needsMoreBasics = isBasicResource && hasLogs && currentCount < 16;
        
        if (currentCount >= count && !needsMoreBasics) {
            // Already have enough - return clear message telling LLM to move on
            return {
                success: true,
                item: itemName,
                alreadyHad: currentCount,
                crafted: 0,
                hint: `Already have ${currentCount} ${itemName}! Move to next step - don't repeat this action.`
            };
        }
        
        // If it's a basic resource and we have few, craft more
        if (needsMoreBasics) {
            count = Math.max(count, 8); // Craft at least 8
        }

        const needed = count - currentCount;
        
        // Special case: generic "planks" - auto-detect from log type
        if (itemName === 'planks') {
            const logItem = this.bot.inventory.items().find(i => i.name.includes('_log'));
            if (logItem) {
                const logType = logItem.name.replace('_log', '').replace('stripped_', '');
                itemName = `${logType}_planks`;
                log("craft", `Auto-detected plank type: ${itemName} from ${logItem.name}`);
            } else {
                // Default to oak if no logs found (will likely fail but give clear error)
                itemName = 'oak_planks';
            }
        }
        
        // Get item data
        const itemData = this.mcData.itemsByName[itemName];
        if (!itemData) {
            throw new Error(`Unknown item: ${itemName}`);
        }

        // Special case: crafting_table - only craft if no nearby reachable table
        if (itemName === 'crafting_table') {
            // Check inventory first
            const existingTables = this.bot.inventory.items().filter(i => i.name === 'crafting_table');
            const tableCount = existingTables.reduce((sum, i) => sum + i.count, 0);
            if (tableCount >= 1) {
                return {
                    success: true,
                    item: 'crafting_table',
                    alreadyHad: tableCount,
                    crafted: 0,
                    hint: `Already have ${tableCount} crafting table in inventory! DO NOT CRAFT MORE.`
                };
            }
            
            // Check if there's a placed crafting table nearby AND reachable
            const nearbyTable = await this.findCraftingTable();
            if (nearbyTable) {
                const distance = this.bot.entity.position.distanceTo(nearbyTable.position);
                
                // Try to check if we can reach it (only if close enough to matter)
                if (distance < 32) {
                    try {
                        // Quick pathfinding check - can we reach within 4 blocks?
                        const goal = new GoalNear(nearbyTable.position.x, nearbyTable.position.y, nearbyTable.position.z, 4);
                        const path = this.bot.pathfinder.getPathTo(this.movements, goal, 1000); // 1 second timeout
                        
                        if (path && path.status === 'success') {
                            return {
                                success: true,
                                item: 'crafting_table',
                                alreadyHad: 1,
                                crafted: 0,
                                hint: `Crafting table already placed nearby at (${nearbyTable.position.x}, ${nearbyTable.position.y}, ${nearbyTable.position.z})! DO NOT CRAFT MORE. Just use craft() for tools.`
                            };
                        }
                        // Path failed - table is unreachable, allow crafting new one
                        log("craft", `Nearby table at ${nearbyTable.position} is unreachable, allowing new craft`);
                    } catch (e) {
                        // Pathfinding error - assume unreachable, allow crafting
                        log("craft", `Could not check path to table: ${e.message}, allowing new craft`);
                    }
                }
            }
            
            await this.ensurePlanks(4);
        }
        
        // Special case: planks - craft from logs if needed
        if (itemName.includes('planks')) {
            await this.ensurePlanks(needed);
            return {
                success: true,
                item: itemName,
                alreadyHad: currentCount,
                crafted: needed
            };
        }
        
        // Special case: sticks - ensure we have planks first
        if (itemName === 'stick') {
            const planks = this.bot.inventory.items().find(i => i.name.includes('planks'));
            if (!planks || planks.count < 2) {
                await this.ensurePlanks(2);
            }
        }

        // Special case: beds - auto-match to available wool color
        if (itemName.includes('_bed') || itemName === 'bed') {
            const woolItem = this.bot.inventory.items().find(i => i.name.includes('_wool'));
            if (woolItem) {
                const woolColor = woolItem.name.replace('_wool', '');
                const preferredBed = `${woolColor}_bed`;
                if (this.mcData.itemsByName[preferredBed]) {
                    itemName = preferredBed;
                    log("craft", `Auto-detected bed color: ${itemName} from ${woolItem.name}`);
                }
            } else if (itemName === 'bed') {
                itemName = 'white_bed';
            }
        }

        // First try to find a crafting table nearby
        let craftingTable = await this.findCraftingTable();
        
        // Check for recipes without crafting table
        let recipes = this.bot.recipesFor(itemData.id, null, 1, null);
        
        // If no recipes found or recipe requires table, try with crafting table
        if (recipes.length === 0 || (recipes[0] && recipes[0].requiresTable)) {
            if (!craftingTable) {
                craftingTable = await this.findOrPlaceCraftingTable();
            }
            
            if (craftingTable) {
                // Move to crafting table first
                await this.goToNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2);
                // Re-fetch recipes with crafting table
                recipes = this.bot.recipesFor(itemData.id, null, 1, craftingTable);
            }
        }

        if (recipes.length === 0) {
            // Provide actionable error: check static recipe DB for missing ingredients
            const recipeInfo = this.getRecipeInfo(itemName);
            if (recipeInfo && !recipeInfo.error) {
                const missing = [];
                for (const ing of recipeInfo.ingredients || []) {
                    const match = ing.match(/^(.+?)\s+x(\d+)$/);
                    if (!match) continue;
                    const needName = match[1].trim();
                    const needCount = parseInt(match[2], 10);
                    // Handle generic 'planks' / 'log' / 'fuel'
                    const hasCount = this.bot.inventory.items()
                        .filter(i => {
                            if (needName === 'planks') return i.name.includes('_planks');
                            if (needName === 'log') return i.name.includes('_log');
                            if (needName === 'fuel') return ['coal','charcoal','oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','crimson_planks','warped_planks','oak_log','birch_log','spruce_log'].includes(i.name);
                            return i.name === needName || i.name.includes(needName);
                        })
                        .reduce((sum, i) => sum + i.count, 0);
                    if (hasCount < needCount) {
                        missing.push(`${needName}: have ${hasCount}, need ${needCount}`);
                    }
                }
                if (missing.length > 0) {
                    throw new Error(`Cannot craft ${itemName}: missing ingredients — ${missing.join('; ')}${recipeInfo.table && !craftingTable ? ' (also needs crafting table nearby)' : ''}`);
                }
            }
            throw new Error(`No recipe found for ${itemName}. May need to craft prerequisites or find a crafting table.`);
        }

        const recipe = recipes[0];
        
        // Check if recipe requires crafting table
        if (recipe.requiresTable) {
            // Ensure a reachable crafting table within 4 blocks. This avoids the 20 s
            // windowOpen timeout from trying to open an unreachable table.
            craftingTable = await this.ensureNearbyCraftingTable();

            if (!craftingTable) {
                throw new Error(`Recipe for ${itemName} requires a crafting table within reach, but none is nearby and none could be placed. Move closer to a table or craft/place one first.`);
            }

            const distanceToTable = this.bot.entity.position.distanceTo(craftingTable.position);
            if (distanceToTable > 4) {
                throw new Error(`Crafting table at ${distanceToTable.toFixed(1)}m is too far to open. Must be within 4 blocks.`);
            }

            const craftCount = Math.ceil(needed / recipe.result.count);
            await this.bot.craft(recipe, craftCount, craftingTable);
        } else {
            // Craft without table
            const craftCount = Math.ceil(needed / recipe.result.count);
            await this.bot.craft(recipe, craftCount, null);
        }

        return {
            success: true,
            item: itemName,
            alreadyHad: currentCount,
            crafted: needed
        };
    }

    /**
     * Find nearby crafting table
     */
    async findCraftingTable() {
        const tableData = this.mcData.blocksByName.crafting_table;
        if (!tableData) return null;

        const found = this.bot.findBlock({
            matching: tableData.id,
            maxDistance: 32
        });

        return found;
    }

    /**
     * Ensure we have enough planks, crafting from logs if needed
     * @param {number} count - How many planks needed
     */
    async ensurePlanks(count = 4) {
        // Check current planks
        const planks = this.bot.inventory.items().filter(i => i.name.includes('planks'));
        const currentCount = planks.reduce((sum, i) => sum + i.count, 0);
        
        // Target 8 planks when logs are available, but cap to what's actually craftable
        const allLogItemsForTarget = this.bot.inventory.items().filter(i =>
            i.name.includes('_log') || i.name.includes('_wood')
        );
        const totalAvailableLogs = allLogItemsForTarget.reduce((sum, i) => sum + i.count, 0);
        const hasLogs = totalAvailableLogs > 0;
        const minPlanks = hasLogs ? Math.min(8, currentCount + totalAvailableLogs * 4) : count;
        
        const targetPlanks = Math.max(count, minPlanks);
        
        if (currentCount >= targetPlanks) {
            return { success: true, planks: currentCount };
        }
        
        // Need to craft more planks from logs
        let needed = targetPlanks - currentCount;
        let logsNeeded = Math.ceil(needed / 4); // Each log makes 4 planks
        log("ensurePlanks", `Have ${currentCount} planks, need ${needed} more (target: ${targetPlanks})`);
        
        // Find logs in inventory — sum across all log types (bot may have e.g. oak_log + birch_log)
        const allLogItems = this.bot.inventory.items().filter(i =>
            i.name.includes('_log') || i.name.includes('_wood')
        );
        const totalLogs = allLogItems.reduce((sum, i) => sum + i.count, 0);
        // Use the first log type for recipe detection (will cycle through types below anyway)
        const logs = allLogItems[0] || null;

        if (!logs || totalLogs <= 0) {
            throw new Error(`Need ${logsNeeded} logs to craft ${needed} planks, but have none`);
        }
        if (totalLogs < logsNeeded) {
            // Cap to available logs instead of failing
            const craftable = totalLogs * 4;
            log("ensurePlanks", `Capping plank craft from ${needed} to ${craftable} (only ${totalLogs} logs available)`);
            needed = craftable;
            logsNeeded = totalLogs;
        }
        
        // Find planks recipe matching log type - prioritize the matching plank type
        const logType = logs.name.replace('_log', '').replace('stripped_', '');
        const matchingPlankType = `${logType}_planks`;
        log("ensurePlanks", `Have ${logs.name}, will craft ${matchingPlankType}`);
        
        // Try matching plank type first, then fall back to others
        const allPlankTypes = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 
                           'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
                           'bamboo_planks', 'crimson_planks', 'warped_planks'];
        
        // Put matching type first
        const plankTypes = [matchingPlankType, ...allPlankTypes.filter(t => t !== matchingPlankType)];
        
        for (const plankType of plankTypes) {
            const plankData = this.mcData.itemsByName[plankType];
            if (plankData) {
                const recipes = this.bot.recipesFor(plankData.id, null, 1, null);
                if (recipes.length > 0) {
                    try {
                        await this.bot.craft(recipes[0], logsNeeded, null);
                        await this.wait(100);
                        const newPlanks = this.bot.inventory.items().filter(i => i.name.includes('planks'));
                        return { success: true, planks: newPlanks.reduce((sum, i) => sum + i.count, 0) };
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
        
        throw new Error(`Failed to craft planks from logs`);
    }

    /**
     * Find or place a crafting table
     */
    async findOrPlaceCraftingTable() {
        // Check if we have a crafting table in inventory - prioritize placing it nearby
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (tableItem) {
            // Place it nearby rather than walk to a distant one
            const pos = this.bot.entity.position.floored();
            const offsets = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]];
            
            for (const [dx, dy, dz] of offsets) {
                try {
                    const targetPos = pos.offset(dx, dy, dz);
                    const blockAtTarget = this.bot.blockAt(targetPos);
                    const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
                    
                    // Check if we can place here (air above solid)
                    if (blockAtTarget && blockAtTarget.name === 'air' && 
                        blockBelow && blockBelow.name !== 'air') {
                        log("findOrPlaceCraftingTable", `Placing table from inventory at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
                        await this.placeBlock('crafting_table', targetPos.x, targetPos.y, targetPos.z);
                        await this.wait(100);
                        return await this.findCraftingTable();
                    }
                } catch (e) {
                    log("findOrPlaceCraftingTable", `Failed to place: ${e.message}`);
                    continue;
                }
            }
        }
        
        // Try to find existing nearby (within 16 blocks)
        let table = await this.findCraftingTable();
        if (table && this.bot.entity.position.distanceTo(table.position) < 16) {
            return table;
        }

        // Try to craft planks from logs if we have logs but not enough planks
        let planks = this.bot.inventory.items().find(i => i.name.includes('planks'));
        const totalPlanksAvailable = this.bot.inventory.items()
            .filter(i => i.name.includes('planks'))
            .reduce((sum, i) => sum + i.count, 0);
        
        if (totalPlanksAvailable < 4) {
            // Try to craft planks from logs
            const logs = this.bot.inventory.items().find(i => 
                i.name.includes('_log') || i.name.includes('_wood')
            );
            if (logs) {
                // Find the planks recipe for this log type
                const logType = logs.name;
                const plankTypes = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 
                                   'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
                                   'bamboo_planks', 'crimson_planks', 'warped_planks'];
                
                for (const plankType of plankTypes) {
                    const plankData = this.mcData.itemsByName[plankType];
                    if (plankData) {
                        const recipes = this.bot.recipesFor(plankData.id, null, 1, null);
                        if (recipes.length > 0) {
                            // Craft as many planks as we can (need at least 1 log for 4 planks)
                            const logsToUse = Math.min(logs.count, 2); // Use up to 2 logs (8 planks)
                            try {
                                await this.bot.craft(recipes[0], logsToUse, null);
                                await this.wait(100);
                                break;
                            } catch (e) {
                                continue;
                            }
                        }
                    }
                }
            }
        }
        
        // Re-check planks after potentially crafting them
        const totalPlankCount = this.bot.inventory.items()
            .filter(i => i.name.includes('planks'))
            .reduce((sum, i) => sum + i.count, 0);
        planks = this.bot.inventory.items().find(i => i.name.includes('planks'));
        if (planks && totalPlankCount >= 4) {
            // Crafting table recipe: 4 planks in 2x2
            const craftingTableData = this.mcData.itemsByName.crafting_table;
            if (craftingTableData) {
                const recipes = this.bot.recipesFor(craftingTableData.id, null, 1, null);
                if (recipes.length > 0) {
                    log('findOrPlaceCraftingTable', 'Crafting a new crafting table');
                    await this.bot.craft(recipes[0], 1, null);
                    await this.wait(100);
                    
                    // Now we have crafting table in inventory - place it!
                    const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
                    if (tableItem) {
                        log('findOrPlaceCraftingTable', 'Placing the crafted table');
                        const pos = this.bot.entity.position.floored();
                        const offsets = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]];
                        
                        for (const [dx, dy, dz] of offsets) {
                            try {
                                const targetPos = pos.offset(dx, dy, dz);
                                const blockAtTarget = this.bot.blockAt(targetPos);
                                const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
                                
                                if (blockAtTarget && blockAtTarget.name === 'air' && 
                                    blockBelow && blockBelow.name !== 'air') {
                                    await this.placeBlock('crafting_table', targetPos.x, targetPos.y, targetPos.z);
                                    await this.wait(200);
                                    const placed = await this.findCraftingTable();
                                    if (placed) {
                                        log('findOrPlaceCraftingTable', 'Successfully placed crafting table');
                                        return placed;
                                    }
                                }
                            } catch (e) {
                                log("findOrPlaceCraftingTable", `Failed to place at offset: ${e.message}`);
                                continue;
                            }
                        }

                        // Fallback: build a temporary support block on water/uneven ground.
                        const placeable = this.bot.inventory.items().find(i =>
                            i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks')
                        );
                        if (placeable) {
                            for (const [dx, dy, dz] of offsets) {
                                try {
                                    const supportPos = pos.offset(dx, dy - 1, dz);
                                    const tablePos = supportPos.offset(0, 1, 0);
                                    const supportBlock = this.bot.blockAt(supportPos);
                                    const tableBlock = this.bot.blockAt(tablePos);
                                    if (supportBlock && (supportBlock.name === 'air' || supportBlock.name === 'water') &&
                                        tableBlock && tableBlock.name === 'air') {
                                        log('findOrPlaceCraftingTable', `Placing support block at ${supportPos.x}, ${supportPos.y}, ${supportPos.z}`);
                                        await this.placeBlock(placeable.name, supportPos.x, supportPos.y, supportPos.z);
                                        await this.wait(100);
                                        await this.placeBlock('crafting_table', tablePos.x, tablePos.y, tablePos.z);
                                        await this.wait(200);
                                        const placed = await this.findCraftingTable();
                                        if (placed) {
                                            log('findOrPlaceCraftingTable', 'Successfully placed crafting table on support');
                                            return placed;
                                        }
                                    }
                                } catch (e) {
                                    log('findOrPlaceCraftingTable', `Support-block placement failed: ${e.message}`);
                                    continue;
                                }
                            }
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Ensure a reachable crafting table is within 4 blocks.
     * Prefer placing one from inventory right next to the bot; avoids the 20 s
     * windowOpen timeout caused by trying to open an unreachable table.
     * @returns {Block|null} A reachable crafting table block, or null.
     */
    async ensureNearbyCraftingTable() {
        // 1. Prefer placing a crafting table from inventory right next to us.
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (tableItem) {
            const pos = this.bot.entity.position.floored();
            const offsets = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]];
            for (const [dx, dy, dz] of offsets) {
                try {
                    const targetPos = pos.offset(dx, dy, dz);
                    const blockAtTarget = this.bot.blockAt(targetPos);
                    const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
                    if (blockAtTarget && blockAtTarget.name === 'air' &&
                        blockBelow && blockBelow.name !== 'air' && blockBelow.name !== 'water' && blockBelow.name !== 'lava') {
                        log('ensureNearbyCraftingTable', `Placing crafting table at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
                        await this.placeBlock('crafting_table', targetPos.x, targetPos.y, targetPos.z);
                        await this.wait(200);
                        const placed = await this.findCraftingTable();
                        if (placed && this.bot.entity.position.distanceTo(placed.position) <= 4) {
                            return placed;
                        }
                    }
                } catch (e) {
                    log('ensureNearbyCraftingTable', `Failed to place table at offset ${dx},${dy},${dz}: ${e.message}`);
                    continue;
                }
            }

            // Fallback: build a temporary support block on water/uneven ground, then place table on top.
            const placeable = this.bot.inventory.items().find(i =>
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks')
            );
            if (placeable) {
                for (const [dx, dy, dz] of offsets) {
                    try {
                        const supportPos = pos.offset(dx, dy - 1, dz); // block at feet level
                        const tablePos = supportPos.offset(0, 1, 0);
                        const supportBlock = this.bot.blockAt(supportPos);
                        const tableBlock = this.bot.blockAt(tablePos);
                        if (supportBlock && (supportBlock.name === 'air' || supportBlock.name === 'water') &&
                            tableBlock && tableBlock.name === 'air') {
                            log('ensureNearbyCraftingTable', `Placing support block at ${supportPos.x}, ${supportPos.y}, ${supportPos.z}`);
                            await this.placeBlock(placeable.name, supportPos.x, supportPos.y, supportPos.z);
                            await this.wait(100);
                            log('ensureNearbyCraftingTable', `Placing crafting table on support at ${tablePos.x}, ${tablePos.y}, ${tablePos.z}`);
                            await this.placeBlock('crafting_table', tablePos.x, tablePos.y, tablePos.z);
                            await this.wait(200);
                            const placed = await this.findCraftingTable();
                            if (placed && this.bot.entity.position.distanceTo(placed.position) <= 4) {
                                return placed;
                            }
                        }
                    } catch (e) {
                        log('ensureNearbyCraftingTable', `Support-block placement failed at offset ${dx},${dy},${dz}: ${e.message}`);
                        continue;
                    }
                }
            }
        }

        // 2. If a placed table is already within 4 blocks, use it.
        let table = await this.findCraftingTable();
        if (table && this.bot.entity.position.distanceTo(table.position) <= 4) {
            return table;
        }

        // 3. Try to find or place a table via the broader fallback.
        if (!table) {
            table = await this.findOrPlaceCraftingTable();
        }
        if (table && this.bot.entity.position.distanceTo(table.position) <= 4) {
            return table;
        }

        return null;
    }

    /**
     * Smelt items in a furnace
     * @param {string} itemName - Name of item to smelt
     * @param {number} count - How many to smelt
     */
    async smelt(itemName, count = 1) {
        // Find furnace — auto-place from inventory if none is nearby (mirrors crafting table pattern)
        const furnaceData = this.mcData.blocksByName.furnace;
        let furnaceBlock = this.bot.findBlock({
            matching: furnaceData.id,
            maxDistance: 32
        });

        if (!furnaceBlock) {
            const furnaceItem = this.bot.inventory.items().find(i => i.name === 'furnace');
            if (furnaceItem) {
                log('smelt', 'No furnace placed nearby — placing furnace from inventory');
                try {
                    const botPos = this.bot.entity.position.floored();
                    const offsets = [
                        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
                        new Vec3(0, 0, 1), new Vec3(0, 0, -1),
                        new Vec3(0, 1, 0), new Vec3(0, -1, 0)
                    ];
                    let placePos = null;
                    for (const offset of offsets) {
                        const checkPos = botPos.plus(offset);
                        const checkBlock = this.bot.blockAt(checkPos);
                        if (checkBlock && (checkBlock.name === 'air' || checkBlock.name === 'water' || checkBlock.name === 'lava')) {
                            placePos = checkPos;
                            break;
                        }
                    }
                    if (placePos) {
                        await this.placeBlock('furnace', placePos.x, placePos.y, placePos.z);
                        furnaceBlock = this.bot.findBlock({ matching: furnaceData.id, maxDistance: 8 });
                    } else {
                        log('smelt', 'No adjacent air/water/lava block found to place furnace');
                    }
                } catch (e) {
                    log('smelt', `Failed to place furnace: ${e.message}`);
                }
            }
            if (!furnaceBlock) {
                throw new Error('No furnace found nearby and could not place one. Craft furnace (8 cobblestone) then smelt.');
            }
        }

        // Move to furnace
        await this.goToNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2);

        // Open furnace
        const furnace = await this.bot.openFurnace(furnaceBlock);

        // Get item to smelt
        const item = this.bot.inventory.items().find(i => i.name === itemName);
        if (!item) {
            furnace.close();
            throw new Error(`No ${itemName} in inventory to smelt`);
        }

        // Get fuel
        const fuels = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 
            'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
            'coal_block', 'lava_bucket', 'blaze_rod'];
        const fuel = this.bot.inventory.items().find(i => fuels.some(f => i.name.includes(f)));
        if (!fuel) {
            furnace.close();
            throw new Error('No fuel in inventory');
        }

        // Put items in furnace
        const smeltCount = Math.min(count, item.count);
        await furnace.putInput(item.type, null, smeltCount);
        await furnace.putFuel(fuel.type, null, Math.ceil(smeltCount / 8) + 1);

        // Wait for smelting (about 10 seconds per item)
        await this.wait(smeltCount * 10000 + 1000);

        // Take output
        const output = await furnace.takeOutput();
        furnace.close();

        return {
            success: true,
            smelted: itemName,
            count: output ? output.count : 0,
            result: output ? output.name : 'unknown'
        };
    }

    /**
     * Mine blocks of a specific type
     * @param {string} blockType - Type of block to mine
     * @param {number} count - How many to mine (default 1)
     */
    async mine(blockType, count = 1) {
        let mined = 0;

        // Guard: LLM sometimes calls mine with no blockType
        if (!blockType || typeof blockType !== 'string') {
            return {
                success: false,
                error: 'No block type specified. Use mine with blockType like "stone", "coal_ore", "iron_ore", etc.',
                hint: 'Example: { "name": "mine", "params": { "blockType": "stone", "count": 10 } }'
            };
        }

        // Map common names to actual block names
        const blockMap = {
            'cobblestone': 'stone', // Stone drops cobblestone when mined
            'cobble': 'stone',
            'wood': 'oak_log',
            'log': 'oak_log'
        };
        const actualBlockType = blockMap[blockType.toLowerCase()] || blockType;

        // Block variant fallback chain: accept generic targets and find nearest matching variant.
        // This prevents 'No deepslate found within 32 blocks' failures when the LLM asks for a
        // specific variant that happens to be absent nearby.
        const fallbackChain = {
            'stone': ['deepslate', 'andesite', 'diorite', 'granite', 'cobblestone', 'mossy_cobblestone'],
            'deepslate': ['stone', 'andesite', 'diorite', 'granite', 'cobblestone'],
            'iron_ore': ['deepslate_iron_ore'],
            'deepslate_iron_ore': ['iron_ore'],
            'coal_ore': ['deepslate_coal_ore'],
            'deepslate_coal_ore': ['coal_ore'],
            'diamond_ore': ['deepslate_diamond_ore'],
            'deepslate_diamond_ore': ['diamond_ore'],
            'gold_ore': ['deepslate_gold_ore'],
            'deepslate_gold_ore': ['gold_ore'],
            'copper_ore': ['deepslate_copper_ore'],
            'deepslate_copper_ore': ['copper_ore']
        };

        // Check tool requirements BEFORE mining
        const requiresPickaxe = ['stone', 'cobblestone', 'coal_ore', 'iron_ore', 'gold_ore', 
            'diamond_ore', 'copper_ore', 'deepslate', 'andesite', 'diorite', 'granite'];
        const hasPickaxe = this.bot.inventory.items().some(i => i.name.includes('pickaxe'));
        
        if (requiresPickaxe.includes(actualBlockType) && !hasPickaxe) {
            const cobble = this.bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
            const sticks = this.bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
            const hasTable = this.bot.inventory.items().some(i => i.name === 'crafting_table');
            const hint = cobble >= 3 && sticks >= 2 && hasTable
                ? 'Craft stone_pickaxe now: craft({ item: "stone_pickaxe" })'
                : 'Need to craft wooden_pickaxe: get wood -> planks -> sticks -> pickaxe';
            return {
                success: false,
                error: `Cannot mine ${actualBlockType} without a pickaxe! Craft a pickaxe first.`,
                hint
            };
        }

        // If we're stuck inside leaves, clear them first so pathfinding works
        const botPosMine = this.bot.entity.position.floored();
        for (const offset of [new Vec3(0,0,0), new Vec3(0,1,0), new Vec3(0,-1,0)]) {
            const leafBlock = this.bot.blockAt(botPosMine.plus(offset));
            if (leafBlock && leafBlock.name && leafBlock.name.includes('leaves')) {
                try { await this.bot.dig(leafBlock); await this.wait(100); } catch (e) { }
            }
        }

        // Equip best pickaxe when mining stone/ores so we never use axe
        if (requiresPickaxe.includes(actualBlockType)) {
            const pickaxes = this.bot.inventory.items().filter(i => i.name && i.name.includes('pickaxe'));
            if (pickaxes.length > 0) {
                const order = ['diamond', 'iron', 'stone', 'wooden'];
                const best = pickaxes.sort((a, b) => {
                    const aRank = order.findIndex(m => a.name.includes(m));
                    const bRank = order.findIndex(m => b.name.includes(m));
                    return (aRank === -1 ? 99 : aRank) - (bRank === -1 ? 99 : bRank);
                })[0];
                try {
                    await this.bot.equip(best, 'hand');
                } catch (e) { /* may already be equipped */ }
            }
        }

        // For stone, check if we need to dig down first (also check deepslate)
        if (actualBlockType === 'stone') {
            const stoneId = this.mcData.blocksByName.stone?.id;
            const deepslateId = this.mcData.blocksByName.deepslate?.id;
            const stoneBlocks = this.bot.findBlocks({
                matching: stoneId != null ? stoneId : (blockId) => false,
                maxDistance: 32,
                count: 1
            });
            const deepslateBlocks = deepslateId != null ? this.bot.findBlocks({
                matching: deepslateId,
                maxDistance: 32,
                count: 1
            }) : [];

            if (stoneBlocks.length === 0 && deepslateBlocks.length === 0) {
                log('mine', 'No stone or deepslate on surface, digging down to find it');
                // Dig down through dirt/grass to find stone
                const pos = this.bot.entity.position.floored();
                const digDownBlocks = ['grass_block', 'dirt', 'gravel', 'sand'];
                
                for (let depth = 1; depth <= 5; depth++) {
                    const blockBelow = this.bot.blockAt(pos.offset(0, -depth, 0));
                    
                    // WATER SAFETY: Check for water before digging
                    if (blockBelow && (blockBelow.name === 'water' || blockBelow.name === 'lava')) {
                        log("mine", `WARNING: ${blockBelow.name} detected below at depth ${depth}! Stopping.`);
                        break;
                    }
                    
                    // Also check adjacent blocks for water (might flood in)
                    const adjacentWater = ['water', 'lava'].some(fluid => {
                        for (const offset of [{x:1,z:0}, {x:-1,z:0}, {x:0,z:1}, {x:0,z:-1}]) {
                            const adjacent = this.bot.blockAt(pos.offset(offset.x, -depth, offset.z));
                            if (adjacent && adjacent.name === fluid) return true;
                        }
                        return false;
                    });
                    if (adjacentWater) {
                        log("mine", `WARNING: Water/lava adjacent at depth ${depth}! Stopping.`);
                        break;
                    }
                    
                    if (blockBelow && (blockBelow.name === 'stone' || blockBelow.name === 'deepslate')) {
                        log("mine", `Found ${blockBelow.name} at depth ${depth}!`);
                        break;
                    }
                    if (blockBelow && digDownBlocks.includes(blockBelow.name)) {
                        try {
                            await this.breakBlock(blockBelow.position.x, blockBelow.position.y, blockBelow.position.z);
                            await this.wait(200);
                        } catch (e) {
                            log("mine", `Error digging down: ${e.message}`);
                            break;
                        }
                    } else if (blockBelow && blockBelow.name !== 'air') {
                        // Hit something that's not diggable dirt or stone
                        break;
                    }
                }
            }
        }

        for (let i = 0; i < count; i++) {
            if (this.shouldInterrupt?.()) {
                log("mine", "Interrupted by danger system");
                return { success: mined > 0, blocksMined: mined, blockType, interrupted: true, reason: 'danger_interrupt' };
            }
            const typesToTry = [actualBlockType, ...(fallbackChain[actualBlockType] || [])];
            let breakSuccess = false;
            for (let t = 0; t < typesToTry.length; t++) {
                const type = typesToTry[t];
                try {
                    const result = await this.breakBlock(type);
                    if (result && result.interrupted) {
                        return { success: mined > 0, blocksMined: mined, blockType, interrupted: true, reason: 'danger_interrupt' };
                    }
                    if (result.success) {
                        mined++;
                        breakSuccess = true;
                        break;
                    }
                } catch (e) {
                    log("mine", `Failed to mine ${type}: ${e.message}`);
                    if (t === typesToTry.length - 1) {
                        // Last fallback failed
                        if (mined === 0) {
                            throw e;
                        }
                        break;
                    }
                    // Otherwise try next fallback type
                }
            }
            if (!breakSuccess && mined > 0) {
                // Already mined some but current block type exhausted
                break;
            }
            await this.wait(200);
        }

        // Collect dropped items
        await this.collectNearbyItems();

        return {
            success: true,
            blockType: blockType,
            mined: mined
        };
    }

    /**
     * Collect nearby dropped items
     */
    async collectNearbyItems() {
        let collected = 0;
        const maxAttempts = 5;
        
        log("collectNearbyItems", `Starting collection`);
        
        // Debug: print all nearby entity types
        const allEntities = Object.values(this.bot.entities);
        const nearbyPlayers = allEntities.filter(e => e.type === 'player' && e.username !== this.bot.username);
        if (nearbyPlayers.length > 0) {
            log("collectNearbyItems", `WARNING: ${nearbyPlayers.length} other player(s) nearby - they may be picking up items!`);
            log("collectNearbyItems", `Other players: ${nearbyPlayers.map(p => p.username).join(', ')}`);
        }
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const items = Object.values(this.bot.entities).filter(e => 
                e.name === 'item' && 
                e.position.distanceTo(this.bot.entity.position) < 16
            );
            
            log("collectNearbyItems", `Attempt ${attempt + 1}: Found ${items.length} items nearby`);
            
            if (items.length === 0) break;
            
            // Sort by distance
            items.sort((a, b) => 
                a.position.distanceTo(this.bot.entity.position) - 
                b.position.distanceTo(this.bot.entity.position)
            );
            
            for (const item of items) {
                if (!item.isValid) continue;
                
                try {
                    const dist = item.position.distanceTo(this.bot.entity.position);
                    log("collectNearbyItems", `Moving to item at distance ${dist.toFixed(2)}`);
                    if (dist > 2) {
                        // Move to item
                        const goal = new GoalNear(item.position.x, item.position.y, item.position.z, 0);
                        await this.bot.pathfinder.goto(goal);
                    }
                    // Wait for auto-pickup
                    await this.wait(500);
                    collected++;
                    log("collectNearbyItems", `Collected item, total: ${collected}`);
                } catch (e) {
                    log("collectNearbyItems", `Failed to collect: ${e.message}`);
                    // Item may have despawned or been picked up
                }
            }
            
            // Small delay before checking for more items
            await this.wait(200);
        }

        log("collectNearbyItems", `Finished, collected: ${collected}, inventory has ${this.bot.inventory.items().length} items`);
        return { collected };
    }

    /**
     * Chop a tree (find and break logs, then collect)
     * @param {number} count - How many logs to collect (default 1)
     */
    async chopTree(count = 1) {
        const logTypes = [
            'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 
            'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'
        ];

        let chopped = 0;
        let failedAttempts = 0;
        const maxFailedAttempts = 3;

        // Equip axe if we have one
        const axe = this.bot.inventory.items().find(i => i.name.includes('_axe'));
        if (axe) {
            await this.bot.equip(axe, 'hand');
            log("chopTree", `Equipped ${axe.name}`);
        }

        // Clear leaves if we're stuck inside a tree canopy (foot, head, and above-head)
        const botPos = this.bot.entity.position.floored();
        const footBlock = this.bot.blockAt(botPos);
        const headBlock = this.bot.blockAt(botPos.offset(0, 1, 0));
        const headBlock2 = this.bot.blockAt(botPos.offset(0, 2, 0));
        if (footBlock && footBlock.name && footBlock.name.includes('leaves')) {
            try { await this.bot.dig(footBlock); await this.wait(50); } catch (e) { }
        }
        if (headBlock && headBlock.name && headBlock.name.includes('leaves')) {
            try { await this.bot.dig(headBlock); await this.wait(50); } catch (e) { }
        }
        if (headBlock2 && headBlock2.name && headBlock2.name.includes('leaves')) {
            try { await this.bot.dig(headBlock2); await this.wait(50); } catch (e) { }
        }
        // Detect if we're in a confined space (tunnel, hole, shelter) — exploring from here will hang
        const headIsBlocked = headBlock && headBlock.name !== 'air' && !headBlock.name.includes('leaves') && !headBlock.name.includes('water');

        for (let i = 0; i < count; i++) {
            if (this.shouldInterrupt?.()) {
                log("chopTree", "Interrupted by danger system");
                return { success: chopped > 0, logsChopped: chopped, interrupted: true, reason: 'danger_interrupt' };
            }
            if (failedAttempts >= maxFailedAttempts) {
                log("chopTree", `Too many failed attempts, stopping`);
                break;
            }
            
            let found = false;

            // Find the best log to chop - ONLY ground-level logs (Y within 3 of bot)
            let bestLog = null;
            let bestScore = Infinity;
            
            for (const logType of logTypes) {
                const logData = this.mcData.blocksByName[logType];
                if (!logData) continue;
                
                const logs = this.bot.findBlocks({
                    matching: logData.id,
                    maxDistance: 24,  // Reduced from 32
                    count: 20
                });
                
                for (const logPos of logs) {
                    const block = this.bot.blockAt(logPos);
                    if (!block || block.name === 'air') continue;
                    
                    // ONLY consider logs near ground level (within 3 blocks above or 6 below bot Y)
                    // Wider lower bound so we can find trees when standing on cliffs/hills.
                    const yDiff = logPos.y - this.bot.entity.position.y;
                    if (yDiff > 3 || yDiff < -6) continue; // Skip logs too high or far below
                    
                    const horizDist = Math.sqrt(
                        Math.pow(logPos.x - this.bot.entity.position.x, 2) +
                        Math.pow(logPos.z - this.bot.entity.position.z, 2)
                    );
                    
                    // Check if there's a clear path (not blocked by leaves)
                    const blockAbove = this.bot.blockAt(logPos.offset(0, 1, 0));
                    const blockedAbove = blockAbove && blockAbove.name.includes('leaves');
                    
                    // Score: prefer close logs at ground level
                    let score = horizDist + (Math.abs(yDiff) * 3);
                    if (blockedAbove) score += 10; // Penalize blocked logs
                    
                    if (score < bestScore) {
                        bestScore = score;
                        bestLog = { pos: logPos, type: logType };
                    }
                }
            }
            
            if (bestLog) {
                try {
                    log("chopTree", `Found ${bestLog.type} at (${bestLog.pos.x}, ${bestLog.pos.y}, ${bestLog.pos.z}), score: ${bestScore.toFixed(1)}`);
                    const breakResult = await this.breakBlock(bestLog.pos.x, bestLog.pos.y, bestLog.pos.z);
                    if (breakResult && breakResult.interrupted) {
                        return { success: chopped > 0, logsChopped: chopped, interrupted: true, reason: 'danger_interrupt' };
                    }
                    chopped++;
                    found = true;
                    failedAttempts = 0; // Reset on success
                } catch (e) {
                    log("chopTree", `Failed to break log: ${e.message}`);
                    failedAttempts++;
                    // Try exploring a bit to find better trees
                    if (failedAttempts >= 2 && !headIsBlocked) {
                        log("chopTree", `Multiple failures, moving to find better trees`);
                        try {
                            await this.explore(15);
                        } catch (e2) { }
                    }
                }
            }

            if (!found) {
                if (chopped === 0) {
                    if (headIsBlocked) {
                        log("chopTree", "No accessible trees and head is blocked — cannot explore from confined space");
                        failedAttempts++;
                        throw new Error('No accessible trees and confined space. Cannot explore.');
                    }
                    // No trees at all - try exploring
                    log("chopTree", `No accessible trees, exploring...`);
                    try {
                        await this.explore(20);
                    } catch (e) { }
                    failedAttempts++;
                    if (failedAttempts >= maxFailedAttempts) {
                        throw new Error('No accessible trees found nearby. Try exploring to a new area.');
                    }
                    continue; // Try again after exploring
                }
                break;
            }

            await this.wait(100);
        }

        // Collect dropped items
        await this.collectNearbyItems();

        return {
            success: chopped > 0,
            logsChopped: chopped,
            hint: chopped > 0 ? `Chopped ${chopped} logs` : 'No logs chopped — may be stuck or no accessible trees nearby'
        };
    }

    /**
     * Collect food from various sources
     * @param {number} count - How many food items to try to collect
     */
    async collectFood(count = 1) {
        let collected = 0;
        const errors = [];

        // Try hunting animals first
        const animals = ['pig', 'cow', 'chicken', 'sheep', 'rabbit'];
        
        for (const animal of animals) {
            if (collected >= count) break;
            if (this.shouldInterrupt?.()) {
                return { success: collected > 0, collected, interrupted: true, reason: 'danger_interrupt' };
            }
            if (this.bot.health <= 6) {
                log("collectFood", `Health critical (${this.bot.health}), aborting hunt to survive`);
                return { success: collected > 0, collected, aborted: true, reason: 'low_health',
                    hint: 'Health critical! Use flee_from or dig_emergency_shelter instead of hunting.' };
            }
            
            try {
                const result = await this.attack(animal);
                if (result.success) {
                    await this.collectNearbyItems();
                    collected++;
                }
            } catch (e) {
                errors.push(e.message);
            }
        }

        // Try harvesting crops
        const crops = ['wheat', 'carrots', 'potatoes', 'beetroots'];
        
        for (const crop of crops) {
            if (collected >= count) break;
            if (this.shouldInterrupt?.()) {
                return { success: collected > 0, collected, interrupted: true, reason: 'danger_interrupt' };
            }
            
            try {
                await this.breakBlock(crop);
                collected++;
            } catch (e) {
                errors.push(e.message);
            }
        }

        await this.collectNearbyItems();

        if (collected === 0) {
            throw new Error(`Could not collect any food: ${errors[0] || 'no food sources found'}`);
        }

        return {
            success: true,
            collected: collected
        };
    }

    // ==================== SURVIVAL ====================

    /**
     * Eat food from inventory
     */
    async eat() {
        // Quick check - return immediately if no food
        const foodItems = [
            'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
            'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato',
            'bread', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot',
            'apple', 'melon_slice', 'sweet_berries', 'glow_berries',
            'carrot', 'potato', 'beetroot', 'dried_kelp',
            'beef', 'raw_beef', 'porkchop', 'raw_porkchop', 'mutton', 'raw_mutton', 
            'chicken', 'raw_chicken', 'rabbit', 'raw_rabbit', 'salmon', 'raw_salmon', 'cod', 'raw_cod',
            'cookie', 'pumpkin_pie', 'cake', 'mushroom_stew', 'beetroot_soup',
            'rabbit_stew', 'suspicious_stew', 'honey_bottle', 'rotten_flesh'
        ];
        
        // Find food quickly
        let food = this.bot.inventory.items().find(i => 
            foodItems.includes(i.name) || i.name.includes('cooked') || 
            i.name.includes('beef') || i.name.includes('pork') ||
            i.name.includes('chicken') || i.name.includes('bread') ||
            i.name.includes('apple') || i.name === 'rotten_flesh'
        );
        
        if (!food) {
            log("eat", "No food in inventory - returning immediately");
            return {
                success: false,
                error: 'No food in inventory',
                hint: 'Hunt animals with attack action or find crops!'
            };
        }

        log("eat", `Eating ${food.name}`);
        
        try {
            await this.bot.equip(food, 'hand');
            
            // Consume with timeout
            const consumePromise = this.bot.consume();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Eat timeout')), 5000)
            );
            
            await Promise.race([consumePromise, timeoutPromise]);
            
            return {
                success: true,
                food: food.name,
                newFoodLevel: this.bot.food
            };
        } catch (e) {
            log("eat", `Eat failed: ${e.message}`);
            return {
                success: false,
                error: e.message,
                hint: 'Could not eat - try again or hunt for more food'
            };
        }
    }

    /**
     * Sleep in a bed if it's night and a bed is nearby
     */
    async sleepIfPossible() {
        // Check if it's night (13000-23000 ticks)
        const time = this.bot.time.timeOfDay;
        const isNight = time >= 13000 && time <= 23000;

        if (!isNight) {
            return { success: false, reason: 'Not night time', time };
        }

        // Find a bed
        const bedTypes = ['white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
            'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed',
            'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed'];
        
        let bedBlock = null;
        for (const bedType of bedTypes) {
            const bedData = this.mcData.blocksByName[bedType];
            if (bedData) {
                bedBlock = this.bot.findBlock({
                    matching: bedData.id,
                    maxDistance: 32
                });
                if (bedBlock) break;
            }
        }

        // If no placed bed found, try to place one from inventory
        if (!bedBlock) {
            const bedItem = this.bot.inventory.items().find(i => i.name.includes('_bed'));
            if (bedItem) {
                log('sleepIfPossible', `No placed bed found; placing ${bedItem.name} from inventory`);
                const pos = this.bot.entity.position.floored();
                const offsets = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]];
                for (const [dx, dy, dz] of offsets) {
                    try {
                        const targetPos = pos.offset(dx, dy, dz);
                        const blockAtTarget = this.bot.blockAt(targetPos);
                        const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
                        const safeGround = blockBelow && blockBelow.name !== 'air' && 
                            blockBelow.name !== 'water' && blockBelow.name !== 'lava' && 
                            !blockBelow.name.includes('leaves');
                        if (blockAtTarget && blockAtTarget.name === 'air' && safeGround) {
                            await this.placeBlock(bedItem.name, targetPos.x, targetPos.y, targetPos.z);
                            await this.wait(200);
                            // Re-find the bed we just placed
                            const bedData = this.mcData.blocksByName[bedItem.name];
                            if (bedData) {
                                bedBlock = this.bot.findBlock({
                                    matching: bedData.id,
                                    maxDistance: 4
                                });
                            }
                            if (bedBlock) break;
                        }
                    } catch (e) {
                        log('sleepIfPossible', `Failed to place bed at offset ${dx},${dy},${dz}: ${e.message}`);
                        continue;
                    }
                }
            }
        }

        if (!bedBlock) {
            return { success: false, reason: 'No bed found nearby and none could be placed from inventory' };
        }

        // Move to bed
        await this.goToNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2);

        // Try to sleep
        try {
            await this.bot.sleep(bedBlock);
            
            // Wait until we wake up
            await new Promise(resolve => {
                this.bot.once('wake', resolve);
                setTimeout(resolve, 30000); // Timeout after 30s
            });

            return { success: true, slept: true };
        } catch (e) {
            return { success: false, reason: e.message };
        }
    }

    /**
     * Flee from a specific entity type
     * @param {string} entityType - Type of entity to flee from
     * @param {number} distance - How far to flee (default 30)
     */
    async fleeFrom(entityType, distance = 30) {
        const searchType = entityType.toLowerCase();
        let entity = null;

        if (searchType === 'unknown') {
            // No specific attacker identified (e.g., hit from outside observation range).
            // Flee from the nearest hostile mob; if none, just run in a random direction.
            entity = this.bot.nearestEntity(e => this.isHostile(e));
            if (!entity) {
                return await this.fleeRandomDirection(distance);
            }
        } else {
            entity = this.bot.nearestEntity(e => {
                if (!e.name) return false;
                return e.name.toLowerCase() === searchType || 
                       e.name.toLowerCase().includes(searchType) ||
                       (e.displayName && e.displayName.toLowerCase().includes(searchType));
            });
        }

        if (!entity) {
            return { success: false, reason: `No ${entityType} nearby to flee from`, noThreat: true };
        }

        // Calculate direction away from entity
        const botPos = this.bot.entity.position;
        const entityPos = entity.position;
        const initialDistance = botPos.distanceTo(entityPos);
        const direction = botPos.minus(entityPos).normalize();
        
        // Target position away from entity
        const targetPos = botPos.plus(direction.scaled(distance));

        // Use inverted goal to flee
        const fleeGoal = new GoalInvert(new GoalNear(entityPos.x, entityPos.y, entityPos.z, 5));
        
        try {
            // Set the goal with a timeout
            const timeout = setTimeout(() => this.stop(), 10000);
            await this.bot.pathfinder.goto(fleeGoal);
            clearTimeout(timeout);
        } catch (e) {
            // Even partial fleeing is okay
        }

        const newDistance = this.bot.entity.position.distanceTo(entityPos);
        const actuallyFled = newDistance > initialDistance;
        
        return {
            success: actuallyFled,
            fledFrom: entityType,
            newDistance: Math.floor(newDistance),
            hint: actuallyFled ? `Fled to ${Math.floor(newDistance)}m away` : `Unable to flee — still ${Math.floor(newDistance)}m from ${entityType}`
        };
    }

    /**
     * Flee in a random horizontal direction when no specific threat is visible.
     * @param {number} distance - How far to flee (default 30)
     */
    async fleeRandomDirection(distance = 30) {
        const botPos = this.bot.entity.position;
        // Pick a random yaw and run ~distance blocks away from current position.
        const yaw = Math.random() * 2 * Math.PI;
        const dx = Math.sin(yaw) * distance;
        const dz = Math.cos(yaw) * distance;
        const targetPos = botPos.offset(dx, 0, dz);

        try {
            const timeout = setTimeout(() => this.stop(), 10000);
            await this.goToNear(targetPos.x, targetPos.y, targetPos.z, 2);
            clearTimeout(timeout);
            const newPos = this.bot.entity.position;
            const moved = botPos.distanceTo(newPos);
            return {
                success: moved > 2,
                fledFrom: 'unknown',
                distanceTraveled: Math.floor(moved),
                hint: moved > 2 ? `Fled ${Math.floor(moved)}m from last known danger` : `Unable to flee far`
            };
        } catch (e) {
            return { success: false, reason: 'Flee pathfinding failed', error: e.message, fledFrom: 'unknown' };
        }
    }

    /**
     * Attack a nearby entity
     * @param {string} entityType - Type of entity to attack
     * @param {boolean} chase - Whether to chase the entity (default true)
     */
    async attack(entityType, chase = true) {
        const searchType = entityType.toLowerCase();
        const entity = this.bot.nearestEntity(e => {
            if (!e.name) return false;
            return e.name.toLowerCase() === searchType || 
                   e.name.toLowerCase().includes(searchType) ||
                   (e.displayName && e.displayName.toLowerCase().includes(searchType));
        });

        if (!entity) {
            throw new Error(`No ${entityType} found nearby`);
        }

        // Equip weapon if we have one
        const weapons = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
            'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
        const weapon = this.bot.inventory.items().find(i => weapons.includes(i.name));
        if (weapon) {
            await this.bot.equip(weapon, 'hand');
        }

        // Check if this is a food animal
        const foodAnimals = ['cow', 'pig', 'chicken', 'sheep', 'rabbit'];
        const isFoodAnimal = foodAnimals.some(a => searchType.includes(a));

        const maxAttacks = 20;
        const attackRange = 2.8; // Slightly under reach to account for movement
        let attacks = 0;
        let pathfindingFailed = false;
        let followGoal = null;

        try {
            while (entity.isValid && attacks < maxAttacks) {
                // Self-preservation: abort if health is critical
                if (this.bot.health <= 6) {
                    log("attack", `Health critical (${this.bot.health}), aborting attack to survive`);
                    try { await this.eat(); } catch (e) { /* no food available */ }
                    return {
                        success: false,
                        entity: entityType,
                        attacks,
                        entityDead: false,
                        aborted: true,
                        reason: 'low_health',
                        health: this.bot.health,
                        hint: 'Health critical! Use flee_from to escape, then eat.'
                    };
                }
                // Caution against hostile mobs at moderate health
                if (this.bot.health <= 10 && !isFoodAnimal) {
                    log("attack", `Health moderate (${this.bot.health}) vs hostile, retreating`);
                    return {
                        success: false,
                        entity: entityType,
                        attacks,
                        entityDead: false,
                        aborted: true,
                        reason: 'health_caution',
                        health: this.bot.health,
                        hint: 'Health is low fighting a hostile mob. Flee and eat first.'
                    };
                }

                // Interrupt check (set by agent danger system)
                if (this.shouldInterrupt?.()) {
                    log("attack", `Interrupted by danger system`);
                    return { success: false, entity: entityType, attacks, entityDead: false, interrupted: true, reason: 'danger_interrupt' };
                }

                const distance = this.bot.entity.position.distanceTo(entity.position);
                
                if (distance > attackRange) {
                    if (!chase) {
                        break;
                    }
                    // Use GoalFollow for moving targets instead of repeatedly pathing to a
                    // stale position. This avoids whiffing attacks on fleeing animals.
                    if (!followGoal || followGoal.entity !== entity) {
                        if (followGoal) {
                            this.bot.pathfinder.setGoal(null);
                        }
                        followGoal = new GoalFollow(entity, 1.5);
                        this.bot.pathfinder.setGoal(followGoal, true); // dynamic goal
                        log("attack", `Following ${entityType} (distance ${distance.toFixed(1)})`);
                    }
                    await this.wait(250);
                    continue;
                }

                // Within attack range: clear follow goal, look, and strike.
                if (followGoal) {
                    this.bot.pathfinder.setGoal(null);
                    followGoal = null;
                }

                await this.bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
                await this.bot.attack(entity);
                attacks++;
                
                await this.wait(650); // ~Minecraft 1.20 attack cooldown
            }
        } finally {
            // Always clear the dynamic follow goal so it doesn't outlive the action.
            if (followGoal) {
                this.bot.pathfinder.setGoal(null);
            }
        }

        // If we killed a food animal, collect the drops and try to eat
        if (!entity.isValid && isFoodAnimal) {
            log("attack", `Killed ${entityType}, collecting drops...`);
            await this.wait(500); // Wait for drops to spawn
            await this.collectNearbyItems();
            
            // Auto-eat if hungry
            if (this.bot.food < 18) {
                log("attack", `Food level is ${this.bot.food}, attempting to eat...`);
                try {
                    await this.eat();
                    log("attack", `Ate food, new food level: ${this.bot.food}`);
                } catch (e) {
                    log("attack", `Couldn't eat: ${e.message}`);
                }
            }
        }

        return {
            success: !entity.isValid,
            entity: entityType,
            attacks: attacks,
            entityDead: !entity.isValid,
            hint: isFoodAnimal && !entity.isValid ? 'Collected drops. If hungry, use eat action.' : undefined
        };
    }

    /**
     * Light up an area with torches
     * @param {number} radius - Radius to light up (default 5)
     */
    async lightArea(radius = 5) {
        let torch = this.bot.inventory.items().find(i => i.name === 'torch' || i.name === 'lantern');

        // If no torches, try to craft them from coal/charcoal + sticks.
        if (!torch) {
            const hasCoal = this.bot.inventory.items().some(i => i.name === 'coal' || i.name === 'charcoal');
            const hasSticks = this.bot.inventory.items().some(i => i.name === 'stick');
            if (hasCoal && hasSticks) {
                log('lightArea', 'No torches but have coal/charcoal and sticks — crafting torches');
                try {
                    await this.ensureCrafted('torch', 4);
                    torch = this.bot.inventory.items().find(i => i.name === 'torch' || i.name === 'lantern');
                } catch (e) {
                    log('lightArea', `Could not craft torches: ${e.message}`);
                }
            }
        }

        if (!torch) {
            throw new Error('No torches or lanterns in inventory, and no coal/charcoal + sticks to craft them. Mine coal_ore first.');
        }

        const pos = this.bot.entity.position.floored();
        let placed = 0;

        // Place torches in a grid pattern
        for (let dx = -radius; dx <= radius; dx += 4) {
            for (let dz = -radius; dz <= radius; dz += 4) {
                if (placed >= 10) break; // Limit number of torches
                
                const targetPos = pos.offset(dx, 0, dz);
                
                try {
                    // Check if we can place here
                    const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
                    const blockAt = this.bot.blockAt(targetPos);
                    
                    if (blockBelow && blockBelow.name !== 'air' && 
                        blockAt && blockAt.name === 'air') {
                        await this.placeBlock(torch.name, targetPos.x, targetPos.y, targetPos.z);
                        placed++;
                        await this.wait(200);
                    }
                } catch (e) {
                    // Skip this position
                }
            }
        }

        return {
            success: placed > 0,
            torchesPlaced: placed
        };
    }

    /**
     * Build a simple shelter
     */
    async buildShelter() {
        const pos = this.bot.entity.position.floored();
        
        // Check if we're already underground or in a shelter
        const blockAbove = this.bot.blockAt(pos.offset(0, 2, 0));
        const blockAbove2 = this.bot.blockAt(pos.offset(0, 3, 0));
        const isSolidCover = blockAbove && blockAbove.name !== 'air' && blockAbove.name !== 'water' && !blockAbove.name.includes('leaves');
        
        if (isSolidCover) {
            log("buildShelter", `Already underground/sheltered (block above: ${blockAbove.name})`);
            return {
                success: true,
                blocksPlaced: 0,
                hint: 'Already underground - you ARE sheltered! Wait for day or pillar_up to return to surface.',
                alreadySheltered: true,
                shelterLocation: { x: pos.x, y: pos.y, z: pos.z }
            };
        }
        
        // Check for ANY building materials - be flexible!
        const blockPriority = ['cobblestone', 'stone', 'planks', 'dirt', 'sand', 'gravel', 'netherrack'];
        
        // Exclude tools that happen to contain block substrings in their names (e.g. stone_pickaxe matches 'stone')
        const isTool = (name) => name.includes('pickaxe') || name.includes('axe') || name.includes('sword') || 
                                  name.includes('shovel') || name.includes('hoe') || name.includes('shears');
        
        const buildingBlocks = this.bot.inventory.items().filter(i => {
            const name = i.name.toLowerCase();
            if (isTool(name)) return false;
            return blockPriority.some(p => name.includes(p)) ||
                   name.includes('brick') || name.includes('wood') || 
                   name === 'clay' || name.includes('terracotta');
        });
        
        const totalBlocks = buildingBlocks.reduce((sum, b) => sum + b.count, 0);
        log("buildShelter", `Found ${totalBlocks} building blocks`);

        // If we don't have enough blocks, dig an emergency shelter instead
        if (totalBlocks < 10) {
            log("buildShelter", `Not enough blocks, digging emergency shelter`);
            return await this.digEmergencyShelter();
        }

        let placed = 0;

        // Find a flatter nearby spot first. Building exactly at current location
        // often fails when standing on uneven terrain or near hazards.
        const findShelterSpot = () => {
            const candidates = [];
            for (let dx = -10; dx <= 10; dx += 2) {
                for (let dz = -10; dz <= 10; dz += 2) {
                    const base = pos.offset(dx, 0, dz);
                    const floor = this.bot.blockAt(base.offset(0, -1, 0));
                    const feet = this.bot.blockAt(base);
                    const head = this.bot.blockAt(base.offset(0, 1, 0));
                    const nearWater = ['water', 'lava'].some(fluid => {
                        const around = [
                            base.offset(1, -1, 0),
                            base.offset(-1, -1, 0),
                            base.offset(0, -1, 1),
                            base.offset(0, -1, -1)
                        ];
                        return around.some(p => this.bot.blockAt(p)?.name === fluid);
                    });
                    const flat = floor && floor.name !== 'air' && feet?.name === 'air' && head?.name === 'air' && !nearWater;
                    if (flat) candidates.push(base);
                }
            }
            candidates.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));
            return candidates[0] || pos;
        };

        const shelterCenter = findShelterSpot();
        if (this.bot.entity.position.distanceTo(shelterCenter) > 2) {
            try {
                await this.goToNear(shelterCenter.x, shelterCenter.y, shelterCenter.z, 2);
            } catch (e) {
                // proceed at current position if movement fails
            }
        }
        const center = this.bot.entity.position.floored();
        
        // Build a simple shelter - scale based on materials available
        const size = totalBlocks >= 30 ? 3 : 2;
        const height = totalBlocks >= 40 ? 3 : 2;
        
        // Build walls and roof
        const wallPositions = [];
        
        // Walls
        for (let y = 0; y < height; y++) {
            for (let x = -size; x <= size; x++) {
                for (let z = -size; z <= size; z++) {
                    // Only edges (walls)
                    if (Math.abs(x) === size || Math.abs(z) === size) {
                        // Leave door opening
                        if (y < 2 && x === 0 && z === -size) continue;
                        wallPositions.push({ x: center.x + x, y: center.y + y, z: center.z + z });
                    }
                }
            }
        }
        
        // Roof
        for (let x = -size; x <= size; x++) {
            for (let z = -size; z <= size; z++) {
                wallPositions.push({ x: center.x + x, y: center.y + height, z: center.z + z });
            }
        }

        // Place blocks using whatever materials we have
        // Hard wall: bail out after 30s so a stalled placeBlock chain never locks the decision loop.
        const shelterBuildDeadline = Date.now() + 30000;
        for (const wallPos of wallPositions) {
            if (Date.now() > shelterBuildDeadline) {
                log("buildShelter", `Timeout reached after 30s (${placed} blocks placed). Stopping early.`);
                break;
            }
            if (buildingBlocks.length === 0) break;

            // Find a block we still have (explicitly exclude tools)
            const availableBlock = this.bot.inventory.items().find(i => {
                const name = i.name.toLowerCase();
                if (isTool(name)) return false;
                return blockPriority.some(p => name.includes(p)) ||
                       name.includes('brick') || name.includes('wood');
            });

            if (!availableBlock) break;

            try {
                await this.placeBlock(availableBlock.name, wallPos.x, wallPos.y, wallPos.z);
                placed++;
                await this.wait(50);
            } catch (e) {
                // Skip failed placements
            }
        }

        // Light the shelter interior to prevent mob spawning
        if (placed > 5) {
            await this.placeTorchInShelter();
        }

        return {
            success: placed > 5,
            blocksPlaced: placed,
            shelterLocation: { x: center.x, y: center.y, z: center.z }
        };
    }

    /**
     * Dig an emergency shelter when no building materials available
     * Digs a 1x2x1 hole and covers the top
     */
    async digEmergencyShelter() {
        const startPos = this.bot.entity.position.floored();
        log("digEmergencyShelter", `Digging at ${startPos.x}, ${startPos.y}, ${startPos.z}`);
        
        // SAFETY: Don't dig if standing on leaves — bot will fall through and take damage
        const blockBelow = this.bot.blockAt(startPos.offset(0, -1, 0));
        if (blockBelow && blockBelow.name.includes('leaves')) {
            log("digEmergencyShelter", "Standing on leaves — unsafe to dig down. Aborting.");
            return { success: false, error: 'Standing on tree leaves. Move to solid ground before digging.' };
        }
        
        // SAFETY: Don't dig if there's a dangerous fall below (>3 blocks of air/leaves)
        let fallDistance = 0;
        for (let dy = -2; dy >= -20; dy--) {
            const checkPos = startPos.offset(0, dy, 0);
            const block = this.bot.blockAt(checkPos);
            if (!block || block.name === 'air' || block.name === 'water' || block.name === 'lava' || block.name.includes('leaves')) {
                fallDistance++;
            } else {
                break;
            }
        }
        if (fallDistance > 3) {
            log("digEmergencyShelter", `Unsafe fall detected: ${fallDistance} blocks below. Aborting.`);
            return { success: false, error: `Unsafe to dig: ${fallDistance} block drop below. Find solid ground first.` };
        }
        
        let dugBlocks = [];
        
        // Safety check: depth without pickaxe.
        // A 1-block pit is useless — zombies/skeletons can still reach in. A 2-block pit
        // actually provides protection, and the bot can break dirt by hand in ~1s to escape.
        // 3-block pit without pickaxe risks trapping, so cap at 2.
        const hasPickaxe = this.bot.inventory.items().some(i => i.name.includes('pickaxe'));
        const maxDepth = hasPickaxe ? 3 : 2;
        
        // Dig down to make a pit (equip best tool per block so we don't dig stone bare-handed)
        for (let depth = 1; depth <= maxDepth; depth++) {
            if (this.shouldInterrupt?.()) {
                log("digEmergencyShelter", "Interrupted by danger");
                break;
            }
            const digPos = startPos.offset(0, -depth, 0);
            const block = this.bot.blockAt(digPos);
            if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
                try {
                    await this.equipBestToolForBlock(block);
                    await this.bot.dig(block);
                    dugBlocks.push(block.name);
                    await this.wait(100);
                } catch (e) {
                    log("digEmergencyShelter", `Failed to dig: ${e.message}`);
                    break;
                }
            }
        }
        
        // Actually drop into the hole by moving to the dig position
        if (dugBlocks.length >= 1) {
            // Clear any blocks in the way first
            this.bot.setControlState('sneak', false);
            this.bot.setControlState('jump', false);
            
            // Wait for gravity to pull us down
            await this.wait(800);
            
            // Get current position after falling
            const currentPos = this.bot.entity.position.floored();
            log("digEmergencyShelter", `Now at ${currentPos.x}, ${currentPos.y}, ${currentPos.z}`);
            
            // Seal the entrance at startPos (the original surface level).
            // We look for the solid ground block immediately adjacent to the opening
            // and place against its inward-facing side. startPos itself was dug out,
            // so the four neighbours at the same Y are undisturbed ground.
            const sealMaterial = this.bot.inventory.items().find(i =>
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('stone') ||
                i.name === 'gravel' || i.name === 'sand'
            );

            let sealed = false;
            // Seal entrance even without pickaxe — dirt/cobble can be broken by hand
            // in ~1s, and a sealed shelter prevents skeleton arrows. Trapping is safer
            // than dying to ranged mobs.
            if (sealMaterial) {
                try {
                    await this.bot.equip(sealMaterial, 'hand');
                    await this.wait(100);

                    const sealNeighbours = [
                        new Vec3(1, 0, 0),
                        new Vec3(-1, 0, 0),
                        new Vec3(0, 0, 1),
                        new Vec3(0, 0, -1)
                    ];

                    for (const offset of sealNeighbours) {
                        const adjBlock = this.bot.blockAt(startPos.plus(offset));
                        if (adjBlock && adjBlock.name !== 'air') {
                            try {
                                // Place against the inward face of the adjacent block
                                // → puts a new block at startPos (the hole entrance)
                                await this.bot.placeBlock(adjBlock, offset.scaled(-1));
                                sealed = true;
                                log("digEmergencyShelter", `Sealed entrance with ${sealMaterial.name}`);
                                break;
                            } catch (e) {
                                // Try next neighbour
                            }
                        }
                    }
                } catch (e) {
                    log("digEmergencyShelter", `Couldn't seal top: ${e.message}`);
                }
            } else {
                log("digEmergencyShelter", `No seal material available.`);
            }
        }

        // Place a torch on the pit wall if available — prevents mob spawning inside
        if (dugBlocks.length >= 1) {
            await this.placeTorchInShelter();
        }

        return {
            success: dugBlocks.length >= 1,
            depth: dugBlocks.length,
            sealed: dugBlocks.length >= 1,
            message: dugBlocks.length >= 1 ? 'Emergency pit shelter dug' : 'Could not dig shelter'
        };
    }

    /**
     * Place a torch on any adjacent solid wall block (used after entering shelter).
     */
    async placeTorchInShelter() {
        const torch = this.bot.inventory.items().find(i => i.name === 'torch');
        if (!torch) return false;
        try {
            await this.bot.equip(torch, 'hand');
            const pos = this.bot.entity.position.floored();
            const wallOffsets = [
                new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1), new Vec3(0, 0, -1)
            ];
            for (const offset of wallOffsets) {
                const wallBlock = this.bot.blockAt(pos.plus(offset));
                if (wallBlock && wallBlock.name !== 'air') {
                    try {
                        await this.bot.placeBlock(wallBlock, offset.scaled(-1));
                        log("placeTorchInShelter", "Torch placed on shelter wall");
                        return true;
                    } catch (e) {
                        // try next wall
                    }
                }
            }
        } catch (e) {
            log("placeTorchInShelter", `Failed: ${e.message}`);
        }
        return false;
    }

    /**
     * Emergency swim to surface - for drowning situations
     */
    async swimUp() {
        const startY = this.bot.entity.position.y;
        const startOxygen = this.bot.oxygenLevel;
        const isInWater = this.bot.entity.isInWater;
        
        // Check if we're actually in water
        if (!isInWater && startOxygen >= 20) {
            log('swimUp', 'Not in water and oxygen is full - no need to swim up');
            return {
                success: true,
                startY: Math.floor(startY),
                endY: Math.floor(startY),
                rose: 0,
                oxygenRecovered: false,
                inWater: false,
                hint: 'You are NOT underwater! Oxygen is full. No need to swim up.'
            };
        }
        
        log('swimUp', 'EMERGENCY SURFACING!');
        
        const Vec3 = require('vec3');
        
        // PHASE 1: Look straight UP and swim for 4 seconds
        // In modern Minecraft, looking up + holding W + jump is the fastest way to surface
        log('swimUp', 'Phase 1: Swimming straight UP (looking up + forward + jump)');
        try {
            await this.bot.look(this.bot.entity.yaw, -Math.PI / 2);
        } catch (e) {}
        
        for (let i = 0; i < 40; i++) {
            this.bot.setControlState('jump', true);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', false);
            await this.wait(100);
            
            if (!this.bot.entity.isInWater) {
                log('swimUp', 'Surfaced!');
                break;
            }
        }
        
        // PHASE 1b: If still underwater and oxygen is low, break any breakable block
        // directly above the head (e.g. under a ledge / waterfall) to create an escape path.
        if (this.bot.entity.isInWater && this.bot.oxygenLevel <= 10) {
            const headPos = this.bot.entity.position.floored().offset(0, 1, 0);
            const aboveHead = this.bot.blockAt(headPos);
            if (aboveHead && aboveHead.name !== 'air' && aboveHead.name !== 'water' && aboveHead.name !== 'lava' && aboveHead.name !== 'bedrock' && this.bot.canDigBlock(aboveHead)) {
                log('swimUp', `Blocked above by ${aboveHead.name} — breaking to surface`);
                try {
                    await this.equipBestToolForBlock(aboveHead);
                    await this.bot.dig(aboveHead);
                    await this.wait(200);
                } catch (e) {
                    log('swimUp', `Could not break block above head: ${e.message}`);
                }
            }
        }

        // If still in water, try to find land direction at SURFACE level
        if (this.bot.entity.isInWater) {
            log('swimUp', 'Still in water, looking for land...');
            
            const pos = this.bot.entity.position;
            const directions = [
                { x: 1, z: 0, name: 'east' },
                { x: -1, z: 0, name: 'west' },
                { x: 0, z: 1, name: 'south' },
                { x: 0, z: -1, name: 'north' }
            ];
            
            // Find actual surface level (first air above water)
            let surfaceY = Math.floor(pos.y) + 1;
            for (let checkY = Math.floor(pos.y) + 1; checkY < pos.y + 20; checkY++) {
                const block = this.bot.blockAt(new Vec3(Math.floor(pos.x), checkY, Math.floor(pos.z)));
                if (!block || block.name === 'air') {
                    surfaceY = checkY;
                    break;
                }
            }
            
            // Check at surface level for land
            let landDir = null;
            for (const dir of directions) {
                for (let dist = 1; dist <= 15; dist++) {
                    const checkPos = new Vec3(
                        Math.floor(pos.x + dir.x * dist),
                        surfaceY,
                        Math.floor(pos.z + dir.z * dist)
                    );
                    const block = this.bot.blockAt(checkPos);
                    if (block && block.name !== 'water' && block.name !== 'air' && block.name !== 'lava') {
                        landDir = dir;
                        log('swimUp', `Found land to ${dir.name}, ${dist} blocks`);
                        break;
                    }
                }
                if (landDir) break;
            }
            
            if (!landDir) {
                landDir = directions[0]; // Default east
            }
            
            // PHASE 2: Swim UP and TOWARD land
            log('swimUp', `Phase 2: Swimming toward ${landDir.name}`);
            const lookTarget = pos.offset(landDir.x * 10, 0, landDir.z * 10);
            try {
                await this.bot.lookAt(lookTarget);
            } catch (e) {}
            
            for (let i = 0; i < 40; i++) {
                this.bot.setControlState('jump', true);
                this.bot.setControlState('forward', true);
                await this.wait(100);
                
                if (!this.bot.entity.isInWater) {
                    log('swimUp', 'Reached shore!');
                    break;
                }
            }
        }
        
        // PHASE 3: EMERGENCY - if still drowning, create air pocket or pillar
        if (this.bot.entity.isInWater && this.bot.oxygenLevel <= 10) {
            log('swimUp', 'Phase 3: EMERGENCY - creating air pocket');

            const placeables = this.bot.inventory.items().filter(i =>
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks') || i.name.includes('_log')
            );

            if (placeables.length > 0) {
                // First push up by placing a block under feet.
                const footPos = this.bot.entity.position.floored();
                const underBlock = this.bot.blockAt(footPos.offset(0, -1, 0));
                if (underBlock && underBlock.name === 'water') {
                    for (const placeable of placeables) {
                        try {
                            await this.bot.equip(placeable.type, 'hand');
                            await this.bot.placeBlock(underBlock, new Vec3(0, 1, 0));
                            await this.wait(300);
                            if (!this.bot.entity.isInWater) break;
                        } catch (e) {
                            log('swimUp', `Emergency foot pillar failed with ${placeable.name}: ${e.message}`);
                        }
                    }
                }

                // Then create a head-level air pocket from multiple reference faces.
                if (this.bot.entity.isInWater) {
                    const headPos = this.bot.entity.position.floored().offset(0, 1, 0);
                    const headBlock = this.bot.blockAt(headPos);
                    if (headBlock && headBlock.name === 'water') {
                        const refs = [
                            { pos: headPos.offset(0, -1, 0), face: new Vec3(0, 1, 0) },
                            { pos: headPos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
                            { pos: headPos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
                            { pos: headPos.offset(0, 0, 1), face: new Vec3(0, 0, -1) },
                            { pos: headPos.offset(0, 0, -1), face: new Vec3(0, 0, 1) }
                        ];
                        for (const placeable of placeables) {
                            for (const ref of refs) {
                                const refBlock = this.bot.blockAt(ref.pos);
                                if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water' && refBlock.name !== 'lava') {
                                    try {
                                        await this.bot.equip(placeable.type, 'hand');
                                        await this.bot.placeBlock(refBlock, ref.face);
                                        await this.wait(300);
                                        if (!this.bot.entity.isInWater) break;
                                    } catch (e) {
                                        log('swimUp', `Air pocket placement failed: ${e.message}`);
                                    }
                                }
                            }
                            if (!this.bot.entity.isInWater) break;
                        }
                    }
                }
            }
        }
        
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', false);
        
        // Walk onto land if we escaped
        if (!this.bot.entity.isInWater) {
            log('swimUp', 'Walking onto land...');
            try {
                await this.bot.look(this.bot.entity.yaw, 0);
            } catch (e) {}
            this.bot.setControlState('forward', true);
            this.bot.setControlState('jump', true);
            await this.wait(2000);
            this.bot.setControlState('forward', false);
            this.bot.setControlState('jump', false);
        }
        
        const endY = this.bot.entity.position.y;
        const stillInWater = this.bot.entity.isInWater;
        
        log('swimUp', `Result: started Y=${startY.toFixed(1)}, ended Y=${endY.toFixed(1)}, inWater=${stillInWater}`);
        
        const endOxygen = this.bot.oxygenLevel;
        const stillDrowning = stillInWater || endOxygen < 10;
        let hint = 'Escaped water!';
        if (stillInWater) hint = 'Still in water! Keep calling swim_up!';
        else if (endOxygen < 10) hint = 'Out of water but oxygen still low. Stay on land to recover.';

        return {
            success: !stillInWater,
            startY: Math.floor(startY),
            endY: Math.floor(endY),
            rose: Math.floor(endY - startY),
            oxygen: endOxygen,
            oxygenRecovered: endOxygen > startOxygen,
            inWater: stillInWater,
            stillDrowning,
            hint
        };
    }

    /**
     * Check whether the bot is physically confined (surrounded by solid blocks/walls).
     * Used by pillar_up to avoid giving up just because Y is high while still trapped.
     */
    isPhysicallyConfined() {
        const pos = this.bot.entity.position.floored();
        const dirs = [
            { x: 1, z: 0 }, { x: -1, z: 0 },
            { x: 0, z: 1 }, { x: 0, z: -1 }
        ];
        let blocked = 0;
        for (const dir of dirs) {
            const feet = this.bot.blockAt(pos.offset(dir.x, 0, dir.z));
            const head = this.bot.blockAt(pos.offset(dir.x, 1, dir.z));
            const isSolid = (b) => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && !b.name.includes('leaves') && !b.name.includes('grass');
            if (isSolid(feet) || isSolid(head)) {
                blocked++;
            }
        }
        // Also consider confined if standing in a 1-block deep pit with walls nearby
        return blocked >= 3;
    }

    /**
     * Pillar up by placing blocks beneath yourself - to escape holes
     * NOTE: dig_to_surface is usually faster and more reliable!
     * @param {number} height - How many blocks to pillar up
     */
    async pillarUp(height = 10) {
        log("pillarUp", `Pillaring up ${height} blocks`);
        
        const Vec3 = require('vec3');
        const pos = this.bot.entity.position.floored();
        let placed = 0;
        const startY = this.bot.entity.position.y;

        // Dig blocks above head first so there's room to pillar (otherwise placement fails under a solid ceiling)
        for (const dy of [1, 2]) {
            const above = this.bot.blockAt(pos.offset(0, dy, 0));
            if (above && above.name !== 'air' && above.name !== 'water' && above.name !== 'lava' && above.name !== 'bedrock' && this.bot.canDigBlock(above)) {
                try {
                    await this.equipBestToolForBlock(above);
                    log("pillarUp", `Clearing block above: ${above.name} at +${dy}`);
                    await this.bot.dig(above);
                    await this.wait(200);
                } catch (e) {
                    log("pillarUp", `Could not clear above: ${e.message}`);
                }
            }
        }
        
        // Find placeable blocks - prefer dirt/cobble
        const getPlaceableBlock = () => this.bot.inventory.items().find(i => 
            i.name === 'dirt' || i.name === 'cobblestone' || 
            i.name.includes('planks') || i.name.includes('_log')
        );

        // Check overhead obstruction before wasting loops. If solid stone is directly above
        // and we have no pickaxe, pillar_up will fail repeatedly.
        const headPos = this.bot.entity.position.floored();
        const overhead = this.bot.blockAt(headPos.offset(0, 1, 0));
        const overhead2 = this.bot.blockAt(headPos.offset(0, 2, 0));
        const isSolid = (b) => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'leaves';
        const isStoneLike = (b) => isSolid(b) && (b.name.includes('stone') || b.name.includes('cobble') || b.name.includes('ore') || b.name.includes('deepslate'));
        const hasPickaxe = this.bot.inventory.items().some(i => i.name.includes('pickaxe'));
        if ((isStoneLike(overhead) || isStoneLike(overhead2)) && !hasPickaxe) {
            log('pillarUp', 'Solid stone overhead and no pickaxe — cannot pillar');
            return {
                success: false,
                blocksPlaced: 0,
                error: 'Solid stone overhead and no pickaxe. Use dig_to_surface after crafting a pickaxe, or find another escape route.',
                hint: 'Solid stone overhead and no pickaxe. Use dig_to_surface after crafting a pickaxe, or find another escape route.'
            };
        }

        let blockItem = getPlaceableBlock();
        if (!blockItem) {
            // Try to quickly mine one block underfoot to bootstrap a pillar block.
            const under = this.bot.blockAt(this.bot.entity.position.floored().offset(0, -1, 0));
            if (under && under.name !== 'air' && under.name !== 'bedrock' && this.bot.canDigBlock(under)) {
                try {
                    await this.bot.dig(under);
                    await this.wait(250);
                } catch (e) {
                    // ignore, fallback below
                }
            }
            blockItem = getPlaceableBlock();
            if (!blockItem) {
                log('pillarUp', 'No blocks to pillar with');
                return {
                    success: false,
                    blocksPlaced: 0,
                    hint: 'No blocks to pillar with! Use dig_to_surface instead - it mines upward!'
                };
            }
        }
        
        // Equip the block and look down
        await this.bot.equip(blockItem, 'hand');
        await this.bot.look(0, Math.PI / 2, true);
        
        let failedPlacements = 0;
        for (let i = 0; i < height && placed < height; i++) {
            const currentBlock = getPlaceableBlock();
            if (!currentBlock) {
                log('pillarUp', 'Out of blocks');
                break;
            }
            
            if (this.bot.heldItem?.name !== currentBlock.name) {
                await this.bot.equip(currentBlock, 'hand');
                await this.bot.look(0, Math.PI / 2, true);
            }
            
            // Clear blocks directly above head so we have room to jump and place.
            // This lets pillar_up work even under a solid ceiling (e.g. cave roof, tree canopy).
            const headPos = this.bot.entity.position.floored();
            for (const dy of [1, 2]) {
                const above = this.bot.blockAt(headPos.offset(0, dy, 0));
                if (above && above.name !== 'air' && above.name !== 'water' && above.name !== 'lava' && above.name !== 'bedrock' && this.bot.canDigBlock(above)) {
                    try {
                        await this.equipBestToolForBlock(above);
                        log("pillarUp", `Clearing overhead: ${above.name} at +${dy}`);
                        await this.bot.dig(above);
                        await this.wait(200);
                        // Re-equip placeable block after digging
                        await this.bot.equip(currentBlock, 'hand');
                        await this.bot.look(0, Math.PI / 2, true);
                    } catch (e) {
                        log("pillarUp", `Could not clear overhead: ${e.message}`);
                    }
                }
            }
            
            // Jump
            const beforeY = this.bot.entity.position.y;
            this.bot.setControlState('jump', true);
            await this.wait(350);
            await this.wait(50);
            
            // At peak of jump, try to place
            try {
                const blockBelow = this.bot.blockAt(this.bot.entity.position.floored().offset(0, -1, 0));
                if (blockBelow && blockBelow.name !== 'air') {
                    await this.bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
                    placed++;
                    failedPlacements = 0;
                    log("pillarUp", `Placed ${placed}/${height}`);
                } else {
                    failedPlacements++;
                }
            } catch (e) {
                log("pillarUp", `Place attempt: ${e.message}`);
                failedPlacements++;
            }
            
            this.bot.setControlState('jump', false);
            await this.wait(150);

            const afterY = this.bot.entity.position.y;
            if (afterY <= beforeY + 0.1) {
                failedPlacements++;
            }
            if (failedPlacements >= 3) {
                const confined = this.isPhysicallyConfined();
                const atOrAboveSurface = this.bot.entity.position.y >= 62;
                // Only stop early if we are actually free to move. If we are still
                // confined, keep trying (or fall back to dig_to_surface if deep).
                if (atOrAboveSurface && !confined) {
                    log('pillarUp', 'Near surface, placement failed, but no longer confined — stopping');
                    return {
                        success: placed > 0,
                        blocksPlaced: placed,
                        startY: Math.floor(startY),
                        endY: Math.floor(this.bot.entity.position.y),
                        rose: Math.floor(this.bot.entity.position.y - startY),
                        hint: 'pillar_up stopped near open ground.'
                    };
                }
                log('pillarUp', 'Repeated placement failures, falling back to dig_to_surface');
                const fallback = await this.digToSurface();
                return {
                    success: fallback.success,
                    blocksPlaced: placed,
                    startY: Math.floor(startY),
                    endY: Math.floor(this.bot.entity.position.y),
                    rose: Math.floor(this.bot.entity.position.y - startY),
                    hint: 'pillar_up failed repeatedly, used dig_to_surface fallback'
                };
            }
        }
        
        this.bot.setControlState('jump', false);
        const endY = this.bot.entity.position.y;
        
        return {
            success: placed > 0,
            blocksPlaced: placed,
            startY: Math.floor(startY),
            endY: Math.floor(endY),
            rose: Math.floor(endY - startY),
            hint: placed > 0 ? `Pillared up ${placed} blocks!` : 'Could not pillar - try dig_to_surface instead'
        };
    }

    /**
     * Dig upward to reach the surface - simple staircase
     * Mine forward, step up, repeat - guaranteed to gain height
     */
    async digToSurface() {
        log('digToSurface', 'Digging staircase UP to surface...');
        const startY = this.bot.entity.position.y;
        let mined = 0;
        const maxBlocks = 30;
        
        // Equip best tool for escaping (we'll re-equip per block for dirt vs stone)
        const pickaxes = this.bot.inventory.items().filter(i => i.name.includes('pickaxe'));
        const shovels = this.bot.inventory.items().filter(i => i.name.includes('shovel'));
        const axes = this.bot.inventory.items().filter(i => i.name.includes('_axe'));
        const bestPick = pickaxes.length ? pickaxes.sort((a, b) => {
            const order = ['diamond', 'iron', 'stone', 'wooden'];
            return order.findIndex(m => a.name.includes(m)) - order.findIndex(m => b.name.includes(m));
        })[0] : null;
        const hasPickaxe = !!bestPick;
        // Don't break the last/only pickaxe during escape — save it for actual mining
        const isOnlyPickaxe = pickaxes.length === 1;
        const pickaxeDurability = bestPick ? (bestPick.maxDurability - (bestPick.durabilityUsed || 0)) : 0;
        const pickaxeLow = isOnlyPickaxe && pickaxeDurability <= 5;
        if (bestPick && !pickaxeLow) {
            try { await this.bot.equip(bestPick, 'hand'); log('digToSurface', `Equipped ${bestPick.name}`); } catch (e) {}
        } else if (shovels.length) {
            try { await this.bot.equip(shovels[0], 'hand'); log('digToSurface', 'Equipped shovel'); } catch (e) {}
        } else if (axes.length) {
            try { await this.bot.equip(axes[0], 'hand'); log('digToSurface', 'Equipped axe'); } catch (e) {}
        }

        // Direction to dig - pick one and stick with it
        const yaw = this.bot.entity.yaw;
        let dir;
        if (yaw >= -0.785 && yaw < 0.785) dir = { x: 0, z: -1 }; // South
        else if (yaw >= 0.785 && yaw < 2.356) dir = { x: -1, z: 0 }; // West
        else if (yaw >= -2.356 && yaw < -0.785) dir = { x: 1, z: 0 }; // East
        else dir = { x: 0, z: 1 }; // North
        
        log('digToSurface', `Digging direction: x=${dir.x}, z=${dir.z}`);

        // If the block in front is stone/cobblestone and we have no pickaxe (or only pickaxe is too low),
        // try the other directions first before giving up.
        const isStone = (block) => block && (block.name.includes('stone') || block.name.includes('cobble') || block.name.includes('ore'));
        const canBreakByHand = (block) => block && !isStone(block) && block.name !== 'bedrock';
        const originalDir = { ...dir };
        const dirs = [dir, { x: 0, z: 1 }, { x: 0, z: -1 }, { x: -dir.x, z: -dir.z }];
        let foundDir = null;
        for (const tryDir of dirs) {
            const tryBlock = this.bot.blockAt(this.bot.entity.position.floored().offset(tryDir.x, 0, tryDir.z));
            if (canBreakByHand(tryBlock)) {
                foundDir = tryDir;
                break;
            }
        }
        if (foundDir) {
            dir = foundDir;
            log('digToSurface', `Changed digging direction to x=${dir.x}, z=${dir.z} to avoid stone`);
        } else {
            const stepBlock = this.bot.blockAt(this.bot.entity.position.floored().offset(originalDir.x, 0, originalDir.z));
            const needsPick = isStone(stepBlock);
            if (needsPick && (!hasPickaxe || pickaxeLow)) {
                if (pickaxeLow) {
                    log('digToSurface', `Only pickaxe has ${pickaxeDurability} uses left — aborting to preserve it for mining. Use pillar_up with placeable blocks instead.`);
                    return {
                        success: false,
                        blocksMined: 0,
                        startY: Math.floor(startY),
                        endY: Math.floor(startY),
                        rose: 0,
                        hint: 'Only pickaxe is nearly broken. Craft a replacement first, or use pillar_up with placeable blocks.'
                    };
                }
                log('digToSurface', 'Stone in all directions and no pickaxe - cannot dig efficiently');
                return {
                    success: false,
                    blocksMined: 0,
                    startY: Math.floor(startY),
                    endY: Math.floor(startY),
                    rose: 0,
                    hint: 'Need a pickaxe to dig through stone. Craft wooden_pickaxe first, or use pillar_up if you have placeable blocks (dirt, cobble, planks).'
                };
            }
        }
        
        let lastY = startY;
        let stuckCount = 0;
        let iterations = 0;
        const maxIterations = 20;
        
        // Keep digging until we see open sky (surface) or hit safety limits
        while (mined < maxBlocks && iterations < maxIterations) {
            iterations++;
            if (this.shouldInterrupt?.()) {
                log('digToSurface', 'Interrupted by danger system');
                return {
                    success: mined > 0,
                    blocksMined: mined,
                    startY: Math.floor(startY),
                    endY: Math.floor(this.bot.entity.position.y),
                    rose: Math.floor(this.bot.entity.position.y - startY),
                    interrupted: true,
                    reason: 'danger_interrupt',
                    hint: 'Aborted for survival. Flee or swim_up first.'
                };
            }
            const pos = this.bot.entity.position.floored();
            
            // Check if can see sky
            let canSeeSky = true;
            for (let checkY = 1; checkY <= 5; checkY++) {
                const checkBlock = this.bot.blockAt(pos.offset(0, checkY, 0));
                if (checkBlock && checkBlock.name !== 'air' && checkBlock.name !== 'water' && checkBlock.name !== 'leaves') {
                    canSeeSky = false;
                    break;
                }
            }
            
            // If we can see sky, we're effectively at surface level — climb out
            if (canSeeSky) {
                log('digToSurface', 'Can see sky - trying to climb out of pit!');
                
                // Check if we're actually stuck in a pit by looking for walls around us
                const wallDirs = [
                    { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }
                ];
                let foundExit = false;
                
                for (const wallDir of wallDirs) {
                    // Check if this direction has a walkable path (no wall at feet/head level)
                    const feetBlock = this.bot.blockAt(pos.offset(wallDir.x, 0, wallDir.z));
                    const headBlock = this.bot.blockAt(pos.offset(wallDir.x, 1, wallDir.z));
                    
                    if ((!feetBlock || feetBlock.name === 'air' || feetBlock.name === 'grass') &&
                        (!headBlock || headBlock.name === 'air')) {
                        // This direction looks walkable - try to walk out
                        log('digToSurface', `Found exit direction: x=${wallDir.x}, z=${wallDir.z}`);
                        const exitTarget = pos.offset(wallDir.x * 5, 0, wallDir.z * 5);
                        await this.bot.lookAt(exitTarget);
                        
                        this.bot.setControlState('forward', true);
                        this.bot.setControlState('jump', true);
                        await this.wait(1000);
                        this.bot.setControlState('forward', false);
                        this.bot.setControlState('jump', false);
                        
                        foundExit = true;
                        break;
                    }
                }
                
                if (!foundExit) {
                    // Walls on all sides - need to pillar up or break wall
                    log('digToSurface', 'Trapped in pit with walls - breaking out');
                    
                    // Find lowest wall and break it
                    for (const wallDir of wallDirs) {
                        const wallBlock = this.bot.blockAt(pos.offset(wallDir.x, 0, wallDir.z));
                        if (wallBlock && wallBlock.name !== 'air' && wallBlock.name !== 'bedrock') {
                            try {
                                if (this.bot.canDigBlock(wallBlock)) {
                                    await this.equipBestToolForBlock(wallBlock);
                                    await this.bot.dig(wallBlock);
                                    mined++;
                                    // Also break head level
                                    const headWall = this.bot.blockAt(pos.offset(wallDir.x, 1, wallDir.z));
                                    if (headWall && headWall.name !== 'air' && this.bot.canDigBlock(headWall)) {
                                        await this.equipBestToolForBlock(headWall);
                                        await this.bot.dig(headWall);
                                        mined++;
                                    }
                                    // Walk out
                                    this.bot.setControlState('forward', true);
                                    await this.wait(500);
                                    this.bot.setControlState('forward', false);
                                    break;
                                }
                            } catch (e) {}
                        }
                    }
                }
                
                // Check if we actually got out
                if (this.bot.entity.position.y > startY + 2) {
                    log('digToSurface', 'Climbed out of pit!');
                    break;
                }
                
                stuckCount++;
                if (stuckCount >= 5) {
                    log('digToSurface', 'Cannot escape pit - giving up');
                    break;
                }
                continue;
            }
            
            // STAIRCASE PATTERN:
            // 1. Mine the block in front at feet level (creates step)
            // 2. Mine the block in front at head level (headroom)  
            // 3. Mine the block in front above head (more headroom)
            // 4. Walk forward and jump onto the step
            
            // Block in front at feet level (Y+0) - this becomes our step UP
            const stepBlock = this.bot.blockAt(pos.offset(dir.x, 0, dir.z));
            if (stepBlock && stepBlock.name !== 'air' && stepBlock.name !== 'water' && stepBlock.name !== 'bedrock' && !this.hasLiquidNeighbor(stepBlock.position)) {
                try {
                    if (this.bot.canDigBlock(stepBlock)) {
                        await this.equipBestToolForBlock(stepBlock);
                        await this.bot.dig(stepBlock);
                        mined++;
                    }
                } catch (e) {}
            }
            
            // Block in front at head level (Y+1)
            const headBlock = this.bot.blockAt(pos.offset(dir.x, 1, dir.z));
            if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'water' && headBlock.name !== 'bedrock' && !this.hasLiquidNeighbor(headBlock.position)) {
                try {
                    if (this.bot.canDigBlock(headBlock)) {
                        await this.equipBestToolForBlock(headBlock);
                        await this.bot.dig(headBlock);
                        mined++;
                    }
                } catch (e) {}
            }
            
            // Block in front above head (Y+2) - need this for walking up
            const aboveBlock = this.bot.blockAt(pos.offset(dir.x, 2, dir.z));
            if (aboveBlock && aboveBlock.name !== 'air' && aboveBlock.name !== 'water' && aboveBlock.name !== 'bedrock' && !this.hasLiquidNeighbor(aboveBlock.position)) {
                try {
                    if (this.bot.canDigBlock(aboveBlock)) {
                        await this.equipBestToolForBlock(aboveBlock);
                        await this.bot.dig(aboveBlock);
                        mined++;
                    }
                } catch (e) {}
            }
            
            // Also mine directly above us (Y+1, Y+2) to make room
            const myHeadBlock = this.bot.blockAt(pos.offset(0, 1, 0));
            if (myHeadBlock && myHeadBlock.name !== 'air' && myHeadBlock.name !== 'water' && myHeadBlock.name !== 'bedrock' && !this.hasLiquidNeighbor(myHeadBlock.position)) {
                try {
                    if (this.bot.canDigBlock(myHeadBlock)) {
                        await this.equipBestToolForBlock(myHeadBlock);
                        await this.bot.dig(myHeadBlock);
                        mined++;
                    }
                } catch (e) {}
            }
            
            const myAboveBlock = this.bot.blockAt(pos.offset(0, 2, 0));
            if (myAboveBlock && myAboveBlock.name !== 'air' && myAboveBlock.name !== 'water' && myAboveBlock.name !== 'bedrock') {
                try {
                    if (this.bot.canDigBlock(myAboveBlock)) {
                        await this.equipBestToolForBlock(myAboveBlock);
                        await this.bot.dig(myAboveBlock);
                        mined++;
                    }
                } catch (e) {}
            }
            
            // Look in the direction we want to go
            const lookTarget = pos.offset(dir.x * 3, 1, dir.z * 3);
            await this.bot.lookAt(lookTarget);
            
            // Now walk forward - we should step up onto the block behind where we mined
            this.bot.setControlState('forward', true);
            await this.wait(400);
            this.bot.setControlState('forward', false);
            await this.wait(100);
            
            // Check progress
            const currentY = this.bot.entity.position.y;
            if (currentY <= lastY + 0.3) {
                stuckCount++;
                log('digToSurface', `Stuck at Y=${currentY.toFixed(1)}, attempt ${stuckCount}`);
                
                // Try jumping
                this.bot.setControlState('jump', true);
                this.bot.setControlState('forward', true);
                await this.wait(300);
                this.bot.setControlState('jump', false);
                this.bot.setControlState('forward', false);
                
                if (stuckCount >= 4) {
                    // Change direction
                    const dirs = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];
                    dir = dirs[stuckCount % 4];
                    log('digToSurface', `Changing direction to x=${dir.x}, z=${dir.z}`);
                    if (stuckCount >= 8) stuckCount = 0;
                }
            } else {
                stuckCount = 0;
                lastY = currentY;
            }
            
            log('digToSurface', `Y=${this.bot.entity.position.y.toFixed(1)}, mined=${mined}`);
        }
        
        const endY = this.bot.entity.position.y;
        const rose = endY - startY;
        log('digToSurface', `Done: mined=${mined}, rose ${rose.toFixed(1)} blocks`);
        // Determine if still stuck
        const isStillStuck = rose < 2 && mined < 3;
        let hint;
        if (endY >= 64 && !isStillStuck) {
            hint = 'At surface! Use explore() to find resources.';
        } else if (isStillStuck && endY >= 62) {
            hint = 'In open pit but stuck. Try explore() or pillar_up() instead.';
        } else {
            hint = 'Still underground - try dig_to_surface again or pillar_up.';
        }
        
        return {
            success: mined > 0 || rose > 1,
            blocksMined: mined,
            startY: Math.floor(startY),
            endY: Math.floor(endY),
            rose: Math.floor(rose),
            hint: hint
        };
    }

    /**
     * Set current position as home
     */
    setHome() {
        this.homePosition = this.bot.entity.position.clone();
        return {
            success: true,
            home: {
                x: Math.floor(this.homePosition.x),
                y: Math.floor(this.homePosition.y),
                z: Math.floor(this.homePosition.z)
            }
        };
    }

    /**
     * Return to home position
     */
    async returnHome() {
        if (!this.homePosition) {
            throw new Error('No home position set. Use setHome first.');
        }

        await this.goToNear(this.homePosition.x, this.homePosition.y, this.homePosition.z, 2);

        return {
            success: true,
            position: {
                x: Math.floor(this.bot.entity.position.x),
                y: Math.floor(this.bot.entity.position.y),
                z: Math.floor(this.bot.entity.position.z)
            }
        };
    }

    // ==================== ACTION EXECUTOR ====================

    /**
     * Execute an action by name (for agent compatibility)
     * @param {string} actionName - Name of the action
     * @param {object} params - Action parameters
     */
    async executeAction(actionName, params = {}) {
        const startTime = Date.now();
        
        try {
            let result;
            
            switch (actionName) {
                // Sensing
                case 'get_status':
                case 'getStatus':
                    result = this.getStatus();
                    break;
                case 'get_inventory':
                case 'getInventory':
                    result = this.getInventory();
                    break;
                case 'scan_blocks':
                case 'scanBlocks':
                    result = this.scanBlocks(params.blockTypes || params.blockType, params.maxDistance, params.count);
                    break;
                case 'scan_entities':
                case 'scanEntities':
                    result = this.scanEntities(params.entityType, params.maxDistance);
                    break;
                case 'get_nearby_summary':
                case 'getNearbySummary':
                    result = this.getNearbySummary(params.range);
                    break;

                // Locomotion
                case 'go_to_near':
                case 'goToNear':
                case 'moveTo':
                case 'move_to':
                    result = await this.goToNear(params.x, params.y, params.z, params.range);
                    break;
                case 'explore':
                    result = await this.explore(params.distance);
                    break;
                case 'follow':
                    result = await this.follow(params.entity || params.entityName, params.range, params.duration);
                    break;

                // Manipulation
                case 'break_block':
                case 'breakBlock':
                case 'dig':
                    if (params.blockType || params.block) {
                        result = await this.breakBlock(params.blockType || params.block);
                    } else {
                        result = await this.breakBlock(params.x, params.y, params.z);
                    }
                    break;
                case 'break_around':
                case 'breakAround':
                case 'clear_path':
                case 'clearPath':
                    result = await this.breakAround(params.direction || 'all');
                    break;
                case 'place_block':
                case 'placeBlock':
                case 'place':
                    result = await this.placeBlock(params.blockName || params.block, params.x, params.y, params.z);
                    break;
                case 'equip':
                    result = await this.equip(params.item || params.itemName, params.destination);
                    break;
                case 'open_container':
                case 'openContainer':
                    result = await this.openContainer(params.x, params.y, params.z);
                    break;
                case 'transfer_items':
                case 'transferItems':
                    result = await this.transferItems(params.direction, params.item || params.itemName, params.count);
                    break;
                case 'close_container':
                case 'closeContainer':
                    result = await this.closeContainer();
                    break;
                case 'drop_item':
                case 'dropItem':
                case 'toss':
                    result = await this.dropItem(
                        params.item || params.itemName,
                        params.count,
                        params.freeSpace === true || ((params.item || params.itemName) + '').toLowerCase() === 'auto'
                    );
                    break;

                // Production
                case 'ensure_crafted':
                case 'ensureCrafted':
                case 'craft':
                    result = await this.ensureCrafted(params.item || params.itemName, params.count || 1);
                    break;
                case 'smelt':
                    result = await this.smelt(params.item || params.itemName, params.count || 1);
                    break;
                case 'mine':
                    result = await this.mine(params.blockType || params.block, params.count || 1);
                    break;
                case 'chop_tree':
                case 'chopTree':
                    result = await this.chopTree(params.count || 3);
                    break;
                case 'collect_food':
                case 'collectFood':
                    result = await this.collectFood(params.count || 1);
                    break;
                case 'collect':
                case 'collectNearbyItems':
                    result = await this.collectNearbyItems();
                    break;

                // Survival
                case 'eat':
                    result = await this.eat();
                    break;
                case 'sleep_if_possible':
                case 'sleepIfPossible':
                case 'sleep':
                    result = await this.sleepIfPossible();
                    break;
                case 'flee_from':
                case 'fleeFrom':
                case 'flee':
                    result = await this.fleeFrom(params.entity || params.entityType || params.target, params.distance);
                    break;
                case 'attack':
                    result = await this.attack(params.entity || params.entityType || params.target, params.chase);
                    break;
                case 'light_area':
                case 'lightArea':
                    result = await this.lightArea(params.radius);
                    break;
                case 'build_shelter':
                case 'buildShelter':
                    result = await this.buildShelter();
                    break;
                case 'dig_emergency_shelter':
                case 'digEmergencyShelter':
                    result = await this.digEmergencyShelter();
                    break;
                case 'swim_up':
                case 'swimUp':
                case 'surface':
                    result = await this.swimUp();
                    break;
                case 'pillar_up':
                case 'pillarUp':
                case 'pillar':
                case 'climb_out':
                    result = await this.pillarUp(params.height || params.blocks || 3);
                    break;
                case 'dig_to_surface':
                case 'digToSurface':
                case 'mine_up':
                case 'escape_pit':
                    result = await this.digToSurface();
                    break;
                case 'set_home':
                case 'setHome':
                    result = this.setHome();
                    break;
                case 'return_home':
                case 'returnHome':
                    result = await this.returnHome();
                    break;

                // Utility
                case 'wait':
                    await this.wait(params.ms || params.duration || (params.ticks ? params.ticks * 50 : 1000));
                    result = { success: true };
                    break;
                case 'stop':
                    this.stop();
                    result = { success: true };
                    break;
                case 'lookup':
                case 'web_lookup':
                case 'webLookup':
                case 'search':
                    result = await this.webLookup(params.query || params.item || params.topic);
                    break;
                case 'get_recipe':
                case 'getRecipe':
                    result = this.getRecipeInfo(params.item || params.itemName);
                    break;

                // LEGACY ACTION MAPPINGS (for backwards compatibility with old prompts)
                case 'gather':
                    // Map gather to appropriate action
                    if (params.resource === 'wood' || params.resource === 'log') {
                        result = await this.chopTree(params.amount || params.count || 3);
                    } else if (params.resource === 'stone' || params.resource === 'cobblestone') {
                        result = await this.mine('stone', params.amount || params.count || 1);
                    } else {
                        result = await this.mine(params.resource, params.amount || params.count || 1);
                    }
                    break;
                case 'hunt':
                    // Map hunt to attack + collect
                    const animal = params.animal || params.entity || 'cow';
                    const huntCount = params.count || params.amount || 1;
                    let huntResults = [];
                    for (let i = 0; i < huntCount; i++) {
                        try {
                            const attackResult = await this.attack(animal, true);
                            huntResults.push(attackResult);
                            if (attackResult.entityDead) {
                                await this.collectNearbyItems();
                            }
                        } catch (e) {
                            break;
                        }
                    }
                    result = { success: huntResults.length > 0, hunted: huntResults.length, animal };
                    break;
                case 'go_to':
                case 'goto':
                    result = await this.goToNear(params.x, params.y || 64, params.z, params.range || 2);
                    break;

                default:
                    throw new Error(`Unknown action: ${actionName}`);
            }
            
            const effectiveSuccess = result && typeof result.success === 'boolean' ? result.success : true;
            const actionResult = {
                action: actionName,
                params: params,
                success: effectiveSuccess,
                result: result,
                duration: Date.now() - startTime
            };
            
            this.actionHistory.push(actionResult);
            return actionResult;
            
        } catch (error) {
            const actionResult = {
                action: actionName,
                params: params,
                success: false,
                error: error.message,
                duration: Date.now() - startTime
            };
            
            this.actionHistory.push(actionResult);
            return actionResult;
        }
    }

    /**
     * Get action history
     */
    getActionHistory(count = 10) {
        return this.actionHistory.slice(-count);
    }

    /**
     * Clear action history
     */
    clearActionHistory() {
        this.actionHistory = [];
    }
}

module.exports = Actions;
