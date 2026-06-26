/**
 * HeuristicEngine - Deterministic rule-based decision engine
 * Implements the same generateDecision() interface as LLMInterface.
 * Zero API cost; drives progression via hardcoded priority logic.
 */

class HeuristicEngine {
    constructor(config = {}) {
        this.config = {
            explorationDistance: 30,
            targetLogs: 4,
            targetCobble: 12,
            targetCoal: 5,
            targetIronOre: 8,
            targetDiamond: 3,
            ...config
        };
        this.logger = null;
        this.requestCount = 0;
    }

    setLogger(logger) {
        this.logger = logger;
    }

    async generateDecision(observation, context = {}) {
        this.requestCount++;
        const startTime = Date.now();

        const decision = this.buildDecision(observation, context);

        // Log a synthetic "LLM request" so the dataset format stays uniform
        if (this.logger) {
            this.logger.logLLMRequest({
                requestId: this.requestCount,
                timestamp: startTime,
                provider: 'heuristic',
                model: 'heuristic-engine',
                prompt: '[heuristic]',
                promptLength: 0,
                success: true,
                response: { content: JSON.stringify(decision) },
                decision: decision,
                tokensUsed: 0,
                duration: Date.now() - startTime
            });
        }

        return decision;
    }

    buildDecision(obs, context) {
        const inv = obs?.inventory?.slots || [];
        const has = (name) => inv.some(i => i.name === name);
        const hasAny = (needle) => inv.some(i => i.name && i.name.includes(needle));
        const countLike = (needle) => inv.filter(i => i.name && i.name.includes(needle)).reduce((s, i) => s + i.count, 0);
        const countEq = (name) => inv.filter(i => i.name === name).reduce((s, i) => s + i.count, 0);

        const player = obs?.player || {};
        const health = player.health ?? 20;
        const food = player.food ?? 20;
        const y = player.position?.y ?? 64;
        const time = obs?.environment?.timeOfDay ?? 6000;
        const isNight = time > 12000 || time < 1000;
        const isInWater = player.isInWater === true;
        const oxygen = player.oxygen ?? 20;

        const recentActions = context?.recentActions || [];
        const blockedActions = context?.blockedActions || [];
        const tier = context?.strategicContext?.currentTier || 'naked';

        // Detect if we just escaped water recently
        const recentSwimUp = recentActions.slice(-2).some(a =>
            (a.action === 'swim_up' || a.action === 'swimUp') && a.success
        );
        const recentRapidDamage = recentActions.slice(-2).some(a =>
            !a.success && (a.error || '').toLowerCase().includes('danger')
        );

        // ---- Helpers ----
        const isBlocked = (name) => blockedActions.includes(name);
        const lastFailed = (name) => {
            const same = recentActions.filter(a => a.action === name);
            return same.length > 0 && !same[same.length - 1].success;
        };
        const lastThreeFailed = (name) => {
            const same = recentActions.filter(a => a.action === name);
            return same.length >= 3 && same.slice(-3).every(a => !a.success);
        };

        // Food tracking
        const foodItems = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread', 'apple',
            'golden_apple', 'golden_carrot', 'melon_slice', 'sweet_berries', 'baked_potato', 'cookie',
            'dried_kelp', 'rotten_flesh', 'spider_eye', 'carrot', 'potato', 'beetroot',
            'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'tropical_fish',
            'pufferfish'];
        const hasFood = inv.some(i => foodItems.includes(i.name));
        const foodCount = inv.filter(i => foodItems.includes(i.name)).reduce((s, i) => s + i.count, 0);

