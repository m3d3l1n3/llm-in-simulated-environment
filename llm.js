/**
 * LLM Interface (Section 3.1)
 * Provides unified interface for different LLM providers
 * 
 * Supports:
 * - OpenAI (GPT-3.5, GPT-4)
 * - Anthropic (Claude)
 * - Local models (via API)
 * 
 * Features:
 * - Prompt control
 * - Temperature control
 * - Deterministic logging of outputs
 */

class LLMInterface {
    constructor(config = {}) {
        this.config = {
            provider: config.provider || 'none',
            model: config.model || 'gpt-4',
            temperature: config.temperature || 0.7,
            maxTokens: config.maxTokens || 500,
            tokenBudget: config.tokenBudget || 1000000,
            apiKey: config.apiKey || (config.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY),
            baseURL: config.baseURL || null,
            timeout: config.timeout || 30000,
            ...config
        };

        this.requestCount = 0;
        this.totalTokens = 0;
        this.logger = null;
        this.consecutiveFailures = 0;
        this.staticSystemPrompt = this.buildSystemPrompt();
        this.compactMode = false;

        // Initialize provider
        this.initializeProvider();
    }

    /**
     * Initialize the LLM provider
     */
    initializeProvider() {
        switch (this.config.provider) {
            case 'openai':
                this.validateOpenAI();
                break;
            case 'anthropic':
                this.validateAnthropic();
                break;
            case 'local':
                this.validateLocal();
                break;
            case 'none':
                // Rule-based fallback
                break;
            default:
                throw new Error(`Unknown LLM provider: ${this.config.provider}`);
        }
    }

    validateOpenAI() {
        if (!this.config.apiKey) {
            throw new Error('OpenAI API key required. Set OPENAI_API_KEY environment variable or pass apiKey in config.');
        }
    }

    validateAnthropic() {
        if (!this.config.apiKey) {
            throw new Error('Anthropic API key required. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.');
        }
    }

    validateLocal() {
        if (!this.config.baseURL) {
            throw new Error('Local model requires baseURL in config.');
        }
    }

