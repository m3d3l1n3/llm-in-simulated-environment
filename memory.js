/**
 * Persistent memory for long-horizon behavior.
 * Stores notable locations, milestones, and compact summaries.
 */
class MemoryManager {
    constructor() {
        this.knownLocations = {};
        this.achievements = [];
        this.loopSnapshots = [];
        this.recentSummaries = [];
        this.deathContext = null;
        this.lastSummaryLoop = 0;
    }

    updateFromObservation(observation, loopCount = 0) {
        if (!observation) return;
        const pos = observation.player?.position || { x: 0, y: 0, z: 0 };
        const resources = observation.blocks?.resources || {};
        const inv = observation.inventory?.slots || [];

        Object.entries(resources).forEach(([name, info]) => {
            if (info?.found && info?.position) {
                this.knownLocations[name] = {
                    x: info.position.x,
                    y: info.position.y,
                    z: info.position.z,
                    distance: info.distance,
                    tick: observation.tick || 0,
                    seenAt: Date.now()
                };
            }
        });

        // Keep known hazards separately
        if (resources.water?.found && resources.water.position) {
            this.knownLocations.water_hazard = {
                ...resources.water.position,
                distance: resources.water.distance,
                seenAt: Date.now()
            };
        }

        this.updateAchievements(inv);
        this.loopSnapshots.push({
            loop: loopCount,
            position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            health: observation.player?.health,
            food: observation.player?.food,
            inventoryTotal: observation.inventory?.totalItems || 0,
            mobs: observation.entities?.mobs?.length || 0
        });
        if (this.loopSnapshots.length > 30) this.loopSnapshots.shift();

        if (loopCount - this.lastSummaryLoop >= 10) {
            this.recentSummaries.push(this.buildRecentSummary());
            this.lastSummaryLoop = loopCount;
        }
        if (this.recentSummaries.length > 8) this.recentSummaries.shift();
    }

    updateAchievements(inv) {
        const names = new Set(inv.map(i => i?.name).filter(Boolean));
        const unlock = (id) => {
            if (!this.achievements.includes(id)) this.achievements.push(id);
        };
        if (names.has('wooden_pickaxe')) unlock('crafted_wooden_pickaxe');
        if (names.has('stone_pickaxe')) unlock('reached_stone_tier');
        if (names.has('iron_pickaxe')) unlock('reached_iron_tier');
        if (names.has('furnace')) unlock('crafted_furnace');
        if ([...names].some(n => n.includes('_bed'))) unlock('crafted_bed');
    }

    /**
     * Remove known locations where the expected block no longer exists.
     * Called by agent.js each loop — keeps knownLocations reliable for pathfinding.
     */
    pruneStaleLocations(bot) {
        if (!bot || !bot.blockAt) return;
        const mcData = require('minecraft-data')(bot.version);

        const resourceToBlock = {
            oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log',
            jungle_log: 'jungle_log', acacia_log: 'acacia_log', dark_oak_log: 'dark_oak_log',
            stone: 'stone', cobblestone: 'cobblestone',
            coal_ore: 'coal_ore', iron_ore: 'iron_ore', copper_ore: 'copper_ore',
            crafting_table: 'crafting_table', furnace: 'furnace',
            chest: 'chest', shelter: null, water_hazard: null
        };

        for (const [key, expectedBlock] of Object.entries(resourceToBlock)) {
            if (!this.knownLocations[key]) continue;
            if (!expectedBlock) continue; // shelter/water_hazard: no single block to check
            const loc = this.knownLocations[key];
            const { Vec3 } = require('vec3');
            try {
                const block = bot.blockAt(new Vec3(loc.x, loc.y, loc.z));
                if (block === null) {
                    // Chunk not loaded — leave entry intact, don't assume it's gone
                    continue;
                }
                if (block.name !== expectedBlock) {
                    delete this.knownLocations[key];
                }
            } catch (e) {
                // chunk not loaded — leave entry intact
            }
        }
    }

    recordShelter(position) {
        if (!position) return;
        this.knownLocations.shelter = {
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z),
            seenAt: Date.now()
        };
        if (!this.achievements.includes('built_first_shelter')) {
            this.achievements.push('built_first_shelter');
        }
    }

    recordDeathContext(observation, lastDecision, lastActions) {
        const hostileNames = [
            'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'drowned',
            'pillager', 'vindicator', 'ravager', 'evoker', 'vex', 'phantom',
            'husk', 'stray', 'blaze', 'enderman', 'slime', 'warden',
            'piglin_brute', 'hoglin', 'zoglin', 'ghast', 'magma_cube', 'wither_skeleton'
        ];
        const nearbyHostiles = (observation?.entities?.mobs || [])
            .filter(m => hostileNames.includes(m.name))
            .map(m => m.name);

        const inWater = observation?.player?.isInWater || false;
        const oxygen = observation?.player?.oxygen ?? 20;
        let causeHint = 'unknown';
        if (inWater && oxygen <= 2) causeHint = 'drowned';
        else if (nearbyHostiles.length > 0) causeHint = `killed by mobs (${[...new Set(nearbyHostiles)].join(', ')})`;

        this.deathContext = {
            at: Date.now(),
            position: observation?.player?.position || null,
            health: observation?.player?.health,
            food: observation?.player?.food,
            inWater,
            causeHint,
            nearbyHostiles: [...new Set(nearbyHostiles)],
            decision: lastDecision || null,
            actions: Array.isArray(lastActions) ? lastActions.slice(-5) : []
        };
    }

    buildRecentSummary() {
        const snaps = this.loopSnapshots.slice(-10);
        if (!snaps.length) return 'No recent activity yet.';
        const first = snaps[0];
        const last = snaps[snaps.length - 1];
        const deltaItems = last.inventoryTotal - first.inventoryTotal;
        const avgMobs = Math.round(snaps.reduce((sum, s) => sum + s.mobs, 0) / snaps.length);
        return `Last ${snaps.length} loops: moved from (${first.position.x}, ${first.position.y}, ${first.position.z}) to (${last.position.x}, ${last.position.y}, ${last.position.z}); inventory delta ${deltaItems >= 0 ? '+' : ''}${deltaItems}; avg nearby mobs ${avgMobs}.`;
    }

    getSummary() {
        const recentSummary = this.recentSummaries[this.recentSummaries.length - 1] || this.buildRecentSummary();
        const topLocations = Object.entries(this.knownLocations)
            .slice(0, 5)
            .map(([k, v]) => `${k}@(${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)})`);
        return {
            recentSummary,
            achievements: this.achievements.slice(-8),
            knownLocations: topLocations,
            deathContext: this.deathContext
                ? {
                    position: this.deathContext.position,
                    inWater: this.deathContext.inWater,
                    causeHint: this.deathContext.causeHint || 'unknown',
                    at: this.deathContext.at
                }
                : null
        };
    }

    exportState() {
        return {
            knownLocations: this.knownLocations,
            achievements: this.achievements,
            recentSummaries: this.recentSummaries,
            deathContext: this.deathContext
        };
    }

    importState(state) {
        if (!state || typeof state !== 'object') return;
        this.knownLocations = state.knownLocations || {};
        this.achievements = Array.isArray(state.achievements) ? state.achievements : [];
        this.recentSummaries = Array.isArray(state.recentSummaries) ? state.recentSummaries.slice(-8) : [];
        this.deathContext = state.deathContext || null;
    }
}

module.exports = MemoryManager;