        // Mobs
        const passiveMobs = (obs?.entities?.mobs || []).filter(
            m => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(m.name)
        );
        const hostiles = (obs?.entities?.mobs || []).filter(
            m => ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'phantom'].includes(m.name)
        );
        const veryCloseHostiles = hostiles.filter(m => m.distance < 5);

        // Inventory state
        const logCount = countLike('_log');
        const plankCount = countLike('_planks');
        const stickCount = countEq('stick');
        const cobbleCount = countEq('cobblestone');
        const nearbyCraftingTableObj = obs?.environment?.nearbyCraftingTable;
        const hasCraftingTable = has('crafting_table') || !!nearbyCraftingTableObj;
        const reachableCraftingTable = nearbyCraftingTableObj && (nearbyCraftingTableObj.distance ?? 999) <= 4;
        // Effective table = in inventory, within reach, or reachable nearby table we can walk to
        const effectiveCraftingTable = has('crafting_table') || reachableCraftingTable ||
            (!!nearbyCraftingTableObj && (nearbyCraftingTableObj.distance ?? 999) <= 12);
        const hasPickaxe = hasAny('pickaxe');
        const hasStonePickaxe = has('stone_pickaxe');
        const hasStoneAxe = has('stone_axe');
        const hasIronPickaxe = has('iron_pickaxe');
        const hasIronSword = has('iron_sword');
        const hasFurnace = has('furnace');
        const hasCoal = has('coal') || has('charcoal');
        const coalCount = countEq('coal') + countEq('charcoal');
        const hasTorches = has('torch');
        const ironOreCount = countEq('iron_ore') + countEq('raw_iron');
        const ironIngotCount = countEq('iron_ingot');
        const hasBed = hasAny('_bed');
        const woolCount = countLike('wool');
        const diamondCount = countEq('diamond');
        const hasDiamondPickaxe = has('diamond_pickaxe');
        const hasDiamondSword = has('diamond_sword');
        const obsidianCount = countEq('obsidian');
        const emptySlots = obs?.inventory?.emptySlots ?? 36;

        // ---- 1. EMERGENCY SURVIVAL (backup when guards don't fire) ----
        if (isInWater && oxygen < 10) {
            return { goal: 'escape_drowning', reasoning: 'Heuristic: drowning', actions: [{ name: 'swim_up', params: {} }] };
        }
        // Even if oxygen is okay, being in water is risky — get to shore before doing anything else
        if (isInWater && oxygen < 18) {
            return { goal: 'escape_water', reasoning: 'Heuristic: in water, surfacing to avoid getting stuck', actions: [{ name: 'swim_up', params: {} }] };
        }
        // Flee dangerous mobs proactively.
        // Skeletons can shoot from 16 blocks — flee them at moderate health/distance.
        // Creepers are lethal up close — flee them within 6 blocks at any health.
        // Zombies/spiders are less urgent — only flee when very close and low health.
        const skeletons = hostiles.filter(m => m.name === 'skeleton');
        const creepers = hostiles.filter(m => m.name === 'creeper');
        const closeSkeleton = skeletons.find(m => m.distance < 12);
        const closeCreeper = creepers.find(m => m.distance < 6);
        if (closeSkeleton && health < 15) {
            return {
                goal: 'flee_danger',
                reasoning: `Heuristic: fleeing skeleton (distance ${Math.round(closeSkeleton.distance)})`,
                actions: [{ name: 'flee_from', params: { entity: 'skeleton', distance: 25 } }]
            };
        }
        if (closeCreeper) {
            return {
                goal: 'flee_danger',
                reasoning: `Heuristic: fleeing creeper (distance ${Math.round(closeCreeper.distance)})`,
                actions: [{ name: 'flee_from', params: { entity: 'creeper', distance: 25 } }]
            };
        }
        if (veryCloseHostiles.length > 0 && health < 10) {
            return {
                goal: 'flee_danger',
                reasoning: `Heuristic: fleeing ${veryCloseHostiles[0].name}`,
                actions: [{ name: 'flee_from', params: { entity: veryCloseHostiles[0].name, distance: 30 } }]
            };
        }
        if (health <= 6 && hasFood) {
            return { goal: 'eat_emergency', reasoning: 'Heuristic: critical health', actions: [{ name: 'eat', params: {} }] };
        }
        if (health <= 6 && !hasFood && passiveMobs.length > 0 && !isBlocked('attack')) {
            return { goal: 'hunt_emergency', reasoning: 'Heuristic: critical health, no food', actions: [{ name: 'attack', params: { entity: passiveMobs[0].name } }] };
        }
        // Starvation fallback: break leaves/bushes around us to find apples or edible plants
        if (food <= 8 && !hasFood && !lastThreeFailed('break_around') && !isBlocked('break_around')) {
            return { goal: 'forage_for_food', reasoning: 'Heuristic: starving, foraging leaves/bushes for apples/berries', actions: [{ name: 'break_around', params: { direction: 'escape' } }] };
        }
        if (y < 50 && !isInWater && !hasPickaxe) {
            // Emergency: craft a wooden pickaxe from inventory (2x2 grid) so we can actually dig out
            if (plankCount >= 3 && stickCount >= 2 && !lastThreeFailed('craft')) {
                return { goal: 'craft_wooden_pickaxe_emergency', reasoning: 'Heuristic: deep underground without pickaxe, crafting wooden pickaxe from inventory', actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }] };
            }
            // No planks but have logs — craft planks first, pickaxe next loop
            if (logCount >= 1 && stickCount >= 2 && !lastThreeFailed('craft')) {
                return { goal: 'craft_planks_emergency', reasoning: 'Heuristic: deep underground without pickaxe, crafting planks from logs first', actions: [{ name: 'craft', params: { item: 'oak_planks' } }] };
            }
            // No materials to craft — try digging with fists (slow, may stall on stone)
            return { goal: 'escape_underground', reasoning: 'Heuristic: deep underground without pickaxe', actions: [{ name: 'dig_to_surface', params: {} }] };
        }

        // ---- 2. NIGHT SURVIVAL ----
        if (isNight && y >= 62) {
            // Check if already sheltered (under solid cover) — consistent with buildShelter logic
            const above = obs?.environment?.verticalProfile?.above || [];
            const isSolid = (name) => name && name !== 'air' && name !== 'unknown' && !name.includes('leaves');
            const isUnderRoof = isSolid((above[0] || '').toLowerCase()) ||
                                isSolid((above[1] || '').toLowerCase()) ||
                                isSolid((above[2] || '').toLowerCase());
            const recentlyDugShelter = recentActions.slice(-2).some(a =>
                a.action === 'dig_emergency_shelter' && a.success
            );

            if (isUnderRoof || recentlyDugShelter) {
                // Already sheltered — no need to build or dig more
                // Fall through to other priorities (food, progression, etc.)
            } else {
                if (hasBed && !isBlocked('sleep_if_possible')) {
                    return { goal: 'sleep_night', reasoning: 'Heuristic: night sleep', actions: [{ name: 'sleep_if_possible', params: {} }] };
                }
                const placeable = plankCount + cobbleCount + countEq('dirt');
                // buildShelter action requires 10+ blocks, so only trigger when we have enough.
                // BUT: building at night is dangerous if mobs are nearby (bot stands still placing blocks).
                // Prefer digging if skeletons or creepers are within 15 blocks.
                const nearbyThreats = hostiles.filter(m => (m.name === 'skeleton' || m.name === 'creeper') && m.distance < 15).length;
                if (placeable >= 10 && !isBlocked('build_shelter') && nearbyThreats === 0) {
                    return { goal: 'build_shelter_night', reasoning: 'Heuristic: night shelter', actions: [{ name: 'build_shelter', params: {} }] };
                }
                // If we're already deep in a hole (y < 65), we're as sheltered as we can be without a roof.
                // EXCEPTION: after respawn with no tools at night, digging is still our best defence.
                const recentlySpawned = recentActions.length <= 3;
                // Consider "in a hole" if we're below typical surface level (y < 68).
                // Spawn can be as high as Y=85, so Y=68 is safely below most surface levels.
                const alreadyInHole = y < 68 && !recentlySpawned;
                // Don't dig again if we just dug a shelter (prevents digging to bedrock)
                // Allow digging even bare-handed — it's slow but better than dying to mobs at night.
                if (!alreadyInHole && !recentlyDugShelter && !isBlocked('dig_emergency_shelter')) {
                    return { goal: 'dig_emergency_night', reasoning: 'Heuristic: night emergency shelter', actions: [{ name: 'dig_emergency_shelter', params: {} }] };
                }
            }
            // Truly empty at night or already sheltered: fall through to progression
        }

        // ---- 3. FOOD SECURITY ----
        if (food < 10 && hasFood) {
            return { goal: 'eat_food', reasoning: 'Heuristic: low food', actions: [{ name: 'eat', params: {} }] };
        }
        // When food is critically low, hunt any available passive mob.
        // Even if no mobs in observation range, the attack action uses bot.nearestEntity
        // which can find mobs beyond our 32-block observation radius.
        if (food < 10 && !hasFood && !lastThreeFailed('attack') && !isBlocked('attack')) {
            const targetMob = passiveMobs.length > 0 ? passiveMobs[0].name : 'sheep';
            return { goal: 'hunt_food', reasoning: 'Heuristic: low food, hunting', actions: [{ name: 'attack', params: { entity: targetMob } }] };
        }
        // Proactively stock food when getting low
        if (food < 14 && foodCount < 6 && !lastThreeFailed('attack') && !isBlocked('attack')) {
            const targetMob = passiveMobs.length > 0 ? passiveMobs[0].name : 'sheep';
            return { goal: 'stock_food', reasoning: 'Heuristic: stocking food', actions: [{ name: 'attack', params: { entity: targetMob } }] };
        }
        // If attack is blocked/failing but we need food, explore to find mobs
        if ((food < 10 || health <= 8) && !hasFood && !isBlocked('explore') && !lastThreeFailed('explore')) {
            return { goal: 'find_food', reasoning: 'Heuristic: need food, exploring to find mobs', actions: [{ name: 'explore', params: { distance: this.config.explorationDistance } }] };
        }

        // ---- 4. INVENTORY MANAGEMENT ----
        if (emptySlots <= 2) {
            // Try to drop junk first
            if (!isBlocked('drop_item')) {
                return { goal: 'free_inventory', reasoning: 'Heuristic: inventory full', actions: [{ name: 'drop_item', params: { item: 'auto' } }] };
            }
        }

        // Tool durability helper: find a usable tool of a given type, or null if all are worn out
        const findUsableTool = (toolType) => {
            const tools = inv.filter(i => i.name && i.name.includes(toolType));
            return tools.find(t => {
                if (!t.maxDurability) return true; // No durability tracking = usable
                const remaining = t.maxDurability - (t.durabilityUsed || 0);
                return remaining / t.maxDurability >= 0.15;
            });
        };
        const usablePickaxe = findUsableTool('pickaxe');
        const usableAxe = findUsableTool('_axe');

        // If our only pickaxe is about to break and we can craft a replacement, do it now
        if (!usablePickaxe && hasAny('pickaxe') && !lastThreeFailed('craft')) {
            if (cobbleCount >= 3 && stickCount >= 2 && effectiveCraftingTable) {
                return { goal: 'replace_broken_pickaxe', reasoning: 'Heuristic: pickaxe nearly broken, crafting stone replacement', actions: [{ name: 'craft', params: { item: 'stone_pickaxe' } }] };
            }
            if (plankCount >= 3 && stickCount >= 2) {
                return { goal: 'replace_broken_pickaxe', reasoning: 'Heuristic: pickaxe nearly broken, crafting wooden replacement', actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }] };
            }
        }

        // If we have NO pickaxe at all but materials to craft one, do it immediately
        if (!hasAny('pickaxe') && !lastThreeFailed('craft')) {
            if (cobbleCount >= 3 && stickCount >= 2) {
                if (effectiveCraftingTable) {
                    return { goal: 'craft_stone_pickaxe', reasoning: 'Heuristic: no pickaxe in inventory, crafting stone pickaxe', actions: [{ name: 'craft', params: { item: 'stone_pickaxe' } }] };
                }
                // Have materials but no reachable table: craft/place a table first
                if (plankCount >= 4) {
                    return { goal: 'craft_table_for_pickaxe', reasoning: 'Heuristic: no reachable crafting table, crafting one to make stone pickaxe', actions: [{ name: 'craft', params: { item: 'crafting_table' } }] };
                }
                // Table exists but is far away: walk to it
                if (nearbyCraftingTableObj && nearbyCraftingTableObj.position) {
                    const p = nearbyCraftingTableObj.position;
                    return { goal: 'return_to_crafting_table', reasoning: 'Heuristic: returning to crafting table to craft stone pickaxe', actions: [{ name: 'move_to', params: { x: p.x, y: p.y, z: p.z } }] };
                }
            }
            if (plankCount >= 3 && stickCount >= 2) {
                return { goal: 'craft_wooden_pickaxe', reasoning: 'Heuristic: no pickaxe in inventory, crafting wooden pickaxe', actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }] };
            }
        }

        // Proactive: craft backup pickaxe BEFORE current one becomes unusable (<25% durability)
        const bestPickaxe = inv.filter(i => i.name && i.name.includes('pickaxe')).sort((a, b) => {
            const order = ['diamond', 'iron', 'stone', 'wooden'];
            return order.findIndex(m => a.name.includes(m)) - order.findIndex(m => b.name.includes(m));
        })[0];
        if (bestPickaxe && bestPickaxe.maxDurability && !lastThreeFailed('craft')) {
            const remaining = bestPickaxe.maxDurability - (bestPickaxe.durabilityUsed || 0);
            const durabilityPct = remaining / bestPickaxe.maxDurability;
            if (durabilityPct < 0.25) {
                // Craft backup before this one breaks — prefer upgrading tier if possible
                if (cobbleCount >= 3 && stickCount >= 2 && effectiveCraftingTable && !bestPickaxe.name.includes('iron') && !bestPickaxe.name.includes('diamond')) {
                    return { goal: 'craft_backup_pickaxe', reasoning: 'Heuristic: pickaxe at ' + Math.round(durabilityPct * 100) + '% durability, crafting stone backup before it breaks underground', actions: [{ name: 'craft', params: { item: 'stone_pickaxe' } }] };
                }
                if (plankCount >= 3 && stickCount >= 2 && !bestPickaxe.name.includes('stone') && !bestPickaxe.name.includes('iron') && !bestPickaxe.name.includes('diamond')) {
                    return { goal: 'craft_backup_pickaxe', reasoning: 'Heuristic: pickaxe at ' + Math.round(durabilityPct * 100) + '% durability, crafting wooden backup before it breaks underground', actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }] };
                }
            }
        }

        // ---- 5. PROGRESSION BY TIER / INVENTORY STATE ----
        // Ordered from highest to lowest tier so we never regress.
        // Progression ceiling: diamond_pickaxe. Obsidian/enchanting-table/nether
        // require water-bucket mechanics that are not yet implemented.

        // Late game: diamonds
        if (hasIronPickaxe && !hasDiamondPickaxe) {
            // Descend to diamond level if too high
            if (y > 16 && !lastThreeFailed('mine')) {
                return { goal: 'descend_for_diamonds', reasoning: 'Heuristic: descending to diamond level', actions: [{ name: 'mine', params: { blockType: 'stone', count: 10 } }] };
            }
            // Mine for diamonds when at right level
            if (y <= 16 && y >= 5 && diamondCount < this.config.targetDiamond && !lastThreeFailed('mine')) {
                return { goal: 'mine_diamonds', reasoning: 'Heuristic: mining for diamonds', actions: [{ name: 'mine', params: { blockType: 'diamond_ore', count: 3 } }] };
            }
            // Explore to find caves if no diamonds yet
            if (diamondCount < this.config.targetDiamond && !lastThreeFailed('explore') && !isBlocked('explore')) {
                return { goal: 'explore_caves', reasoning: 'Heuristic: exploring for diamonds', actions: [{ name: 'explore', params: { distance: this.config.explorationDistance } }] };
            }
            // Craft diamond pickaxe
            if (diamondCount >= 3 && stickCount >= 2 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_diamond_pickaxe', reasoning: 'Heuristic: diamond pickaxe', actions: [{ name: 'craft', params: { item: 'diamond_pickaxe' } }] };
            }
        }

        // Mid game: iron tools + bed
        if (hasStonePickaxe && !hasIronPickaxe) {
            if (!hasFurnace && cobbleCount >= 8 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_furnace', reasoning: 'Heuristic: craft furnace', actions: [{ name: 'craft', params: { item: 'furnace' } }] };
            }
            if (!hasCoal && !lastThreeFailed('mine') && !isBlocked('mine')) {
                return { goal: 'mine_coal', reasoning: 'Heuristic: mine coal', actions: [{ name: 'mine', params: { blockType: 'coal_ore', count: this.config.targetCoal } }] };
            }
            // Charcoal fallback: smelt a log if no coal but we have a furnace
            const logItem = inv.find(i => i.name.includes('_log'));
            if (!hasCoal && !hasTorches && hasFurnace && logItem && !lastThreeFailed('smelt')) {
                return { goal: 'smelt_charcoal', reasoning: 'Heuristic: smelting charcoal from logs for torches', actions: [{ name: 'smelt', params: { item: logItem.name, count: 1 } }] };
            }
            if (!hasTorches && (coalCount >= 1 || countEq('charcoal') >= 1) && stickCount >= 1 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_torches', reasoning: 'Heuristic: craft torches', actions: [{ name: 'craft', params: { item: 'torch', count: 16 } }] };
            }
            if (!hasBed && woolCount < 3) {
                const sheep = (obs?.entities?.mobs || []).find(m => m.name === 'sheep');
                if (sheep && !lastThreeFailed('attack') && !isBlocked('attack')) {
                    return { goal: 'get_wool', reasoning: 'Heuristic: kill sheep for wool', actions: [{ name: 'attack', params: { entity: 'sheep' } }] };
                }
            }
            if (!hasBed && woolCount >= 3 && plankCount >= 3 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_bed', reasoning: 'Heuristic: craft bed', actions: [{ name: 'craft', params: { item: 'white_bed' } }] };
            }
            // Smelt iron ASAP if we have ore + furnace + fuel — don't carry raw ore around and risk losing it
            if (ironOreCount > 0 && hasFurnace && coalCount > 0 && !lastThreeFailed('smelt')) {
                return { goal: 'smelt_iron', reasoning: 'Heuristic: smelt iron immediately', actions: [{ name: 'smelt', params: { item: 'iron_ingot', count: ironOreCount } }] };
            }
            // Mine iron, but avoid drowning — skip if we're deep near water
            if (ironOreCount < this.config.targetIronOre && !lastThreeFailed('mine') && !isBlocked('mine')) {
                const nearbyWater = (obs?.environment?.verticalProfile?.below || []).some(b => b && b.includes('water'));
                const deepAndWet = y < 55 && nearbyWater;
                if (!deepAndWet) {
                    return { goal: 'mine_iron', reasoning: 'Heuristic: mine iron ore', actions: [{ name: 'mine', params: { blockType: 'iron_ore', count: 5 } }] };
                }
            }
            if (ironIngotCount < 3 && ironOreCount > 0 && hasFurnace && coalCount > 0 && !lastThreeFailed('smelt')) {
                return { goal: 'smelt_iron', reasoning: 'Heuristic: smelt iron', actions: [{ name: 'smelt', params: { item: 'iron_ingot', count: ironOreCount } }] };
            }
            if (ironIngotCount >= 3 && stickCount >= 2 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_iron_pickaxe', reasoning: 'Heuristic: iron pickaxe', actions: [{ name: 'craft', params: { item: 'iron_pickaxe' } }] };
            }
            if (!hasIronSword && ironIngotCount >= 2 && stickCount >= 1 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_iron_sword', reasoning: 'Heuristic: iron sword', actions: [{ name: 'craft', params: { item: 'iron_sword' } }] };
            }
        }

        // Early game: get to stone tools
        // (Most of this is handled by agent.js guards, but we fill gaps.)
        if (!hasStonePickaxe) {
            // If we already have a pickaxe but no cobble, prioritize mining stone
            if (cobbleCount < this.config.targetCobble && hasPickaxe && !lastThreeFailed('mine') && !isBlocked('mine')) {
                // Only mine if we have a usable pickaxe
                if (usablePickaxe) {
                    // If we're very high up (tree/cliff), path down first — mining from Y>70 usually fails
                    if (y > 70 && !lastThreeFailed('explore') && !isBlocked('explore')) {
                        return { goal: 'descend_to_mine', reasoning: 'Heuristic: too high to mine safely, exploring down', actions: [{ name: 'explore', params: { distance: 15 } }] };
                    }
                    return { goal: 'mine_stone', reasoning: 'Heuristic: mine stone', actions: [{ name: 'mine', params: { blockType: 'stone', count: 10 } }] };
                }
            }
            // Gather wood if we need it for tools — even if we already have a wooden pickaxe,
            // we may need more wood for sticks/planks to craft stone tools.
            const needWoodForProgression = !hasPickaxe || stickCount < 2 || plankCount < 2;
            if (logCount < this.config.targetLogs && needWoodForProgression && !lastThreeFailed('chop_tree')) {
                return { goal: 'gather_wood', reasoning: 'Heuristic: need logs for tools/sticks', actions: [{ name: 'chop_tree', params: { count: 2 } }] };
            }
            if (plankCount < 4 && logCount >= 1 && !lastThreeFailed('craft')) {
                return { goal: 'craft_planks', reasoning: 'Heuristic: craft planks', actions: [{ name: 'craft', params: { item: 'planks', count: 4 } }] };
            }
            if (stickCount < 2 && plankCount >= 2 && !lastThreeFailed('craft')) {
                return { goal: 'craft_sticks', reasoning: 'Heuristic: craft sticks', actions: [{ name: 'craft', params: { item: 'stick', count: 4 } }] };
            }
            if (!hasCraftingTable && plankCount >= 4 && !lastThreeFailed('craft')) {
                return { goal: 'craft_table', reasoning: 'Heuristic: craft table', actions: [{ name: 'craft', params: { item: 'crafting_table' } }] };
            }
            if (!has('wooden_pickaxe') && plankCount >= 3 && stickCount >= 2 && !lastThreeFailed('craft')) {
                return { goal: 'craft_wooden_pickaxe', reasoning: 'Heuristic: wooden pickaxe', actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }] };
            }
            // Prioritize stone pickaxe over wooden axe — stone pickaxe is mandatory for progression,
            // wooden axe is just a convenience. If we have cobble + sticks + table, craft stone pickaxe first.
            if (cobbleCount >= 3 && stickCount >= 2 && !lastThreeFailed('craft')) {
                if (effectiveCraftingTable) {
                    return { goal: 'craft_stone_pickaxe', reasoning: 'Heuristic: stone pickaxe', actions: [{ name: 'craft', params: { item: 'stone_pickaxe' } }] };
                }
                if (plankCount >= 4) {
                    return { goal: 'craft_table_for_stone', reasoning: 'Heuristic: crafting table needed for stone pickaxe', actions: [{ name: 'craft', params: { item: 'crafting_table' } }] };
                }
                if (nearbyCraftingTableObj && nearbyCraftingTableObj.position) {
                    const p = nearbyCraftingTableObj.position;
                    return { goal: 'return_to_crafting_table', reasoning: 'Heuristic: returning to crafting table for stone pickaxe', actions: [{ name: 'move_to', params: { x: p.x, y: p.y, z: p.z } }] };
                }
            }
            if (!has('wooden_axe') && plankCount >= 3 && stickCount >= 2 && !lastThreeFailed('craft')) {
                return { goal: 'craft_wooden_axe', reasoning: 'Heuristic: wooden axe', actions: [{ name: 'craft', params: { item: 'wooden_axe' } }] };
            }
            // Wooden sword: cheap weapon for early combat (auto-equipped by attack action)
            if (!has('wooden_sword') && plankCount >= 2 && stickCount >= 1 && !lastThreeFailed('craft')) {
                return { goal: 'craft_wooden_sword', reasoning: 'Heuristic: wooden sword for self-defence', actions: [{ name: 'craft', params: { item: 'wooden_sword' } }] };
            }
        }
        if (hasStonePickaxe && !hasStoneAxe && cobbleCount >= 3 && stickCount >= 2 && effectiveCraftingTable && !lastThreeFailed('craft')) {
            return { goal: 'craft_stone_axe', reasoning: 'Heuristic: stone axe', actions: [{ name: 'craft', params: { item: 'stone_axe' } }] };
        }
        // Stone sword after stone pickaxe — much better damage than wooden
        if (hasStonePickaxe && !has('stone_sword') && cobbleCount >= 2 && stickCount >= 1 && effectiveCraftingTable && !lastThreeFailed('craft')) {
            return { goal: 'craft_stone_sword', reasoning: 'Heuristic: stone sword for self-defence', actions: [{ name: 'craft', params: { item: 'stone_sword' } }] };
        }

        // Shield: blocks skeleton arrows. Costs 6 planks + 1 iron ingot — huge survivability boost.
        if (!has('shield') && plankCount >= 6 && ironIngotCount >= 1 && effectiveCraftingTable && !lastThreeFailed('craft')) {
            return { goal: 'craft_shield', reasoning: 'Heuristic: shield for skeleton protection', actions: [{ name: 'craft', params: { item: 'shield' } }] };
        }
        // Iron armor progression (if we have surplus iron)
        if (ironIngotCount >= 8 && hasIronPickaxe) {
            if (!has('iron_helmet') && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_iron_helmet', reasoning: 'Heuristic: iron armor', actions: [{ name: 'craft', params: { item: 'iron_helmet' } }] };
            }
            if (!has('iron_chestplate') && ironIngotCount >= 8 && effectiveCraftingTable && !lastThreeFailed('craft')) {
                return { goal: 'craft_iron_chestplate', reasoning: 'Heuristic: iron armor', actions: [{ name: 'craft', params: { item: 'iron_chestplate' } }] };
            }
        }

        // Default: light torches if underground, otherwise explore or gather
        if (y < 62 && !hasTorches && (coalCount >= 1 || countEq('charcoal') >= 1) && stickCount >= 1 && effectiveCraftingTable && !lastThreeFailed('craft')) {
            return { goal: 'craft_torches', reasoning: 'Heuristic: need light underground', actions: [{ name: 'craft', params: { item: 'torch', count: 8 } }] };
        }
        if (y < 62 && hasTorches && !lastThreeFailed('light_area')) {
            return { goal: 'light_area', reasoning: 'Heuristic: place torches', actions: [{ name: 'light_area', params: { radius: 5 } }] };
        }

        // Avoid explore if we just escaped water or took rapid damage — these are often blocked by agent.js,
        // but as a heuristic we also prefer safer actions.
        const safeToExplore = !recentSwimUp && !recentRapidDamage;

        // If we have stone tools but no iron yet, keep mining/exploring
        if (hasStonePickaxe && !hasIronPickaxe && !lastThreeFailed('explore') && !isBlocked('explore') && safeToExplore) {
            return { goal: 'explore_for_iron', reasoning: 'Heuristic: exploring for iron', actions: [{ name: 'explore', params: { distance: this.config.explorationDistance } }] };
        }

        // Ultimate fallback
        if (!lastThreeFailed('explore') && !isBlocked('explore') && safeToExplore) {
            return { goal: 'explore', reasoning: 'Heuristic: default explore', actions: [{ name: 'explore', params: { distance: this.config.explorationDistance } }] };
        }

        // If explore is unsafe or keeps failing, try mining stone or chopping trees
        if (!lastThreeFailed('mine') && usablePickaxe) {
            return { goal: 'mine_stone_fallback', reasoning: 'Heuristic: explore unsafe/failing, mining stone instead', actions: [{ name: 'mine', params: { blockType: 'stone', count: 5 } }] };
        }

        // If we're stuck underground/confined, dig to surface instead of useless chop_tree
        const blockAboveHead = (obs?.environment?.verticalProfile?.above?.[0] || '').toLowerCase();
        const isSolidAbove = blockAboveHead && blockAboveHead !== 'air' && blockAboveHead !== 'unknown' && !blockAboveHead.includes('leaves');
        const isUnderground = y < 62;
        if ((isUnderground || isSolidAbove) && !lastThreeFailed('dig_to_surface')) {
            return { goal: 'escape_confinement', reasoning: 'Heuristic: stuck underground/confined, digging to surface', actions: [{ name: 'dig_to_surface', params: {} }] };
        }
        // If stuck on surface (not underground) but explore AND chop_tree both keep failing,
        // we might be stranded on a tree/ledge. Try breaking around or digging down.
        const surfaceStuck = y >= 62 && !isSolidAbove && lastThreeFailed('explore') && lastThreeFailed('chop_tree');
        if (surfaceStuck && !lastThreeFailed('dig_to_surface')) {
            return { goal: 'escape_surface_stuck', reasoning: 'Heuristic: stuck on surface, digging to freedom', actions: [{ name: 'dig_to_surface', params: {} }] };
        }
        if (!lastThreeFailed('chop_tree') && usableAxe) {
            return { goal: 'chop_tree_fallback', reasoning: 'Heuristic: explore unsafe/failing, chopping wood instead', actions: [{ name: 'chop_tree', params: { count: 2 } }] };
        }

        // If explore keeps failing, try mining stone
        if (!lastThreeFailed('mine')) {
            return { goal: 'mine_stone_fallback', reasoning: 'Heuristic: explore failed, mining stone', actions: [{ name: 'mine', params: { blockType: 'stone', count: 5 } }] };
        }

        // Absolute fallback
        return { goal: 'wait', reasoning: 'Heuristic: waiting', actions: [{ name: 'wait', params: { ms: 1000 } }] };
    }
}

module.exports = HeuristicEngine;