    /**
     * Set logger for LLM I/O logging
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * Generate a decision based on observation
     * @param {Object} observation - Current game state
     * @param {Object} context - Additional context (memory, recent actions, etc.)
     * @returns {Promise<Object>} Decision with goal, reasoning, and actions
     */
    async generateDecision(observation, context = {}) {
        const startTime = Date.now();
        this.requestCount++;

        // Build prompt
        const prompt = this.buildTurnPrompt(observation, context);

        // Log request
        const requestLog = {
            requestId: this.requestCount,
            timestamp: Date.now(),
            provider: this.config.provider,
            model: this.config.model,
            temperature: this.config.temperature,
            prompt: prompt,
            promptLength: prompt.length
        };

        let response;
        let decision;
        let lastError = null;
        const maxRetries = 3;
        const isRetryable = (err) => /overloaded|rate.limit|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|503|502|429/i.test(err.message);

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                    console.log(`⏳ Retry ${attempt}/${maxRetries} after ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                // Call LLM
                console.log(`📤 Sending prompt to ${this.config.provider}/${this.config.model} (${prompt.length} chars)...`);
                response = await this.callLLM(prompt);
                console.log(`📥 Response received (${response.content?.length || 0} chars)`);

                // Parse response
                decision = this.parseResponse(response);

                // Log successful response
                requestLog.success = true;
                requestLog.response = response;
                requestLog.decision = decision;
                requestLog.tokensUsed = response.tokensUsed || null;
                requestLog.duration = Date.now() - startTime;
                requestLog.retries = attempt;
                this.consecutiveFailures = 0;

                if (response.tokensUsed) {
                    this.totalTokens += response.tokensUsed;
                    if (this.totalTokens > this.config.tokenBudget * 0.85) {
                        this.compactMode = true;
                    } else if (this.compactMode && this.totalTokens < this.config.tokenBudget * 0.60) {
                        this.compactMode = false;
                    }
                    if (this.totalTokens > this.config.tokenBudget) {
                        requestLog.tokenBudgetExceeded = true;
                    }
                }

                lastError = null;
                break; // Success — exit retry loop

            } catch (error) {
                lastError = error;
                requestLog.error = error.message;
                if (!isRetryable(error) || attempt >= maxRetries) {
                    break; // Non-retryable or exhausted retries
                }
                console.warn(`⚠️  LLM call attempt ${attempt + 1} failed: ${error.message}`);
            }
        }

        if (lastError) {
            // Log failed response
            requestLog.success = false;
            requestLog.duration = Date.now() - startTime;

            // Use fallback
            console.warn(`⚠️  LLM call failed: ${lastError.message}`);
            this.consecutiveFailures++;
            decision = this.fallbackDecision(observation, context);
        }

        // Log to dedicated llm_requests.jsonl (not events.json, to avoid bloating the R-M-W file)
        if (this.logger) {
            this.logger.logLLMRequest(requestLog);
        }

        return decision;
    }

    buildSystemPrompt() {
        const base = this.config.systemPrompt || 'You are an autonomous Minecraft survival AI.';
        return `${base}

You must always return valid JSON:
{
  "goal": "short goal",
  "reasoning": "short reasoning",
  "actions": [
    { "name": "action_name", "params": {} }
  ]
}

Rules:
- Keep actions to 1-3 per response.
- Prioritize survival first (drowning, low health, nearby hostiles, night safety).
- Avoid repeating failing actions; choose a different strategy after repeated failures.
- Follow progression: wood -> crafting_table -> wooden tools -> stone tools -> iron tools.
- If stuck in a pit/cave, prioritize escaping (dig_to_surface or pillar_up) before gathering.
- If low food and no food inventory, hunt animals before mining/crafting.
`;
    }

    buildPriorityAlerts(observation, context) {
        const alerts = [];
        const player = observation.player || {};
        const env = observation.environment || {};
        const entities = observation.entities || {};
        const inventory = observation.inventory || { slots: [] };

        const hasFood = (inventory.slots || []).some(i =>
            i.name.includes('beef') || i.name.includes('pork') || i.name.includes('chicken') ||
            i.name.includes('mutton') || i.name.includes('bread') || i.name.includes('cooked') ||
            i.name.includes('apple') || i.name.includes('carrot') || i.name.includes('potato')
        );

        const oxygenLevel = player.oxygen ?? 20;
        if (player.isInWater === true && oxygenLevel < 10) {
            alerts.push({ key: 'drowning', text: `DROWNING: oxygen ${oxygenLevel}/20. Use swim_up NOW. Nothing else matters until you surface.` });
        }
        if ((player.position?.y ?? 64) < 60) alerts.push({ key: 'underground', text: `Underground at Y=${Math.floor(player.position.y)}. Escape to surface first.` });

        const hostileNames = [
            'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'drowned',
            'pillager', 'vindicator', 'ravager', 'evoker', 'vex', 'phantom',
            'husk', 'stray', 'blaze', 'enderman', 'slime', 'warden',
            'piglin_brute', 'hoglin', 'zoglin', 'ghast', 'magma_cube', 'wither_skeleton'
        ];
        const nearbyHostiles = (entities.mobs || []).filter(m => hostileNames.includes(m.name) && m.distance < 16);
        if (nearbyHostiles.length > 0) {
            const closest = nearbyHostiles.reduce((a, b) => a.distance < b.distance ? a : b);
            const threat = nearbyHostiles.length > 1
                ? `${nearbyHostiles.length} hostiles nearby (closest: ${closest.name} at ${Math.floor(closest.distance)}m)`
                : `${closest.name} nearby (${Math.floor(closest.distance)}m)`;
            const urgency = closest.distance < 6 ? 'FLEE or fight NOW!' : 'Stay alert, avoid approaching.';
            alerts.push({ key: 'hostile_mob', text: `${threat}. ${urgency}` });
        }

        // Health alert
        const healthFoods = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
            'cooked_cod', 'cooked_salmon', 'bread', 'apple', 'golden_apple', 'golden_carrot', 'melon_slice',
            'sweet_berries', 'baked_potato', 'cookie', 'dried_kelp', 'rotten_flesh', 'carrot', 'potato', 'beetroot'];
        const hasEdibleFood = (inventory.slots || []).some(i => healthFoods.includes(i.name));
        const healthVal = player.health ?? 20;
        if (healthVal < 14) {
            if (hasEdibleFood) {
                alerts.push({ key: 'low_health', text: `LOW HEALTH (${Math.floor(healthVal)}/20). EAT NOW: { "name": "eat", "params": {} }` });
            } else if (healthVal <= 4) {
                alerts.push({ key: 'low_health', text: `CRITICAL HEALTH (${Math.floor(healthVal)}/20) and NO FOOD. Hunting will likely kill you — consider dig_emergency_shelter() or flee_from first, then hunt when safer.` });
            } else {
                alerts.push({ key: 'low_health', text: `LOW HEALTH (${Math.floor(healthVal)}/20) and NO FOOD. Hunt animals: attack({entity:"cow"}) then eat.` });
            }
        }

        const recentActions = context.recentActions || [];
        const pathFailure = (a) => {
            const err = (a.error || '').toLowerCase();
            return err.includes('no path') || err.includes('failed to reach') || err.includes('no accessible');
        };
        const pathFailures = recentActions.filter(a => !a.success && pathFailure(a));
        const blockAbove = (env.verticalProfile?.above?.[0] || '').toLowerCase();
        const isConfined = blockAbove && blockAbove !== 'air' && blockAbove !== 'unknown' && !blockAbove.includes('leaves');
        if (pathFailures.length >= 1 || isConfined) {
            if (isConfined || (player.position?.y ?? 64) < 62) {
                alerts.push({ key: 'trapped', text: 'TRAPPED or NO PATH. Escape first: break_around(direction:"escape") to clear path WITHOUT digging down, then dig_to_surface or pillar_up, then explore. Do NOT use direction "all" (it digs down).' });
            } else {
                // Name the specific action+target that failed so the model knows exactly what to avoid.
                const lastFail = pathFailures[pathFailures.length - 1];
                const failedDesc = lastFail
                    ? ` Last failed: ${lastFail.action}(${Object.entries(lastFail.params || {}).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(', ')}) — do NOT repeat it.`
                    : '';
                alerts.push({ key: 'path_fail', text: `Path failed last time.${failedDesc} Try a different action or target (e.g. mine({blockType:"stone"}) instead of an unreachable ore, or explore(distance:20)).` });
            }
        }
        const failed = recentActions.filter(a => !a.success).length;
        if (failed >= 4) alerts.push({ key: 'stuck', text: `${failed}/5 recent actions failed. Change strategy and unstick first.` });
        if ((env.timeOfDay > 12000 || env.timeOfDay < 1000) && (player.position?.y ?? 64) >= 62) {
            const standingOn = (player.standingOn || '').toLowerCase();
            if (standingOn.includes('leaves')) {
                alerts.push({ key: 'night', text: 'Night time but you are in a tree on ' + player.standingOn + '. Do NOT dig down — you will fall. Wait or descend carefully to solid ground.' });
            } else {
                const hasBuildingMaterials = (inventory.slots || []).some(i =>
                    i.name === 'dirt' || i.name === 'cobblestone' || (i.name && i.name.includes('planks'))
                );
                const nightText = hasBuildingMaterials
                    ? 'Night on surface. Build shelter or dig emergency shelter.'
                    : 'Night on surface and NO building materials! Use dig_emergency_shelter NOW to dig a hole and hide from mobs.';
                alerts.push({ key: 'night', text: nightText });
            }
        }
        if ((player.food ?? 20) < 10) {
            alerts.push({ key: 'food', text: hasFood ? 'Low food. Eat now.' : 'Low food and no food inventory. Hunt animals now.' });
        }
        const emptySlots = inventory.emptySlots ?? 99;
        if (emptySlots <= 2) {
            alerts.push({ key: 'inventory_full', text: 'INVENTORY FULL. Do NOT gather more. Free space: drop_item({item:"auto"}) to drop least valuable stack (keeps tools, food, table); or craft furnace/chest; or explore without mining/chopping.' });
        }

        const priority = ['drowning', 'underground', 'trapped', 'path_fail', 'stuck', 'hostile_mob', 'low_health', 'night', 'food', 'inventory_full'];
        return alerts
            .sort((a, b) => priority.indexOf(a.key) - priority.indexOf(b.key))
            .slice(0, 2)
            .map(a => a.text);
    }

    computeNextStep(observation, strategic) {
        const inv = observation?.inventory?.slots || [];
        const has = (name) => inv.some(i => i.name === name);
        const hasAny = (needle) => inv.some(i => i.name && i.name.includes(needle));
        const countLike = (needle) => inv.filter(i => i.name && i.name.includes(needle)).reduce((s, i) => s + i.count, 0);
        const countEq = (name) => inv.filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
        const player = observation?.player || {};
        const health = player.health ?? 20;
        const food = player.food ?? 20;
        const time = observation?.environment?.timeOfDay ?? 6000;
        const isNight = time > 12000 || time < 1000;

        const foodItems = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread', 'apple',
            'golden_apple', 'golden_carrot', 'melon_slice', 'sweet_berries', 'baked_potato', 'cookie',
            'dried_kelp', 'rotten_flesh', 'spider_eye', 'carrot', 'potato', 'beetroot'];
        const hasFood = inv.some(i => foodItems.includes(i.name));

        if (health < 14 && hasFood) {
            return `EAT NOW - health is ${Math.floor(health)}/20: { "name": "eat", "params": {} }`;
        }

        if (isNight && (player.position?.y ?? 64) >= 62) {
            const standingOn = (observation?.player?.standingOn || '').toLowerCase();
            if (standingOn.includes('leaves')) {
                return `You are in a tree on ${observation.player.standingOn}. It's night — do NOT dig down. Wait or break leaves to find solid ground first.`;
            }
            if (hasAny('_bed')) return `Place your bed and SLEEP: { "name": "sleep_if_possible", "params": {} }`;
            const placeableCount = inv.filter(i => i.name && (i.name.includes('planks') || i.name === 'dirt' || i.name === 'cobblestone')).reduce((s, i) => s + i.count, 0);
            if (placeableCount >= 8) return `BUILD SHELTER - it's night! { "name": "build_shelter", "params": {} }`;
            return `DIG EMERGENCY SHELTER - it's night! { "name": "dig_emergency_shelter", "params": {} }`;
        }

