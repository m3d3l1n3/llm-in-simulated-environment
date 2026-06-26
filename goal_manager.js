/**
 * Goal Manager
 * Maintains strategic progression across loops (tech tiers + active plans).
 */
class GoalManager {
    constructor() {
        this.tiers = ['naked', 'wood_tools', 'stone_tools', 'iron_tools', 'shelter', 'established'];
        this.currentTier = 'naked';
        this.highestTierReached = null;
        this.activePlan = null;
        this.planSinceLoop = 0;
        this.goalHistory = [];
        this.lastCompletedTier = null;
    }

    /**
     * Return the higher-indexed tier of the two.
     */
    maxTier(a, b) {
        if (!a) return b;
        if (!b) return a;
        const idxA = this.tiers.indexOf(a);
        const idxB = this.tiers.indexOf(b);
        if (idxA < 0) return b;
        if (idxB < 0) return a;
        return this.tiers[Math.max(idxA, idxB)];
    }

    updateFromObservation(observation, loopCount = 0) {
        const inv = observation?.inventory?.slots || [];
        const has = (name) => inv.some(i => i && i.name === name);
        const count = (name) => inv.filter(i => i && i.name === name).reduce((sum, i) => sum + i.count, 0);
        const hasAny = (needle) => inv.some(i => i && i.name.includes(needle));

        const hasCraftingTableAccess = has('crafting_table') || !!observation?.environment?.nearbyCraftingTable;
        const flags = {
            hasLogs: inv.some(i => i && i.name.includes('_log')),
            hasPlanks: inv.some(i => i && i.name.includes('_planks')),
            hasSticks: has('stick') || count('stick') >= 2,
            hasCraftingTable: hasCraftingTableAccess,
            hasWoodAxe: has('wooden_axe'),
            hasWoodPickaxe: has('wooden_pickaxe'),
            hasStoneAxe: has('stone_axe'),
            hasStonePickaxe: has('stone_pickaxe'),
            hasIronPickaxe: has('iron_pickaxe'),
            hasFurnace: has('furnace'),
            hasCoal: has('coal') || has('charcoal'),
            hasIronOre: has('iron_ore') || has('raw_iron'),
            hasIronIngot: has('iron_ingot'),
            hasShelterMaterial: inv.some(i => i && (
                i.name.includes('planks') || i.name.includes('cobblestone') || i.name === 'dirt'
            )) && inv.reduce((sum, i) => sum + ((i?.name?.includes('planks') || i?.name === 'cobblestone' || i?.name === 'dirt') ? i.count : 0), 0) >= 20,
            hasBed: hasAny('_bed')
        };

        const computedTier = this.computeTier(flags);
        const prevTier = this.currentTier;
        this.currentTier = computedTier;
        this.highestTierReached = this.maxTier(this.highestTierReached, computedTier);
        if (this.currentTier !== prevTier) {
            this.lastCompletedTier = prevTier;
        }

        const advanced = this.tiers.indexOf(this.currentTier) > this.tiers.indexOf(prevTier);

        return {
            currentTier: this.currentTier,
            previousTier: prevTier,
            progressed: this.currentTier !== prevTier,
            advanced,
            checklist: this.getChecklist(flags)
        };
    }

    computeTier(flags) {
        if (flags.hasIronPickaxe || (flags.hasIronIngot && flags.hasFurnace && flags.hasCoal)) return 'iron_tools';
        if (flags.hasStonePickaxe && flags.hasStoneAxe) return 'stone_tools';
        if (flags.hasWoodPickaxe && flags.hasWoodAxe && flags.hasCraftingTable) return 'wood_tools';
        if (flags.hasBed || flags.hasShelterMaterial) return 'shelter';
        return 'naked';
    }

    getChecklist(flags) {
        return {
            wood_tools: [
                { id: 'get_logs', done: flags.hasLogs },
                { id: 'craft_planks', done: flags.hasPlanks },
                { id: 'craft_sticks', done: flags.hasSticks },
                { id: 'craft_table', done: flags.hasCraftingTable },
                { id: 'craft_wood_axe', done: flags.hasWoodAxe },
                { id: 'craft_wood_pickaxe', done: flags.hasWoodPickaxe }
            ],
            stone_tools: [
                { id: 'mine_cobble', done: flags.hasStonePickaxe || flags.hasStoneAxe },
                { id: 'craft_stone_axe', done: flags.hasStoneAxe },
                { id: 'craft_stone_pickaxe', done: flags.hasStonePickaxe }
            ],
            iron_tools: [
                { id: 'get_furnace', done: flags.hasFurnace },
                { id: 'get_coal', done: flags.hasCoal },
                { id: 'mine_iron', done: flags.hasIronOre || flags.hasIronIngot },
                { id: 'smelt_iron', done: flags.hasIronIngot },
                { id: 'craft_iron_pickaxe', done: flags.hasIronPickaxe }
            ],
            shelter: [
                { id: 'collect_blocks', done: flags.hasShelterMaterial },
                { id: 'get_bed', done: flags.hasBed }
            ]
        };
    }

