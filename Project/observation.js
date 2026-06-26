/**
 * Observation Schema - Structured state extraction from Mineflayer
 * Following the prompt requirements for deterministic logging
 */

const { Vec3 } = require('vec3');

class ObservationSystem {
    constructor(bot) {
        this.bot = bot;
    }

    /**
     * Get complete structured observation for a decision step
     * @returns {Object} Structured observation following the schema
     */
    getStructuredObservation() {
        const observation = {
            timestamp: Date.now(),
            tick: this.bot.time.age || 0,
            
            // Player state
            player: {
                position: this.getPosition(),
                health: this.bot.health,
                food: this.bot.food,
                saturation: this.bot.foodSaturation,
                // Normalize raw mineflayer oxygenLevel (0–300 ticks) to the 0–20 scale the
                // prompt displays as "/20". Raw values > 300 are clamped; -20 (drowning animation)
                // maps to 0 so the drowning alert threshold (< 10) works correctly.
                oxygen: Math.max(0, Math.min(20, Math.round((this.bot.oxygenLevel ?? 300) / 15))),
                isInWater: this.bot.entity ? this.bot.entity.isInWater : false,
                experience: {
                    level: this.bot.experience.level,
                    points: this.bot.experience.points,
                    progress: this.bot.experience.progress
                },
                gamemode: this.bot.game.gameMode,
                dimension: this.bot.game.dimension,
                standingOn: (() => {
                    const pos = this.getPosition();
                    const block = this.bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)));
                    return block ? block.name : 'unknown';
                })()
            },

            // Inventory state
            inventory: this.getInventoryState(),

            // Nearby entities (mobs, players, items)
            entities: this.getNearbyEntities(),

            // Nearby blocks (within view range)
            blocks: this.getNearbyBlocks(),

            // Environmental state
            environment: {
                timeOfDay: this.bot.time.timeOfDay,
                isRaining: this.bot.isRaining,
                thunderState: this.bot.thunderState,
                biome: this.getCurrentBiome(),
                lightLevel: this.getLightLevel(),
                terrainScan: this.getTerrainScan(),
                verticalProfile: this.getVerticalProfile(),
                nearbyCraftingTable: this.getNearbyCraftingTable(),
                nearbyBed: this.getNearbyBed()
            },

            // Recent events (damage, messages, etc.)
            recentEvents: [] // Will be populated by event tracking
        };

        observation.blocks.summary = this.getEnvironmentSummary(observation);

        return observation;
    }

    getPosition() {
        const pos = this.bot.entity.position;
        return {
            x: Math.floor(pos.x * 100) / 100,
            y: Math.floor(pos.y * 100) / 100,
            z: Math.floor(pos.z * 100) / 100,
            yaw: this.bot.entity.yaw,
            pitch: this.bot.entity.pitch
        };
    }

    getInventoryState() {
        const inventory = {
            slots: [],
            totalItems: 0,
            emptySlots: 0
        };

        if (!this.bot.inventory) return inventory;

        this.bot.inventory.slots.forEach((item, index) => {
            if (item) {
                inventory.slots.push({
                    slot: index,
                    name: item.name,
                    displayName: item.displayName,
                    count: item.count,
                    stackSize: item.stackSize,
                    durability: item.durabilityUsed,
                    maxDurability: item.maxDurability
                });
                inventory.totalItems += item.count;
            } else {
                inventory.emptySlots++;
            }
        });

        // Add equipped items
        const heldItem = this.bot.heldItem;
        inventory.equipped = {
            hand: heldItem ? heldItem.name : null,
            helmet: this.bot.inventory.slots[5] ? this.bot.inventory.slots[5].name : null,
            chestplate: this.bot.inventory.slots[6] ? this.bot.inventory.slots[6].name : null,
            leggings: this.bot.inventory.slots[7] ? this.bot.inventory.slots[7].name : null,
            boots: this.bot.inventory.slots[8] ? this.bot.inventory.slots[8].name : null
        };

        // Durability of currently held tool (for LLM to decide when to replace)
        if (heldItem && heldItem.maxDurability) {
            const used = heldItem.durabilityUsed || 0;
            const remaining = heldItem.maxDurability - used;
            inventory.equippedToolDurability = {
                item: heldItem.name,
                remaining,
                max: heldItem.maxDurability,
                pct: Math.round((remaining / heldItem.maxDurability) * 100)
            };
        } else {
            inventory.equippedToolDurability = null;
        }

        return inventory;
    }

    getLightLevel() {
        try {
            const pos = this.bot.entity.position.floored();
            const blockLight = this.bot.world.getBlockLight(pos) ?? -1;
            const skyLight = this.bot.world.getSkyLight(pos) ?? -1;
            // Effective light for mob spawning: at night sky contributes 0; during day it contributes fully.
            // Report both and let the LLM reason — also include a simple safe/unsafe flag.
            const isNight = this.bot.time.timeOfDay > 12000 || this.bot.time.timeOfDay < 1000;
            const effectiveLight = isNight
                ? blockLight
                : Math.max(blockLight, skyLight);
            return {
                block: blockLight,
                sky: skyLight,
                effective: effectiveLight,
                mobSpawnRisk: effectiveLight < 8 // mobs spawn at light < 8 in 1.20.4
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Detect if there is a crafting table block nearby (placed in world).
     * So the agent/LLM knows "table already placed" and does not keep trying to craft one.
     */
    getNearbyCraftingTable() {
        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const tableData = mcData.blocksByName && mcData.blocksByName.crafting_table;
            if (!tableData || !this.bot.findBlock) return null;
            const block = this.bot.findBlock({ matching: tableData.id, maxDistance: 32 });
            if (!block) return null;
            const distance = Math.floor(this.bot.entity.position.distanceTo(block.position));
            return { distance, position: { x: block.position.x, y: block.position.y, z: block.position.z } };
        } catch (e) {
            return null;
        }
    }

    getNearbyBed() {
        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const bedTypes = ['white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
                'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed',
                'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed'];
            for (const bedName of bedTypes) {
                const bedData = mcData.blocksByName[bedName];
                if (!bedData) continue;
                const block = this.bot.findBlock({ matching: bedData.id, maxDistance: 32 });
                if (block) {
                    const distance = Math.floor(this.bot.entity.position.distanceTo(block.position));
                    return { distance, position: { x: block.position.x, y: block.position.y, z: block.position.z } };
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    getNearbyEntities(maxDistance = 32) {
        const entities = {
            players: [],
            mobs: [],
            items: [],
            other: []
        };

        Object.values(this.bot.entities).forEach(entity => {
            if (entity === this.bot.entity) return;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance > maxDistance) return;

            const entityInfo = {
                type: entity.type,
                name: entity.name || entity.displayName,
                position: {
                    x: Math.floor(entity.position.x * 100) / 100,
                    y: Math.floor(entity.position.y * 100) / 100,
                    z: Math.floor(entity.position.z * 100) / 100
                },
                distance: Math.floor(distance * 100) / 100,
                health: entity.health,
                metadata: entity.metadata
            };

            // Categorize entities
            if (entity.type === 'player') {
                entities.players.push(entityInfo);
            } else if (entity.type === 'mob') {
                entities.mobs.push(entityInfo);
            } else if (entity.type === 'object' && entity.objectType === 'Item') {
                entities.items.push(entityInfo);
            } else {
                entities.other.push(entityInfo);
            }
        });

        return entities;
    }

    getNearbyBlocks(radius = 16) {
        const blocks = {
            resources: {},  // Gatherable resources
            interesting: [] // Ores, chests, spawners, etc.
        };

        const botPos = this.bot.entity.position;
        
        // Look for specific resource types
        const resourceBlocks = [
            'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
            'stone', 'cobblestone', 'dirt', 'sand', 'gravel', 'water', 'lava'
        ];
        const interestingBlocks = [
            'coal_ore', 'deepslate_coal_ore',
            'iron_ore', 'deepslate_iron_ore',
            'copper_ore', 'deepslate_copper_ore',
            'lapis_ore', 'deepslate_lapis_ore',
            'gold_ore', 'diamond_ore', 'emerald_ore',
            'chest', 'crafting_table', 'furnace', 'bed'
        ];

        // Check for resources
        resourceBlocks.forEach(blockName => {
            const blockData = this.bot.registry.blocksByName[blockName];
            if (!blockData) return;
            const positions = this.bot.findBlocks({
                matching: blockData.id,
                maxDistance: radius,
                count: 5
            });
            if (positions.length > 0) {
                const nearest = positions
                    .map(p => ({ p, d: botPos.distanceTo(p) }))
                    .sort((a, b) => a.d - b.d)[0];
                const distance = Math.floor(nearest.d);
                blocks.resources[blockName] = {
                    found: true,
                    distance: distance,
                    position: { 
                        x: nearest.p.x, 
                        y: nearest.p.y, 
                        z: nearest.p.z 
                    },
                    countNearby: positions.length
                };
            }
        });

        // Check for interesting blocks
        interestingBlocks.forEach(blockName => {
            const blockData = this.bot.registry.blocksByName[blockName];
            if (!blockData) return;
            const positions = this.bot.findBlocks({
                matching: blockData.id,
                maxDistance: 32,
                count: 8
            });
            for (const p of positions) {
                blocks.interesting.push({
                    name: blockName,
                    position: { x: p.x, y: p.y, z: p.z },
                    distance: Math.floor(botPos.distanceTo(p))
                });
            }
        });

        blocks.interesting.sort((a, b) => a.distance - b.distance);
        if (blocks.interesting.length > 20) {
            blocks.interesting = blocks.interesting.slice(0, 20);
        }

        return blocks;
    }

    getTerrainScan(maxDistance = 8) {
        const pos = this.bot.entity.position.floored();
        const dirs = [
            { id: 'north', x: 0, z: -1 },
            { id: 'south', x: 0, z: 1 },
            { id: 'east', x: 1, z: 0 },
            { id: 'west', x: -1, z: 0 },
            { id: 'north_east', x: 1, z: -1 },
            { id: 'north_west', x: -1, z: -1 },
            { id: 'south_east', x: 1, z: 1 },
            { id: 'south_west', x: -1, z: 1 }
        ];
        const result = {};

        for (const dir of dirs) {
            let hazard = 'solid';
            let distance = maxDistance;
            for (let d = 1; d <= maxDistance; d++) {
                const foot = this.bot.blockAt(pos.offset(dir.x * d, -1, dir.z * d));
                const body = this.bot.blockAt(pos.offset(dir.x * d, 0, dir.z * d));
                if (!foot || foot.name === 'air') {
                    hazard = 'cliff_or_hole';
                    distance = d;
                    break;
                }
                if (foot.name === 'water' || body?.name === 'water') {
                    hazard = 'water';
                    distance = d;
                    break;
                }
                if (foot.name === 'lava' || body?.name === 'lava') {
                    hazard = 'lava';
                    distance = d;
                    break;
                }
            }
            result[dir.id] = { hazard, distance };
        }
        return result;
    }

    getVerticalProfile(depth = 5) {
        const pos = this.bot.entity.position.floored();
        const above = [];
        const below = [];
        for (let i = 1; i <= depth; i++) {
            const up = this.bot.blockAt(pos.offset(0, i, 0));
            above.push(up ? up.name : 'unknown');
            const down = this.bot.blockAt(pos.offset(0, -i, 0));
            below.push(down ? down.name : 'unknown');
        }
        return { above, below };
    }

    getEnvironmentSummary(observation) {
        const terrain = observation.environment?.terrainScan || {};
        const hazards = Object.entries(terrain)
            .filter(([, data]) => data.hazard !== 'solid')
            .sort((a, b) => a[1].distance - b[1].distance)
            .slice(0, 3)
            .map(([dir, data]) => `${data.hazard} ${data.distance} blocks ${dir.replace('_', ' ')}`);
        const resources = Object.entries(observation.blocks?.resources || {})
            .filter(([, data]) => data.found)
            .sort((a, b) => a[1].distance - b[1].distance)
            .slice(0, 5)
            .map(([name, data]) => `${name} ${data.distance}m`);

        const topBlock = observation.environment?.verticalProfile?.above?.[0] || 'air';
        const base = topBlock === 'air'
            ? 'You are mostly exposed to open sky.'
            : `You are partially covered by ${topBlock}.`;
        const hazardText = hazards.length ? `Hazards: ${hazards.join('; ')}.` : 'No immediate terrain hazards detected.';
        const resourceText = resources.length ? `Nearby resources: ${resources.join(', ')}.` : 'No notable resources in short range.';
        return `${base} ${hazardText} ${resourceText}`;
    }

    getCurrentBiome() {
        const pos = this.bot.entity.position;
        const block = this.bot.blockAt(pos);
        if (!block || !block.biome) return 'unknown';
        // block.biome only contains an id and partial metadata in 1.20.4;
        // the human-readable name lives in bot.registry.biomes[id].
        const biomeId = block.biome.id;
        const registryEntry = this.bot.registry?.biomes?.[biomeId];
        if (registryEntry) {
            return registryEntry.name || registryEntry.displayName || 'unknown';
        }
        return block.biome.name || block.biome.displayName || String(block.biome) || 'unknown';
    }

    /**
     * Get minimal observation for logging
     */
    getMinimalObservation() {
        return {
            timestamp: Date.now(),
            position: this.getPosition(),
            health: this.bot.health,
            food: this.bot.food,
            nearbyMobs: this.getNearbyEntities(16).mobs.length,
            inventoryItems: this.bot.inventory.items().length
        };
    }
}

module.exports = ObservationSystem;