        if (food < 10 && hasFood) {
            return `EAT - food is low (${food}/20): { "name": "eat", "params": {} }`;
        }

        const tier = strategic?.currentTier || 'naked';
        const missing = strategic?.missing || [];
        const logCount = countLike('_log');
        const plankCount = countLike('_planks');
        const stickCount = countEq('stick');
        const cobbleCount = countEq('cobblestone');
        const hasPickaxe = hasAny('pickaxe');
        const hasStonePickaxe = has('stone_pickaxe');
        const hasCraftingTable = has('crafting_table') || !!observation?.environment?.nearbyCraftingTable;

        if (tier === 'naked') {
            if (logCount < 3) return `Chop trees for wood: { "name": "chop_tree", "params": { "count": 3 } }`;
            if (plankCount < 4) return `Craft planks from logs: { "name": "craft", "params": { "item": "planks", "count": 4 } }`;
            if (stickCount < 4) return `Craft sticks: { "name": "craft", "params": { "item": "stick", "count": 4 } }`;
            if (!hasCraftingTable) return `Craft a crafting table: { "name": "craft", "params": { "item": "crafting_table" } }`;
            if (!has('wooden_pickaxe')) return `Craft wooden pickaxe: { "name": "craft", "params": { "item": "wooden_pickaxe" } }`;
            return `Mine stone for cobblestone: { "name": "mine", "params": { "blockType": "stone", "count": 10 } }`;
        }