    inferMissingForNextMilestone(observation) {
        const inv = observation?.inventory?.slots || [];
        const names = new Set(inv.map(i => i?.name).filter(Boolean));
        const hasCraftingTableAccess = names.has('crafting_table') || !!observation?.environment?.nearbyCraftingTable;
        const missing = [];
        if (!names.has('stone_pickaxe')) {
            if (![...names].some(n => n.includes('_log'))) missing.push('logs');
            if (![...names].some(n => n.includes('_planks'))) missing.push('planks');
            if (!names.has('stick')) missing.push('sticks');
            if (!hasCraftingTableAccess) missing.push('crafting_table');
            if (!names.has('wooden_pickaxe')) missing.push('wooden_pickaxe');
            if (!names.has('cobblestone')) missing.push('cobblestone');
        } else if (!names.has('iron_pickaxe')) {
            const hasBed = [...names].some(n => n.includes('_bed'));
            if (!hasBed) {
                const woolCount = inv.filter(i => i && i.name && i.name.includes('wool')).reduce((s, i) => s + i.count, 0);
                if (woolCount < 3) missing.push('wool (kill sheep)');
                if (![...names].some(n => n.includes('_planks'))) missing.push('planks');
                missing.push('bed');
            }
            if (!names.has('furnace')) missing.push('furnace');
            if (!names.has('coal') && !names.has('charcoal')) missing.push('coal');
            if (!names.has('iron_ore') && !names.has('raw_iron') && !names.has('iron_ingot')) missing.push('iron_ore');
            if (!names.has('iron_ingot')) missing.push('iron_ingot');
        } else {
            if (![...names].some(n => n.includes('_bed'))) missing.push('bed');
            const blockCount = inv
                .filter(i => i && (i.name.includes('planks') || i.name === 'cobblestone' || i.name === 'dirt'))
                .reduce((sum, i) => sum + i.count, 0);
            if (blockCount < 20) missing.push('shelter_blocks');
        }
        return missing;
    }

    recordDecision(decision, loopCount = 0, isGuard = false) {
        const goal = decision?.goal || 'unknown';
        const reasoning = decision?.reasoning || '';
        this.goalHistory.push({ goal, reasoning, isGuard, loopCount, timestamp: Date.now() });
        if (this.goalHistory.length > 30) this.goalHistory.shift();

        if (goal && goal !== 'unknown') {
            if (this.activePlan !== goal) {
                this.activePlan = goal;
                this.planSinceLoop = loopCount;
            }
        }
    }

    getThrashSignal() {
        const recent = this.goalHistory.slice(-8).map(g => g.goal);
        if (recent.length < 6) return null;

        // Detect oscillation: A→B→A→B pattern (actual thrashing)
        let oscillationCount = 0;
        for (let i = 2; i < recent.length; i++) {
            if (recent[i] === recent[i - 2] && recent[i] !== recent[i - 1]) {
                oscillationCount++;
            }
        }

        // Detect revisits: a goal returns after at least 1 different goal
        let revisitCount = 0;
        for (let i = 1; i < recent.length; i++) {
            const prev = recent.slice(0, i);
            if (prev.includes(recent[i]) && recent[i - 1] !== recent[i]) {
                revisitCount++;
            }
        }

        // Sequential progression (A→B→C→D→E→F) produces 0 oscillations and 0 revisits.
        // Only flag as thrashing when there's actual back-and-forth.
        if (oscillationCount >= 2 || revisitCount >= 3) {
            return {
                isThrashing: true,
                message: 'Goal thrashing detected. Commit to one multi-step objective for at least 3 loops.'
            };
        }
        return { isThrashing: false };
    }

    getContext(observation, loopCount = 0) {
        const missing = this.inferMissingForNextMilestone(observation);
        const inv = observation?.inventory?.slots || [];
        const hasBed = inv.some(i => i && i.name && i.name.includes('_bed'));

        let nextMilestone;
        if (this.currentTier === 'naked' || this.currentTier === 'wood_tools') {
            nextMilestone = 'stone_tools';
        } else if (this.currentTier === 'stone_tools') {
            nextMilestone = hasBed ? 'iron_tools' : 'bed_and_shelter';
        } else {
            nextMilestone = 'iron_tools';
        }

        return {
            currentTier: this.currentTier,
            nextMilestone,
            missing,
            activePlan: this.activePlan,
            planAgeLoops: this.activePlan ? Math.max(0, loopCount - this.planSinceLoop) : 0,
            thrash: this.getThrashSignal()
        };
    }

    exportState() {
        return {
            currentTier: this.currentTier,
            highestTierReached: this.highestTierReached,
            activePlan: this.activePlan,
            planSinceLoop: this.planSinceLoop,
            goalHistory: this.goalHistory,
            lastCompletedTier: this.lastCompletedTier
        };
    }

    importState(state) {
        if (!state || typeof state !== 'object') return;
        this.currentTier = state.currentTier || this.currentTier;
        this.highestTierReached = state.highestTierReached || this.currentTier;
        this.activePlan = state.activePlan || null;
        this.planSinceLoop = state.planSinceLoop || 0;
        this.goalHistory = Array.isArray(state.goalHistory) ? state.goalHistory.slice(-30) : [];
        this.lastCompletedTier = state.lastCompletedTier || null;
    }

    /**
     * Restore the highest tier the bot had before death from MemoryManager achievements.
     * Called on respawn so the bot doesn't re-bootstrap from naked when it already had tools.
     */
    importFromAchievements(achievements) {
        if (!Array.isArray(achievements) || achievements.length === 0) return;
        if (achievements.includes('reached_iron_tier')) {
            this.currentTier = 'iron_tools';
        } else if (achievements.includes('reached_stone_tier')) {
            this.currentTier = 'stone_tools';
        } else if (achievements.includes('crafted_wooden_pickaxe')) {
            this.currentTier = 'wood_tools';
        }
        this.highestTierReached = this.currentTier;
        // shelter/established tiers are inventory-derived and will self-correct next observation
    }
}

module.exports = GoalManager;