        if (tier === 'wood_tools') {
            if (cobbleCount < 8) return `Mine stone NOW - you have tools: { "name": "mine", "params": { "blockType": "stone", "count": 10 } }`;
            if (!hasStonePickaxe) return `Craft stone pickaxe: { "name": "craft", "params": { "item": "stone_pickaxe" } }`;
            if (!has('stone_axe')) return `Craft stone axe: { "name": "craft", "params": { "item": "stone_axe" } }`;
            return `Mine stone for more tools: { "name": "mine", "params": { "blockType": "stone", "count": 10 } }`;
        }

        if (tier === 'stone_tools') {
            const woolItem = inv.find(i => i.name && i.name.includes('wool'));
            const woolColor = woolItem ? woolItem.name.replace('_wool', '') : 'white';
            const bedName = `${woolColor}_bed`;
            const woolCount = countLike('wool');
            if (woolCount >= 3 && plankCount >= 3) return `Craft a bed: { "name": "craft", "params": { "item": "${bedName}" } }`;
            if (food < 14) {
                const sheep = (observation.entities?.mobs || []).find(m => m.name === 'sheep');
                if (sheep) return `Kill sheep for wool + food: { "name": "attack", "params": { "entity": "sheep" } }`;
                const animals = (observation.entities?.mobs || []).find(m => ['cow', 'pig', 'chicken'].includes(m.name));
                if (animals) return `Hunt ${animals.name} for food: { "name": "attack", "params": { "entity": "${animals.name}" } }`;
            }
            if (!has('furnace') && cobbleCount >= 8) return `Craft furnace: { "name": "craft", "params": { "item": "furnace" } }`;
            return `Explore for animals/resources: { "name": "explore", "params": { "distance": 30 } }`;
        }

        return `Explore and gather resources: { "name": "explore", "params": { "distance": 30 } }`;
    }

    buildTurnPrompt(observation, context = {}) {
        const safeObservation = observation || {};
        const { player = {}, inventory = { slots: [] }, entities = {}, environment = {} } = safeObservation;
        const alerts = this.buildPriorityAlerts(safeObservation, context);
        const strategic = context.strategicContext || {};
        const mem = context.memorySummary || {};

        const inventoryLine = (inventory.slots || [])
            .slice(0, this.compactMode ? 8 : 14)
            .map(i => `${i.name}x${i.count}`)
            .join(', ') || 'empty';
        const mobsLine = (entities.mobs || []).slice(0, this.compactMode ? 4 : 6).map(m => `${m.name}@${Math.floor(m.distance)}m`).join(', ') || 'none';
        const resourceLine = safeObservation.blocks?.summary ||
            Object.entries(safeObservation.blocks?.resources || {}).filter(([, v]) => v.found).slice(0, this.compactMode ? 4 : 8)
                .map(([k, v]) => `${k}@${v.distance}m`).join(', ') || 'none';

        const emptySlots = inventory.emptySlots ?? 99;
        const fullNote = emptySlots <= 2 ? ' (FULL - do not gather more; craft or explore)' : '';
        const hasTableInInv = (inventory.slots || []).some(i => i && i.name === 'crafting_table');
        const nearbyTable = environment.nearbyCraftingTable;
        const craftingTableLine = hasTableInInv
            ? 'in inventory'
            : (nearbyTable ? `placed nearby ${nearbyTable.distance}m (DO NOT craft again; use for tools)` : 'none');
        const autonomousMode = this.config.autonomousMode === true;
        const nextStep = autonomousMode ? null : this.computeNextStep(observation, strategic);
        const nextStepSection = autonomousMode
            ? ''
            : `\nNEXT STEP (do this NOW unless a PRIORITY_ALERT overrides):\n${nextStep}\n`;

        // Build blocked actions with reasons
        const blockedActions = context.blockedActions || [];
        const blockedWithReasons = blockedActions.map(name => {
            const recentFails = (context.recentActions || []).filter(a => a.action === name && !a.success);
            const reason = recentFails.length > 0 ? recentFails[recentFails.length - 1].error || 'repeated failures' : 'repeated failures';
            return `${name} (${reason})`;
        });
        const blockedLine = blockedWithReasons.length > 0
            ? `\nBLOCKED (do NOT use these this turn): ${blockedWithReasons.join(', ')}\n`
            : '';

        // Recent actions with error details
        const recentActions = (context.recentActions || []).slice(-5);
        const recentActionsLine = recentActions.length > 0
            ? recentActions.map(a => {
                let status = a.success ? 'OK' : 'FAILED';
                let detail = a.error ? ` — ${a.error}` : '';
                // If a guard interrupted the action for safety, tell the LLM explicitly
                // so it doesn't think the action itself failed mechanically.
                if (a.interrupted) {
                    status = 'INTERRUPTED';
                    detail = a.interruptReason ? ` — safety override (${a.interruptReason})` : ' — safety override';
                }
                return `- ${a.action}: ${status}${detail}`;
            }).join('\n')
            : 'none';

        // Previous strategy feedback loop
        const goalHistory = context.goalHistory || [];
        const prevStrategyLine = goalHistory.length > 0
            ? goalHistory.slice(-2).map(g => {
                const guardTag = g.isGuard ? '[GUARD OVERRIDE] ' : '';
                return `- ${guardTag}Goal: "${g.goal}" | Reasoning: "${g.reasoning}"`;
            }).join('\n')
            : 'none';

        const closingInstruction = autonomousMode
            ? 'Choose 1-3 concrete actions based on your own reasoning.\nRespond with valid JSON only.'
            : 'Choose 1-3 concrete actions. Follow the NEXT STEP unless an alert overrides it.\nRespond with valid JSON only.';

        const playerY = player.position?.y ?? 64;
        const yLevel = typeof playerY === 'number' ? playerY.toFixed(1) : String(playerY);
        const yZone = playerY >= 60 ? 'surface' : playerY >= 0 ? `underground (ores Y${Math.floor(playerY)})` : 'bedrock';
        const lightInfo = environment.lightLevel;
        const lightLine = lightInfo
            ? `${lightInfo.effective ?? '?'}/15${lightInfo.mobSpawnRisk ? ' ⚠ MOBS CAN SPAWN HERE' : ' (safe)'}`
            : 'unknown';
        const durInfo = inventory.equippedToolDurability;
        const durLine = durInfo
            ? `${durInfo.item ?? 'tool'} ${durInfo.pct ?? 0}% (${durInfo.remaining ?? 0}/${durInfo.max ?? 0})`
            : 'no tool';

        return `STATE
- Position: (${player.position?.x?.toFixed(1) ?? '?'}, ${yLevel}, ${player.position?.z?.toFixed(1) ?? '?'}) [Y: ${yZone}]
- Standing on: ${player.standingOn || 'unknown'}
- Health/Food/Oxygen: ${Math.floor(player.health ?? 20)}/20, ${player.food ?? 20}/20, ${player.oxygen ?? 20}/20
- Time: ${environment.timeOfDay ?? 0} (${this.getTimeDescription(environment.timeOfDay ?? 0)})
- Weather: ${environment.isRaining ? 'rain' : 'clear'}
- Light level: ${lightLine}
- Held tool durability: ${durLine}
- Crafting table: ${craftingTableLine}
- Empty slots: ${emptySlots}${fullNote}
- Inventory: ${inventoryLine}
- Nearby mobs: ${mobsLine}
- Nearby resources: ${resourceLine}

STRATEGY
- Current tier: ${strategic.currentTier || 'unknown'}
- Next milestone: ${strategic.nextMilestone || 'unknown'}
- Missing for milestone: ${(strategic.missing || []).join(', ') || 'none'}
${(context.loopCount != null && context.escapeCooldownUntilLoop != null && context.loopCount <= context.escapeCooldownUntilLoop) ? '- Just escaped: resume your previous goal (e.g. gather wood, explore).\n' : ''}${nextStepSection}
MEMORY
- Recent summary: ${mem.recentSummary || 'none'}
- Achievements: ${(mem.achievements || []).join(', ') || 'none'}
- Known locations: ${(mem.knownLocations || []).join(', ') || 'none'}
- Last death context: ${mem.deathContext ? this.formatDeathContext(mem.deathContext) : 'none'}

PREVIOUS STRATEGY (your last 2 goals)
${prevStrategyLine}

RECENT ACTIONS (last 5)
${recentActionsLine}

PRIORITY_ALERTS
${alerts.length ? alerts.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'none'}
${blockedLine}
AVAILABLE ACTIONS
chop_tree, mine, craft, attack, eat, explore, flee_from, swim_up, dig_to_surface, build_shelter, dig_emergency_shelter, sleep_if_possible, pillar_up, break_around, light_area, go_to_near, equip, drop_item, collect_food

${closingInstruction}`;
    }

    formatDeathContext(dc) {
        if (!dc) return 'none';
        const pos = dc.position ? `(${dc.position.x}, ${dc.position.y}, ${dc.position.z})` : 'unknown';
        return `Died at ${pos} from ${dc.causeHint || 'unknown'}. ${dc.inWater ? 'Was drowning.' : ''}`;
    }

    getTimeDescription(timeOfDay) {
        if (timeOfDay < 1000) return 'dawn';
        if (timeOfDay < 6000) return 'day';
        if (timeOfDay < 12000) return 'noon';
        if (timeOfDay < 13000) return 'afternoon';
        if (timeOfDay < 18000) return 'dusk';
        return 'night';
    }

    /**
     * Call the LLM API
     */
    async callLLM(prompt) {
        switch (this.config.provider) {
            case 'openai':
                return await this.callOpenAI(prompt);
            case 'anthropic':
                return await this.callAnthropic(prompt);
            case 'local':
                return await this.callLocal(prompt);
            case 'none':
                throw new Error('LLM provider is "none" - using fallback');
            default:
                throw new Error(`Unsupported provider: ${this.config.provider}`);
        }
    }

    /**
     * Call OpenAI API
     */
    async callOpenAI(prompt) {
        const https = require('https');
        
        const requestBody = {
            model: this.config.model,
            messages: [
                { role: 'system', content: this.staticSystemPrompt },
                { role: 'user', content: prompt }
            ],
            temperature: this.config.temperature !== undefined ? this.config.temperature : 0.7,
            max_tokens: this.config.maxTokens || 500
        };
        
        const data = JSON.stringify(requestBody);
        
        // Validate JSON
        try {
            JSON.parse(data);
        } catch (e) {
            console.error('❌ Invalid JSON in request:', e.message);
            throw new Error(`Failed to create valid JSON: ${e.message}`);
        }

        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: this.config.timeout
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const json = JSON.parse(responseData);
                        
                        if (json.error) {
                            reject(new Error(json.error.message || 'OpenAI API error'));
                            return;
                        }

                        const content = json.choices[0].message.content;
                        const tokensUsed = json.usage?.total_tokens || 0;

                        resolve({
                            content: content,
                            tokensUsed: tokensUsed,
                            raw: json
                        });
                    } catch (error) {
                        reject(new Error(`Failed to parse OpenAI response: ${error.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`OpenAI request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('OpenAI request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Call Anthropic API
     */
    async callAnthropic(prompt) {
        const https = require('https');
        
        const data = JSON.stringify({
            model: this.config.model,
            system: this.staticSystemPrompt,
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens
        });

        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(data, 'utf8')
            },
            timeout: this.config.timeout
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const json = JSON.parse(responseData);
                        
                        if (json.error) {
                            console.error('Anthropic API Error:', JSON.stringify(json.error, null, 2));
                            reject(new Error(json.error.message || `Anthropic API error: ${JSON.stringify(json.error)}`));
                            return;
                        }
                        
                        if (!json.content || !json.content[0]) {
                            console.error('Unexpected Anthropic response:', responseData.substring(0, 500));
                            reject(new Error('No content in Anthropic response'));
                            return;
                        }

                        const content = json.content[0].text;
                        // Anthropic uses input_tokens + output_tokens
                        const tokensUsed = (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0);

                        resolve({
                            content: content,
                            tokensUsed: tokensUsed,
                            raw: json
                        });
                    } catch (error) {
                        reject(new Error(`Failed to parse Anthropic response: ${error.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Anthropic request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Anthropic request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Call local LLM API (compatible with OpenAI format)
     */
    async callLocal(prompt) {
        const url = new URL(this.config.baseURL);
        const transport = url.protocol === 'https:' ? require('https') : require('http');

        const data = JSON.stringify({
            model: this.config.model,
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens
        });

        const defaultPort = url.protocol === 'https:' ? 443 : 80;
        const apiPath = url.pathname.endsWith('/v1/chat/completions')
            ? url.pathname
            : url.pathname + '/v1/chat/completions';

        const options = {
            hostname: url.hostname,
            port: url.port || defaultPort,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data, 'utf8')
            },
            timeout: this.config.timeout
        };

        return new Promise((resolve, reject) => {
            const req = transport.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const json = JSON.parse(responseData);
                        const content = json.choices[0].message.content;
                        const tokensUsed = json.usage?.total_tokens || 0;

                        resolve({
                            content: content,
                            tokensUsed: tokensUsed,
                            raw: json
                        });
                    } catch (error) {
                        reject(new Error(`Failed to parse local LLM response: ${error.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Local LLM request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Local LLM request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Parse LLM response into decision structure
     */
    parseResponse(response) {
        try {
            let content = response.content.trim();

            // Remove markdown code blocks
            content = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');

            // Try to extract a valid decision JSON object from the content.
            // We scan through all balanced JSON objects and pick the first one
            // that has the required decision structure (goal + reasoning + actions).
            const candidates = this.extractJsonObjects(content);

            for (const jsonStr of candidates) {
                // Strip trailing commas before closing braces/brackets
                const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1');
                let decision;
                try {
                    decision = JSON.parse(cleaned);
                } catch {
                    continue; // unparseable, try next candidate
                }

                // Validate structure
                if (!decision.goal || !decision.reasoning || !decision.actions) {
                    continue; // wrong shape, try next candidate
                }
                if (!Array.isArray(decision.actions)) {
                    continue;
                }

                // Validate action names against known whitelist (warn but don't block)
                const knownActions = new Set([
                    'chop_tree', 'chopTree', 'mine', 'craft', 'attack', 'eat', 'explore',
                    'flee_from', 'fleeFrom', 'swim_up', 'swimUp', 'dig_to_surface', 'digToSurface',
                    'build_shelter', 'buildShelter', 'dig_emergency_shelter', 'digEmergencyShelter',
                    'sleep_if_possible', 'sleepIfPossible', 'pillar_up', 'pillarUp', 'break_around',
                    'breakAround', 'clear_path', 'clearPath', 'light_area', 'lightArea',
                    'go_to_near', 'goToNear', 'move_to', 'moveTo', 'equip', 'drop_item', 'dropItem',
                    'collect_food', 'collectFood', 'get_recipe', 'getRecipe', 'lookup', 'wait',
                    'place_block', 'placeBlock', 'set_home', 'setHome', 'return_home', 'returnHome',
                    'break_block', 'breakBlock', 'smelt', 'ensure_crafted', 'ensureCrafted'
                ]);
                for (const action of decision.actions) {
                    if (action.name && !knownActions.has(action.name)) {
                        console.warn(`⚠️  LLM emitted unknown action: "${action.name}"`);
                    }
                }

                return decision;
            }

            throw new Error('No valid decision JSON found in response');
        } catch (error) {
            console.warn(`⚠️  Failed to parse LLM response: ${error.message}`);
            console.warn('Response:', response.content);
            throw error;
        }
    }

    extractJsonObjects(content) {
        const objects = [];
        let idx = 0;
        while (true) {
            const start = content.indexOf('{', idx);
            if (start === -1) break;

            let depth = 0;
            let inString = false;
            let escapeNext = false;
            let endIdx = -1;
            for (let i = start; i < content.length; i++) {
                const ch = content[i];
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"' && !inString) {
                    inString = true;
                } else if (ch === '"' && inString) {
                    inString = false;
                } else if (!inString) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                    if (depth === 0) {
                        endIdx = i;
                        break;
                    }
                }
            }

            if (endIdx !== -1) {
                objects.push(content.substring(start, endIdx + 1));
                idx = endIdx + 1;
            } else {
                break;
            }
        }
        return objects;
    }

    /**
     * Fallback decision when LLM fails
     */
    fallbackDecision(observation, context = {}) {
        console.log('Using rule-based fallback decision');
        const safeObservation = observation || {};
        const player = safeObservation.player || {};
        const inventory = safeObservation.inventory || { slots: [] };
        const environment = safeObservation.environment || {};
        const strategic = context.strategicContext || {};
        const missing = strategic.missing || [];
        if (this.consecutiveFailures >= 5) {
            if (missing.includes('logs')) {
                return {
                    goal: 'recover_progression_get_wood',
                    reasoning: 'Repeated LLM failures. Resetting to stable progression start.',
                    actions: [{ name: 'chop_tree', params: { count: 3 } }]
                };
            }
            if (missing.includes('stone_pickaxe') || missing.includes('cobblestone')) {
                return {
                    goal: 'recover_progression_get_stone',
                    reasoning: 'Repeated LLM failures. Using deterministic stone progression.',
                    actions: [{ name: 'mine', params: { blockType: 'stone', count: 8 } }]
                };
            }
            if (missing.includes('iron_ore') || missing.includes('iron_ingot')) {
                return {
                    goal: 'recover_progression_get_iron',
                    reasoning: 'Repeated LLM failures. Attempting iron progression deterministically.',
                    actions: [{ name: 'mine', params: { blockType: 'iron_ore', count: 5 } }]
                };
            }
        }
        
        const playerY = player.position?.y ?? 64;
        const isOnSurface = playerY >= 62;
        const isUnderground = playerY < 60;
        const isInWater = player.isInWater === true;
        const oxygen = player.oxygen !== undefined ? player.oxygen : 20;

        // Check if has food in inventory
        const hasFood = (inventory.slots || []).some(i =>
            i && (i.name.includes('beef') || i.name.includes('pork') || i.name.includes('chicken') ||
            i.name.includes('mutton') || i.name.includes('bread') || i.name.includes('cooked') ||
            i.name.includes('apple') || i.name === 'rotten_flesh')
        );
        
        // PRIORITY 0: ESCAPE WATER - highest priority!
        // Always escape if in water, even if oxygen is still high
        if (isInWater) {
            return {
                goal: 'escape_water',
                reasoning: `IN WATER! Oxygen at ${oxygen}/20 - must swim up immediately!`,
                actions: [{ name: 'swim_up', params: {} }]
            };
        }
        
        // PRIORITY 1: If on surface and starving, HUNT - never go back underground
        if (isOnSurface && (player.food ?? 20) <= 5) {
            if (hasFood) {
                return {
                    goal: 'eat_immediately',
                    reasoning: 'Starving on surface with food - eating NOW',
                    actions: [{ name: 'eat', params: {} }]
                };
            } else {
                return {
                    goal: 'hunt_food_urgently',
                    reasoning: 'Starving on surface - must hunt animals immediately',
                    actions: [{ name: 'attack', params: { entity: 'cow' } }]
                };
            }
        }
        
        // PRIORITY 2: Escape if underground
        if (isUnderground) {
            return {
                goal: 'escape_pit',
                reasoning: `Trapped at Y=${Math.floor(playerY)} - must escape first`,
                actions: [{ name: 'dig_to_surface', params: {} }]
            };
        }
        
        // PRIORITY 3: Low food handling (already checked critical food <= 5 above)
        if ((player.food ?? 20) < 10) {
            if (hasFood) {
                return {
                    goal: 'eat_food',
                    reasoning: 'On surface, low food, have food - eating',
                    actions: [{ name: 'eat', params: {} }]
                };
            } else {
                return {
                    goal: 'hunt_food',
                    reasoning: 'On surface, low food, no food - hunting',
                    actions: [{ name: 'attack', params: { entity: 'cow' } }]
                };
            }
        }

        if ((environment.timeOfDay ?? 6000) > 13000 && (environment.timeOfDay ?? 6000) < 23000) {
            return {
                goal: 'seek_shelter',
                reasoning: 'Night time - fallback shelter',
                actions: [{ name: 'dig_emergency_shelter', params: {} }]
            };
        }

        return {
            goal: 'explore',
            reasoning: 'Default exploration',
            actions: [{ name: 'explore', params: { distance: 30 } }]
        };
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            provider: this.config.provider,
            model: this.config.model,
            temperature: this.config.temperature,
            requestCount: this.requestCount,
            totalTokens: this.totalTokens,
            averageTokensPerRequest: this.requestCount > 0 ? Math.round(this.totalTokens / this.requestCount) : 0
        };
    }
}

module.exports = LLMInterface;
