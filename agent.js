/**
 * LLM Agent Runtime
 * Implements the bounded decision loop for autonomous LLM behavior
 */

const LoggingSystem = require('./logging');
const LLMInterface = require('./llm');
const GoalManager = require('./goal_manager');
const MemoryManager = require('./memory');
const fs = require('fs');
const path = require('path');

class AgentRuntime {
    constructor(bot, observationSystem, actionSystem, config = {}) {
        this.bot = bot;
        this.observation = observationSystem;
        this.action = actionSystem;
        
        // Configuration
        this.config = {
            loopInterval: config.loopInterval || 5000, // ms between decision loops
            maxActionsPerLoop: config.maxActionsPerLoop || 3,
            logToFile: config.logToFile || true,
            logDirectory: config.logDirectory || './runs',
            runName: config.runName || null,
            llm: config.llm || { provider: 'none' },
            ...config
        };

        // Agent state
        this.memory = [];
        this.currentGoal = null;
        this.isRunning = false;
        this.loopCount = 0;
        this.eventLog = [];
        this.goalManager = new GoalManager();
        this.longMemory = new MemoryManager();
        this.recentActions = []; // Track recent action results for loop detection
        this.recentPositions = []; // Track positions to detect being stuck
        this.inventoryDisplayInterval = null;
        this.lastObservation = null;
        this.lastDecision = null;
        this.blockedActions = new Map();
        this.stuckLoopCount = 0;
        this.goalMetrics = {
            total: 0,
            achieved: 0,
            recent: []
        };
        this.lastStatePersistAt = 0;
        this.statePersistIntervalMs = config.statePersistIntervalMs || 60000;
        this.escapeCooldownUntilLoop = -1;
        this.escapeStrategyIndex = 0; // Rotate escape strategies on repeated stuck
        this.consecutiveSameGoal = 0;
        this.lastGoalName = null;
        this.waterEscapeCooldownUntil = -1; // Block explore after water escape
        this.drowningGuardCooldownUntil = -1; // Don't re-fire drowning guard immediately after swim_up
        this.rapidDamageCooldownUntil = -1; // Block explore after rapid damage
        this.lastDigShelterLoop = -1; // Track last successful dig_emergency_shelter to prevent repeated digging
        this.lastDigShelterPos = null; // Track position of dug shelter so we know if bot moved away
        this.lastBuildShelterPos = null; // Track position of built shelter so we know if bot is still inside
        this.waitInTreeLoopCount = 0; // Track consecutive wait_in_tree loops to force escape

        // Reactive danger interrupt system
        this.dangerState = {
            underAttack: false,
            lowHealth: false,
            rapidDamage: false,
            drowning: false,
            lastAttacker: null
        };
        this.interruptAction = false;
        this.recentHits = []; // timestamps of recent entityHurt events

        // Logging system
        this.logger = null;
        if (this.config.logToFile) {
            // Use provided run name as-is. Timestamp generation is the caller's responsibility
            // (run_experiment.js generates it once and reuses on respawn).
            const runName = this.config.runName || `run_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;
            
            this.logger = new LoggingSystem({
                baseDirectory: this.config.logDirectory,
                runName: runName
            });
        }
        
        // LLM interface
        this.llm = null;
        if (this.config.llm && this.config.llm.provider === 'heuristic') {
            try {
                const HeuristicEngine = require('./heuristic_engine');
                this.llm = new HeuristicEngine(this.config.llm);
                if (this.logger) {
                    this.llm.setLogger(this.logger);
                }
                console.log(`✓ Heuristic engine initialized`);
            } catch (error) {
                console.error(`❌ Failed to initialize heuristic engine: ${error.message}`);
                console.log('   Falling back to rule-based behavior');
            }
        } else if (this.config.llm && this.config.llm.provider !== 'none') {
            try {
                this.llm = new LLMInterface(this.config.llm);
                if (this.logger) {
                    this.llm.setLogger(this.logger);
                }
                console.log(`✓ LLM initialized: ${this.config.llm.provider} (${this.config.llm.model})`);
            } catch (error) {
                console.error(`❌ Failed to initialize LLM: ${error.message}`);
                console.log('   Falling back to rule-based behavior');
            }
        }
        
        // Setup event tracking
        this.setupEventTracking();

        // Wire danger interrupt callback into action system
        this.action.shouldInterrupt = () => this.interruptAction;
        
        // Setup inventory display for spectators
        this.setupInventoryDisplay();
    }
    
    /**
     * Setup periodic inventory display in game chat for spectators
     */
    setupInventoryDisplay() {
        const interval = this.config.inventoryDisplayInterval || 15000;
        if (interval <= 0) return;
        
        this.inventoryDisplayInterval = setInterval(() => {
            if (!this.bot || !this.isRunning) return;
            
            try {
                const inv = this.action.getInventory();
                const items = [];
                
                // Collect items with counts
                if (inv && inv.items) {
                    for (const item of inv.items) {
                        items.push({ name: item.name, count: item.count });
                    }
                }
                
                if (items.length > 0) {
                    // Sort by count descending
                    items.sort((a, b) => b.count - a.count);
                    
                    // Format display - show top 6 items
                    const display = items.slice(0, 6)
                        .map(i => `${i.name.replace('minecraft:', '')}x${i.count}`)
                        .join(', ');
                    const more = items.length > 6 ? ` +${items.length - 6}` : '';
                    
                    // Get equipped hand item - use heldItem from getInventory or direct from bot
                    let handItem = 'empty';
                    if (inv.heldItem && inv.heldItem.name) {
                        handItem = inv.heldItem.name.replace('minecraft:', '');
                    } else if (this.bot.heldItem && this.bot.heldItem.name) {
                        handItem = this.bot.heldItem.name.replace('minecraft:', '');
                    }
                    
                    // Send to chat with hand item
                    this.bot.chat(`☆ [${handItem}] ${display}${more}`);
                } else {
                    this.bot.chat(`📦 Inventory empty`);
                }
            } catch (e) {
                // Silently ignore errors
            }
        }, interval);
    }

    setupEventTracking() {
        // Store handler references so we can remove them on stop() — prevents
        // duplicate death handlers from old runtimes corrupting logger state.
        this._eventHandlers = {};

        // Track important events for observations
        this._eventHandlers.playerCollect = (collector, collected) => {
            this.logEvent('ITEM_COLLECTED', {
                collector: collector.username,
                item: collected.metadata ? collected.metadata[8] : 'unknown'
            });
        };

        this._eventHandlers.entityHurt = (entity, source) => {
            if (entity === this.bot.entity) {
                const health = this.bot.health;
                const sourceName = source?.name || null;
                const isEntityAttack = !!sourceName; // 1.20+ damage_event provides source cause

                this.logEvent('BOT_HURT', {
                    health,
                    source: sourceName || 'environmental',
                    position: this.bot.entity.position
                });

                // Always track low health regardless of damage cause.
                this.dangerState.lowHealth = health <= 8;

                if (!isEntityAttack) {
                    // Environmental damage (starvation, fall, cactus, fire, suffocation) should not
                    // trigger the combat flee guard or action interrupts. Drowning is handled by the
                    // breath event; general low-health response is handled by the starvation guard.
                    console.log(`ℹ️ Environmental damage ignored for combat: health=${health}`);
                    return;
                }

                // From here on we know a real entity dealt damage.
                this.dangerState.underAttack = true;
                this.dangerState.lastAttacker = sourceName;

                // Track rapid damage (3+ hits within 5 seconds)
                const now = Date.now();
                this.recentHits.push(now);
                this.recentHits = this.recentHits.filter(t => now - t < 5000);
                this.dangerState.rapidDamage = this.recentHits.length >= 3;

                // Interrupt running actions ONLY on meaningful hits. Skeletons, pillagers, ghasts
                // can hit from outside the visual range, so any hit from them is meaningful.
                const rangedAttackers = ['skeleton', 'stray', 'pillager', 'illusioner', 'ghast'];
                const isRangedAttacker = rangedAttackers.includes(sourceName.toLowerCase());
                const meaningfulHit = health <= 12 || this.recentHits.length >= 2 || this.dangerState.rapidDamage || isRangedAttacker;
                if (meaningfulHit) {
                    this.interruptAction = true;
                    console.log(`⚠️ DANGER INTERRUPT: hit by ${sourceName}, health=${health}, rapidHits=${this.recentHits.length}`);
                } else {
                    console.log(`ℹ️ Trivial hit ignored: hit by ${sourceName}, health=${health} (still safe)`);
                }

                // Block explore after rapid damage to prevent re-falling into the same hazard
                if (this.dangerState.rapidDamage) {
                    this.rapidDamageCooldownUntil = this.loopCount + 3;
                    console.log(`💥 Rapid damage detected — blocking explore until loop ${this.rapidDamageCooldownUntil}`);
                }
            }
        };

        // Drowning interrupt: fires when oxygen changes.
        // Gate on isInWater — oxygen ticks back up slowly after surfacing; we must not
        // interrupt dry-land actions during the recovery phase.
        this._inlineSwimRunning = false;
        this._eventHandlers.breath = () => {
            if (this.bot.oxygenLevel <= 5 && this.bot.entity.isInWater === true) {
                this.dangerState.drowning = true;
                this.interruptAction = true;
                console.log(`⚠️ DROWNING INTERRUPT: oxygen=${this.bot.oxygenLevel}`);
                // IMMEDIATE INLINE SWIM: don't wait for next 5s loop — execute now
                if (!this._inlineSwimRunning && this.action?.swimUp) {
                    this._inlineSwimRunning = true;
                    this.action.swimUp().catch(e => {
                        console.log(`Inline swim error: ${e.message}`);
                    }).finally(() => {
                        this._inlineSwimRunning = false;
                    });
                }
            }
        };

        this._eventHandlers.death = () => {
            // Debounce: mineflayer may emit 'death' multiple times in rapid succession
            if (this._lastDeathLoggedAt && Date.now() - this._lastDeathLoggedAt < 5000) {
                return;
            }
            this._lastDeathLoggedAt = Date.now();

            const deathData = {
                position: this.bot.entity.position,
                loopCount: this.loopCount,
                lastGoal: this.currentGoal
            };
            
            this.logEvent('BOT_DEATH', deathData);
            
            // Note: log rotation is handled by run_experiment.js on respawn via
            // deathRecovery: true. Do NOT call rotateOnDeath() here — it would
            // create a life folder that gets orphaned when the old runtime is
            // stopped and a new runtime initializes with deathRecovery.
            
            this.longMemory.recordDeathContext(this.lastObservation, this.lastDecision, this.recentActions);

            // Clear action history so bot starts fresh
            this.recentActions = [];
            this.recentPositions = [];
            this.memory = [];
            this.lastDigShelterLoop = -1; // Reset shelter tracking so bot can dig again after respawn
            this.lastDigShelterPos = null;
            this.lastBuildShelterPos = null;
            this.waitInTreeLoopCount = 0;
            this.goalManager = new GoalManager();
            // Restore tier from cross-death achievements so the bot doesn't re-bootstrap
            // from naked when it already earned stone/iron tools before dying.
            this.goalManager.importFromAchievements(this.longMemory.achievements);
            this.escapeCooldownUntilLoop = -1;
            this.escapeStrategyIndex = 0;
            this.stuckLoopCount = 0;
            this.interruptAction = false;
            this.dangerState = { underAttack: false, lowHealth: false, rapidDamage: false, drowning: false, lastAttacker: null };
            this.recentHits = [];
            this.consecutiveSameGoal = 0;
            this.lastGoalName = null;
            this.blockedActions = new Map();
            this.drowningGuardCooldownUntil = -1;
            this.waterEscapeCooldownUntil = -1;
            this.rapidDamageCooldownUntil = -1;
        };

        this._eventHandlers.spawn = () => {
            this.logEvent('BOT_SPAWN', {
                position: this.bot.entity.position
            });
        };

        this._eventHandlers.chat = (username, message) => {
            if (username !== this.bot.username) {
                this.logEvent('CHAT_RECEIVED', {
                    username: username,
                    message: message
                });
            }
        };

        // Register all handlers on the bot
        for (const [event, handler] of Object.entries(this._eventHandlers)) {
            this.bot.on(event, handler);
        }
    }

    logEvent(eventType, data) {
        const event = {
            timestamp: Date.now(),
            tick: this.bot.time.age || 0,
            type: eventType,
            data: data
        };
        this.eventLog.push(event);
        
        // Log to file system
        if (this.logger) {
            this.logger.logEvent(eventType, data);
        }
        
        // Keep only last 50 events in memory
        if (this.eventLog.length > 50) {
            this.eventLog.shift();
        }
    }

    /**
     * Main decision loop - MANDATORY STRUCTURE
     * 1. Observe (structured state)
     * 2. Update memory
     * 3. Decide one goal
     * 4. Execute 1-5 actions
     * 5. Log outcome
     * 6. Repeat
     */
    async startLoop(metadata = {}) {
        this.isRunning = true;
        
        // Initialize logging system
        if (this.logger) {
            this.logger.initializeRun({
                minecraftVersion: '1.20.4',
                mineflayerVersion: require('mineflayer/package.json').version,
                seed: metadata.seed || '-1613247987266390429',
                actionSet: [
                    'move', 'look', 'break', 'place', 'craft', 'use',
                    'gather', 'go_to', 'eat', 'sleep'
                ],
                ...metadata
            });
            
            const safeConfig = {
                ...this.config,
                llm: { ...this.config.llm, apiKey: '***REDACTED***' }
            };
            this.logEvent('RUN_START', {
                config: safeConfig,
                metadata: metadata
            });
            this.loadRuntimeStateIfPresent();
        }
        
        console.log('Agent runtime started');
        
        while (this.isRunning) {
            try {
                await this.executeDecisionStep();
                await this.persistRuntimeStateIfNeeded();
                await this.sleep(this.config.loopInterval);
            } catch (error) {
                console.error('Error in decision loop:', error);
                this.logEvent('LOOP_ERROR', { error: error.message, stack: error.stack });
                await this.sleep(this.config.loopInterval);
            }
        }
    }

    async executeDecisionStep() {
        if (!this.isRunning) {
            console.log('⚠️  Aborting decision step: runtime stopped');
            return;
        }
        this.loopCount++;
        const stepLog = {
            step: this.loopCount,
            timestamp: Date.now(),
            tick: this.bot.time.age || 0
        };

        // Reset transient danger flags (persistent ones like lowHealth are re-evaluated each loop).
        // underAttack is reset after guard check so the combat guard can see it.
        this.dangerState.rapidDamage = false;
        
        // Expire old hits so combat guard doesn't fire forever on a single ancient arrow
        const now = Date.now();
        this.recentHits = this.recentHits.filter(t => now - t < 5000);
        if (this.recentHits.length === 0) {
            this.dangerState.lastAttacker = null;
        }
        
        // Update position tracking EVERY loop, even when guards fire, so escape_trap
        // can detect being stuck after guard-driven displacement (e.g. drowning escape).
        const currentPos = this.bot.entity?.position;
        if (currentPos) {
            this.recentPositions.push({
                x: Math.floor(currentPos.x),
                y: Math.floor(currentPos.y),
                z: Math.floor(currentPos.z),
                timestamp: now
            });
            if (this.recentPositions.length > 10) {
                this.recentPositions.shift();
            }
        }

        console.log(`\n===== Decision Step ${this.loopCount} =====`);

        // 0. Clear leaves only when bot is actually inside leaves (avoid breaking leaves every step when in the open)
        try {
            const headBlock = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
            const feetBlock = this.bot.blockAt(this.bot.entity.position.floored());
            const inLeaves = (headBlock && headBlock.name && headBlock.name.includes('leaves')) ||
                (feetBlock && feetBlock.name && feetBlock.name.includes('leaves'));
            if (inLeaves) {
                const leavesCleared = await this.action.clearSurroundingLeaves();
                if (!this.isRunning) return;
                if (leavesCleared > 0) {
                    console.log(`Cleared ${leavesCleared} leaves (was in leaves)`);
                    await this.sleep(300);
                }
            }
        } catch (e) {
            // Ignore errors - just a helper
        }

        // 1. OBSERVE
        const obs = this.observation.getStructuredObservation();
        this.lastObservation = obs;
        obs.recentEvents = this.getRecentEvents();
        stepLog.observation = obs;
        
        // Log observation
        if (this.logger) {
            this.logger.logObservation(obs);
        }
        
        console.log('Observation:', {
            position: obs.player.position,
            health: obs.player.health,
            food: obs.player.food,
            nearby_mobs: obs.entities.mobs.length > 0 ? obs.entities.mobs.map(m => `${m.name}(${Math.floor(m.distance)}m)`).join(', ') : 'none',
            nearby_players: obs.entities.players.length > 0 ? obs.entities.players.map(p => p.name).join(', ') : 'none',
            inventory_items: obs.inventory.totalItems,
            inventory_slots: obs.inventory.slots.map(s => `${s.name}x${s.count}`).join(', ') || 'empty',
            nearby_resources: obs.blocks.resources ? Object.keys(obs.blocks.resources).filter(k => obs.blocks.resources[k].found).join(', ') : 'none'
        });

        // 2. UPDATE MEMORY
        this.updateMemory(obs);
        this.longMemory.pruneStaleLocations(this.bot);
        const goalState = this.goalManager.updateFromObservation(obs, this.loopCount);
        if (goalState.advanced && goalState.currentTier && goalState.currentTier !== 'naked') {
            this.logger?.recordGoalCompletion(goalState.currentTier);
        }
        this.longMemory.updateFromObservation(obs, this.loopCount);
        stepLog.memorySize = this.memory.length;
        stepLog.goalState = goalState;

        // Behavior guard: resource caps and forced recovery if severely stuck.
        const guardDecision = this.applyBehaviorGuards(obs);
        if (guardDecision) {
            const guardActions = this.filterBlockedActions(guardDecision.actions);
            if (guardActions.length === 0) {
                console.log(`⚡ Guard ${guardDecision.goal} actions all blocked, falling through to LLM`);
            } else {
                guardDecision.actions = guardActions;
                console.log(`⚡ Behavior guard: ${guardDecision.goal} (LLM skipped this step)`);
                this.trackGoalRepetition(guardDecision.goal);
                if (guardDecision.goal === 'escape_trap' || guardDecision.goal === 'forced_recovery') {
                    this.escapeCooldownUntilLoop = this.loopCount + 3;
                }
                // Log guard decision to goals.jsonl so it appears in the dataset
                if (this.logger) {
                    this.logger.logGoal({ ...guardDecision, isGuard: true, guardType: guardDecision.goal });
                }
                this.goalManager.recordDecision(guardDecision, this.loopCount, true);
                const actionResults = await this.executeActions(guardDecision.actions, guardDecision.goal);
                if (!this.isRunning) return;

                // If dig_to_surface was used but barely moved (rose < 3), keep stuckLoopCount elevated
                // so the oscillation loop (dig → LLM mines ore → path fail → dig → ...) doesn't reset
                const digResult = actionResults.find(r => r.action === 'dig_to_surface')?.result;
                if (digResult && (digResult.rose ?? 99) < 3) {
                    this.stuckLoopCount += 2;
                }

                // Track cooldowns for shelter actions (works for both guard + LLM decisions)
                this.trackActionCooldowns(actionResults);

                // If escape_trap or forced_recovery fired, we're actively trying to get unstuck —
                // clear shelter tracking so we don't consider ourselves "sheltered" in a dug pit.
                if (guardDecision.goal === 'escape_trap' || guardDecision.goal === 'forced_recovery') {
                    this.lastDigShelterPos = null;
                    this.lastBuildShelterPos = null;
                }

                stepLog.decision = guardDecision;
                stepLog.actions = actionResults;
                this.updateGoalMetrics(guardDecision, obs, actionResults);
                this.updateBehaviorStats(actionResults);
                this.logDecisionStep(stepLog);
                return stepLog;
            }
        }

        // Check for goal thrashing and log explicitly so it appears in events.json
        const thrashSignal = this.goalManager.getThrashSignal();
        if (thrashSignal?.isThrashing) {
            this.logEvent('GOAL_THRASH', {
                message: thrashSignal.message,
                recentGoals: this.goalManager.goalHistory.slice(-6).map(g => g.goal)
            });
        }

        // 3. DECIDE GOAL (This is where LLM integration would happen)
        const decision = await this.decideGoal(obs);
        if (!this.isRunning) return;
        decision.actions = this.filterBlockedActions(decision.actions || []);
        if (decision.actions.length === 0) {
            console.log('⚡ All LLM actions blocked or empty — using rule-based fallback');
            this.logEvent('BLOCKED_FALLBACK', { originalGoal: decision.goal, reason: 'all_actions_blocked' });
            const fallback = this.ruleBasedDecision(obs);
            fallback.actions = this.filterBlockedActions(fallback.actions || []);
            if (fallback.actions.length > 0) {
                decision.actions = fallback.actions;
                decision.reasoning = (decision.reasoning || '') + ' [Fallback: all previous actions were blocked. Using safe default.]';
            }
        }
        this.goalManager.recordDecision(decision, this.loopCount, false);
        this.trackGoalRepetition(decision.goal);
        this.lastDecision = decision;
        stepLog.decision = decision;
        
        // Log goal
        if (this.logger) {
            this.logger.logGoal(decision);
        }
        
        console.log('Decision:', decision);

        // 4. EXECUTE ACTIONS
        const actionResults = await this.executeActions(decision.actions, decision.goal);
        if (!this.isRunning) return;
        stepLog.actions = actionResults;
        this.updateGoalMetrics(decision, obs, actionResults);
        this.updateBehaviorStats(actionResults);
        console.log('Action Results:', actionResults.map(a => ({ 
            action: a.action, 
            success: a.success 
        })));

        // Track cooldowns for shelter actions (works for both guard + LLM decisions)
        this.trackActionCooldowns(actionResults);

        // 4b. DANGER RESPONSE: if an action was interrupted, run emergency survival actions
        const wasInterrupted = actionResults.some(a => a?.interrupted || a?.result?.interrupted);
        if (wasInterrupted && this.interruptAction) {
            console.log('🚨 Running emergency danger response...');
            this.logEvent('DANGER_RESPONSE', { dangerState: { ...this.dangerState }, health: this.bot.health });

            const emergencyActions = [];
            if (this.dangerState.drowning || this.bot.entity.isInWater) {
                // If swim_up has failed recently, dig_to_surface is more reliable
                const recentSwimFails = this.recentActions.slice(-3).filter(a =>
                    (a.action === 'swim_up' || a.action === 'swimUp') && !a.success
                ).length;
                if (recentSwimFails >= 2) {
                    emergencyActions.push({ name: 'dig_to_surface', params: {} });
                } else {
                    emergencyActions.push({ name: 'swim_up', params: {} });
                }
            } else {
                emergencyActions.push({ name: 'eat', params: {} });
                // Find nearest hostile to flee from
                const nearestHostile = this.bot.nearestEntity(e =>
                    e.name && this.action.isHostile({ name: e.name }) && e.position.distanceTo(this.bot.entity.position) < 16
                );
                if (nearestHostile) {
                    emergencyActions.push({ name: 'flee_from', params: { entity: nearestHostile.name } });
                }
            }
            const emergencyResults = await this.executeActions(emergencyActions);
            if (!this.isRunning) return;
            stepLog.emergencyActions = emergencyResults;

            // Reset interrupt flag after response (danger state reset below, outside this block)
            this.interruptAction = false;
        }

        // Reset danger state at end of every loop so it doesn't persist across loops
        // but WAS visible to the guard check above.
        this.dangerState = { underAttack: false, lowHealth: false, rapidDamage: false, drowning: false, lastAttacker: null };

        // 5. LOG OUTCOME
        this.logDecisionStep(stepLog);
        
        return stepLog;
    }

    updateMemory(observation) {
        this.memory.push({
            timestamp: Date.now(),
            observation: observation,
            goal: this.currentGoal
        });

        // Keep memory bounded (last 100 observations)
        if (this.memory.length > 100) {
            this.memory.shift();
        }
    }

    /**
     * Decide the next goal based on observations
     * This is where LLM integration happens
     */
    async decideGoal(observation) {
        // Position tracking moved to executeDecisionStep so it runs every loop
        // (including guard-fired loops), preventing stale position data.
        
        // Use LLM if available
        if (this.llm) {
            try {
                // Prepare context for LLM
                const context = {
                    recentGoals: this.memory.slice(-5).map(m => m.goal).filter(g => g),
                    recentEvents: this.getRecentEvents(5),
                    recentActions: this.recentActions.slice(-15),
                    recentPositions: this.recentPositions.slice(-5),
                    memorySize: this.memory.length,
                    strategicContext: this.goalManager.getContext(observation, this.loopCount),
                    memorySummary: this.longMemory.getSummary(),
                    loopCount: this.loopCount,
                    escapeCooldownUntilLoop: this.escapeCooldownUntilLoop,
                    blockedActions: Array.from(this.blockedActions.entries())
                        .filter(([, until]) => until > this.loopCount)
                        .map(([name]) => name),
                    goalHistory: this.goalManager.goalHistory.slice(-5)
                };

                console.log('🤖 Calling LLM for decision...');
                const decision = await this.llm.generateDecision(observation, context);
                console.log('✓ LLM decision received');
                return decision;
                
            } catch (error) {
                console.error(`❌ LLM decision failed: ${error.message}`);
                console.error('   Stack:', error.stack);
                console.log('   Using rule-based fallback');
                // Fall through to rule-based logic
            }
        } else {
            console.log('⚠️  No LLM configured, using rule-based logic');
        }

        // Rule-based fallback logic
        return this.ruleBasedDecision(observation);
    }

    /**
     * Rule-based decision making (fallback)
     */
    ruleBasedDecision(observation) {
        const decision = {
            goal: null,
            reasoning: '',
            actions: []
        };

        // Priority 1: Low health - eat
        if (observation.player.health < 15 || observation.player.food < 10) {
            decision.goal = 'restore_health';
            decision.reasoning = 'Health or food is low (rule-based)';
            decision.actions = [
                { name: 'eat', params: {} }
            ];
            return decision;
        }

        // Priority 2: Gather resources if few items in inventory
        if (observation.inventory.totalItems < 20) {
            // Find nearby resources to gather
            const resources = observation.blocks.resources || {};
            
            // Check for trees
            for (const key of Object.keys(resources)) {
                if (key.includes('_log') && resources[key].found) {
                    decision.goal = 'gather_wood';
                    decision.reasoning = 'Need resources, chopping nearby trees (rule-based)';
                    decision.actions = [
                        { name: 'chop_tree', params: { count: 3 } }
                    ];
                    return decision;
                }
            }
            
            // Check for stone
            if (resources.stone && resources.stone.found) {
                decision.goal = 'gather_stone';
                decision.reasoning = 'Need resources, mining nearby stone (rule-based)';
                decision.actions = [
                    { name: 'mine', params: { blockType: 'stone', count: 3 } }
                ];
                return decision;
            }
        }

        // Priority 3: Night time - find shelter or light
        if (observation.environment.timeOfDay > 13000 && observation.environment.timeOfDay < 23000) {
            decision.goal = 'seek_shelter';
            decision.reasoning = 'It is night time, moving to safe location (rule-based)';
            
            // Actually move somewhere instead of just chatting
            const safeX = Math.floor(observation.player.position.x) + (Math.random() * 30 - 15);
            const safeY = Math.floor(observation.player.position.y) + 2;
            const safeZ = Math.floor(observation.player.position.z) + (Math.random() * 30 - 15);
            
            decision.actions = [
                { name: 'move_to', params: { x: safeX, y: safeY, z: safeZ } }
            ];
            return decision;
        }

        // Priority 4: Explore
        const randomX = Math.floor(observation.player.position.x) + (Math.random() * 20 - 10);
        const randomY = Math.floor(observation.player.position.y);
        const randomZ = Math.floor(observation.player.position.z) + (Math.random() * 20 - 10);
        
        decision.goal = 'explore';
        decision.reasoning = 'No immediate threats, exploring the world (rule-based)';
        decision.actions = [
            { name: 'move_to', params: { x: randomX, y: randomY, z: randomZ } }
        ];

        return decision;
    }

    async executeActions(actions, goalName = null) {
        const results = [];
        const maxActions = Math.min(actions.length, this.config.maxActionsPerLoop);
        const ACTION_TIMEOUT_MS = 30000; // Hard cap: no single action may hang the loop

        for (let i = 0; i < maxActions; i++) {
            const action = actions[i];
            try {
                // Race the action against a hard timeout so a stuck bot.dig() or
                // pathfinder cannot stall the decision loop indefinitely.
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Action '${action.name}' timed out after ${ACTION_TIMEOUT_MS}ms`)), ACTION_TIMEOUT_MS)
                );
                const result = await Promise.race([
                    this.action.executeAction(action.name, action.params),
                    timeoutPromise
                ]);
                results.push(result);
                
                // Track action for loop detection
                const inner = result.result || result;
                this.recentActions.push({
                    action: action.name,
                    goal: goalName,
                    params: action.params,
                    success: result.success,
                    hint: result.hint || inner?.hint || null,
                    error: result.error || inner?.error || null,
                    interrupted: inner?.interrupted || result?.interrupted || false,
                    interruptReason: inner?.reason || result?.reason || null,
                    blocksCleared: inner?.blocksCleared ?? null,
                    timestamp: Date.now()
                });
                // Keep only last 10 actions
                if (this.recentActions.length > 10) {
                    this.recentActions.shift();
                }
                
                // Log action to file
                if (this.logger) {
                    this.logger.logAction(result);
                }

                // If action was interrupted by danger system, stop executing and handle danger
                if (inner?.interrupted || result?.interrupted) {
                    console.log(`⚠️ Action ${action.name} interrupted by danger system, aborting remaining actions`);
                    break;
                }

                // Track water escape success for cooldown
                if (action.name === 'swim_up' || action.name === 'swimUp') {
                    const rose = inner?.rose ?? (inner?.endY - inner?.startY) ?? 0;
                    const stillInWater = inner?.inWater ?? inner?.stillDrowning ?? false;
                    if (!stillInWater || rose > 2) {
                        this.waterEscapeCooldownUntil = this.loopCount + 3;
                        console.log(`🌊 Water escape succeeded — blocking explore until loop ${this.waterEscapeCooldownUntil}`);
                    }
                }
                
                // Stop executing if action failed critically
                if (!result.success && this.isCriticalAction(action.name)) {
                    break;
                }
            } catch (error) {
                results.push({
                    action: action.name,
                    success: false,
                    error: error.message
                });
            }
        }

        // If no action consumed the interrupt flag this loop, clear it so a stale
        // flag doesn't abort the first action of the next loop.
        const anyInterrupted = results.some(r => r?.interrupted || r?.result?.interrupted);
        if (!anyInterrupted) {
            this.interruptAction = false;
        }

        return results;
    }

    isCriticalAction(actionName) {
        return ['move_to', 'dig', 'place_block'].includes(actionName);
    }

    getRecentEvents(limit = 10) {
        return this.eventLog.slice(-limit);
    }

    logDecisionStep(stepLog) {
        // Console log
        console.log('Step completed:', {
            step: stepLog.step,
            goal: stepLog.decision?.goal,
            actions_executed: stepLog.actions?.length || 0,
            success_rate: this.calculateSuccessRate(stepLog.actions)
        });

        // File log (implement if config.logToFile is true)
        if (this.config.logToFile) {
            // TODO: Write to file
            // For now, just accumulate in memory
        }
    }

    filterBlockedActions(actions) {
        if (!Array.isArray(actions)) return [];
        const now = this.loopCount;
        // Survival-critical actions must never be blocked — they can mean life or death.
        // NOTE: dig_emergency_shelter is NOT in this list because it has a 15-loop cooldown
        // (set after each successful dig) to prevent staircase-to-bedrock death spirals.
        // The night guard still respects the cooldown via its own digShelterBlocked check.
        const neverBlock = ['swim_up', 'swimUp', 'surface', 'eat', 'flee_from', 'fleeFrom',
            'dig_to_surface', 'digToSurface',
            'break_around', 'breakAround', 'clear_path', 'clearPath'];
        return actions.filter(a => {
            if (neverBlock.includes(a.name)) return true;
            const until = this.blockedActions.get(a.name);
            if (!until) return true;
            return now >= until;
        });
    }

    updateBehaviorStats(actionResults) {
        const recent = this.recentActions.slice(-15);
        const byAction = {};
        recent.forEach(a => {
            byAction[a.action] = (byAction[a.action] || 0) + 1;
        });
        const total = recent.length || 1;
        Object.entries(byAction).forEach(([name, n]) => {
            if (n / total > 0.6) {
                this.logEvent('BEHAVIOR_WARNING', { type: 'action_dominance', action: name, ratio: n / total });
            }
        });

        const failures = recent.filter(a => !a.success);
        const failByAction = {};
        failures.forEach(a => {
            failByAction[a.action] = (failByAction[a.action] || 0) + 1;
        });
        Object.entries(failByAction).forEach(([name, n]) => {
            if (n >= 3) {
                // In autonomous mode, blocking should be minimal — the LLM needs to fail and retry to learn.
                // In guided mode, stronger blocking prevents scripted-progression loops.
                const blockDuration = this.config.llm?.autonomousMode ? 1 : 3;
                this.blockedActions.set(name, this.loopCount + blockDuration);
                this.logEvent('ACTION_BLOCKED', { action: name, blockedUntilLoop: this.loopCount + blockDuration });
            }
        });

        // If break_around/clear_path just ran and cleared nothing, block it for 3 loops so we try something else (chop_tree, explore)
        const lastAction = this.recentActions[this.recentActions.length - 1];
        const breakAroundNames = ['break_around', 'breakAround', 'clear_path', 'clearPath'];
        if (lastAction && breakAroundNames.includes(lastAction.action) && lastAction.success === false && (lastAction.blocksCleared === 0 || lastAction.hint?.includes('No blocks to clear'))) {
            const blockDuration = this.config.llm?.autonomousMode ? 1 : 3;
            breakAroundNames.forEach(n => this.blockedActions.set(n, this.loopCount + blockDuration));
            this.logEvent('ACTION_BLOCKED', { action: 'break_around', reason: 'cleared_nothing', blockedUntilLoop: this.loopCount + blockDuration });
        }

        // If chop_tree failed with path error, block it for 2 loops so we try craft/explore instead of repeating
        const pathErr = (a) => {
            const e = (a.error || '').toLowerCase();
            return e.includes('no path') || e.includes('failed to reach') || e.includes('no accessible') || e.includes('cannot reach');
        };
        if (lastAction && !lastAction.success && pathErr(lastAction) && (lastAction.action === 'chop_tree' || lastAction.action === 'chopTree')) {
            const blockDuration = this.config.llm?.autonomousMode ? 1 : 2;
            this.blockedActions.set('chop_tree', this.loopCount + blockDuration);
            this.blockedActions.set('chopTree', this.loopCount + blockDuration);
            this.logEvent('ACTION_BLOCKED', { action: 'chop_tree', reason: 'path_fail', blockedUntilLoop: this.loopCount + blockDuration });
        }

        const moved = this.recentPositions.length >= 2
            ? Math.abs(this.recentPositions[this.recentPositions.length - 1].x - this.recentPositions[this.recentPositions.length - 2].x) +
              Math.abs(this.recentPositions[this.recentPositions.length - 1].z - this.recentPositions[this.recentPositions.length - 2].z)
            : 1;
        const pathError = (r) => {
            const err = (r.error || r.result?.error || '').toLowerCase();
            return err.includes('no path') || err.includes('failed to reach') || err.includes('no accessible') || err.includes('truly stuck');
        };
        const hadPathFailure = actionResults.some(r => !r.success && pathError(r));
        const trulyStuck = actionResults.some(r => !r.success && (r.error || r.result?.error || '').toLowerCase().includes('truly stuck'));
        // Craft/inventory failures are not physical stuck situations — exclude them from stuckLoopCount
        // to avoid triggering break_around when a guard's craft action repeatedly fails.
        const craftActionNames = ['craft', 'ensure_crafted', 'ensureCrafted', 'smelt'];
        const allFailuresAreCraft = actionResults.length > 0 &&
            actionResults.every(r => !r.success && craftActionNames.includes(r.action));
        if (trulyStuck) {
            this.stuckLoopCount += 3; // Fast-track stuck escalation for truly stuck situations
        } else if (!allFailuresAreCraft && moved <= 1 && actionResults.every(r => !r.success)) {
            this.stuckLoopCount += hadPathFailure ? 2 : 1;
        } else if (hadPathFailure) {
            this.stuckLoopCount++;
        } else {
            this.stuckLoopCount = Math.max(0, this.stuckLoopCount - 1);
        }
    }

    /**
     * Track cooldowns for shelter-building actions after ANY action execution
     * (both guard-fired and LLM-decided). Prevents death spirals from repeated
     * build_shelter / dig_emergency_shelter calls.
     */
    trackActionCooldowns(actionResults) {
        // Track successful dig_emergency_shelter so we don't dig again immediately.
        // Record the BOTTOM of the pit (pos.y - depth) so isInDugShelter correctly
        // returns false once the bot climbs out.
        const digShelterResult = actionResults.find(r => r.action === 'dig_emergency_shelter')?.result;
        if (digShelterResult && digShelterResult.success) {
            this.lastDigShelterLoop = this.loopCount;
            const pos = this.bot?.entity?.position;
            const depth = digShelterResult.depth || 1;
            if (pos) {
                this.lastDigShelterPos = { x: Math.floor(pos.x), y: Math.floor(pos.y) - depth, z: Math.floor(pos.z) };
            }
            // Block repeated digging for 15 loops to prevent staircase-to-bedrock
            this.blockedActions.set('dig_emergency_shelter', this.loopCount + 15);
        }

        // Track successful build_shelter so we don't build again immediately.
        // Repeated build_shelter calls trap the bot in a deepening hole.
        // Threshold lowered to > 0 because even 1-2 placed blocks count as "success"
        // and repeated calls still waste time / consume blocks.
        const buildShelterResult = actionResults.find(r => r.action === 'build_shelter')?.result;
        if (buildShelterResult && buildShelterResult.success && (buildShelterResult.blocksPlaced ?? 0) > 0) {
            this.blockedActions.set('build_shelter', this.loopCount + 15);
            // Also track the shelter location so night guard knows we're sheltered
            const loc = buildShelterResult.shelterLocation;
            if (loc) {
                this.lastBuildShelterPos = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
            }
        }
    }

    updateGoalMetrics(decision, observation, actionResults) {
        const goal = decision?.goal || 'unknown';
        this.goalMetrics.total++;
        const inv = observation?.inventory?.slots || [];
        const has = (name) => inv.some(i => i.name === name);
        let achieved = false;
        if (goal.includes('wood') || goal.includes('tree')) achieved = inv.some(i => i.name.includes('_log') || i.name.includes('_planks'));
        if (goal.includes('stone')) achieved = has('cobblestone') || has('stone_pickaxe');
        if (goal.includes('iron')) achieved = has('iron_ore') || has('iron_ingot') || has('iron_pickaxe');
        if (goal.includes('food') || goal.includes('eat')) achieved = (observation.player?.food || 0) >= 14;
        if (!achieved) achieved = Array.isArray(actionResults) && actionResults.some(a => a.success);

        if (achieved) this.goalMetrics.achieved++;
        this.goalMetrics.recent.push(achieved);
        if (this.goalMetrics.recent.length > 20) this.goalMetrics.recent.shift();
        const recentRate = this.goalMetrics.recent.filter(Boolean).length / this.goalMetrics.recent.length;
        if (this.goalMetrics.recent.length >= 20 && recentRate < 0.3) {
            this.logEvent('LOW_GOAL_COMPLETION', { rate: recentRate, recentWindow: this.goalMetrics.recent.length });
        }
    }

    applyBehaviorGuards(observation) {
        const inv = observation?.inventory?.slots || [];
        const countLike = (needle) => inv.filter(i => i.name.includes(needle)).reduce((s, i) => s + i.count, 0);
        const countEq = (name) => inv.filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
        const has = (name) => inv.some(i => i.name === name);
        const hasAny = (needle) => inv.some(i => i.name && i.name.includes(needle));
        const woodCount = countLike('_log') + countLike('_planks');
        const cobbleCount = countEq('cobblestone');
        const stickCount = countEq('stick');
        const dirtCount = countEq('dirt');
        const hasPickaxe = hasAny('pickaxe');
        const hasStonePickaxe = has('stone_pickaxe');
        const hasWoodenPickaxe = has('wooden_pickaxe');
        const hasCraftingTable = has('crafting_table');
        const plankCount = inv.filter(i => i.name && i.name.includes('_planks')).reduce((s, i) => s + i.count, 0);
        const playerY = observation.player?.position?.y ?? 64;

        // Drowning: always surface first — overrides everything.
        // Require isInWater to avoid false triggers during post-surface oxygen recovery.
        const isInWater = observation.player?.isInWater === true;
        const oxygenLevel = observation.player?.oxygen ?? 20;
        // Only trigger on CRITICAL oxygen (<=5) to avoid shallow-water loops where the bot
        // surfaces briefly then sinks back. The bot needs time to walk out of the water edge.
        const criticalOxygen = oxygenLevel <= 5;
        const inDrowningCooldown = this.loopCount <= this.drowningGuardCooldownUntil;
        if (isInWater && criticalOxygen && !inDrowningCooldown) {
            // If swim_up has failed recently, try dig_to_surface instead (e.g. trapped under ledge)
            const recentSwimFails = this.recentActions.slice(-4).filter(a =>
                (a.action === 'swim_up' || a.action === 'swimUp') && !a.success
            ).length;
            if (recentSwimFails >= 2) {
                return {
                    goal: 'escape_drowning',
                    reasoning: `Drowning danger (inWater=${isInWater}, oxygen=${oxygenLevel}/20). swim_up failed ${recentSwimFails} times recently — digging to surface instead.`,
                    actions: [{ name: 'dig_to_surface', params: {} }]
                };
            }
            this.drowningGuardCooldownUntil = this.loopCount + 2; // Give bot 2 loops to walk onto land
            return {
                goal: 'escape_drowning',
                reasoning: `Drowning danger (inWater=${isInWater}, oxygen=${oxygenLevel}/20). Surface immediately.`,
                actions: [{ name: 'swim_up', params: {} }]
            };
        }

        // Combat danger: flee when hostile mobs are close OR when we were recently hit.
        // Skeletons shoot from up to 16m; the 8m observation radius misses them.
        // Use recentHits to detect attacks from outside visual range.
        const recentlyHit = this.recentHits.length > 0;
        const nearbyHostiles = (observation.entities?.mobs || []).filter(
            m => this.action.isHostile(m) && m.distance < 16
        );
        const veryCloseHostiles = nearbyHostiles.filter(m => m.distance < 5);
        const closeHostiles = nearbyHostiles.filter(m => m.distance < 8);
        
        if (recentlyHit || nearbyHostiles.length > 0) {
            // Prefer the actual last attacker name (from 1.20+ damage source) when the bot was
            // hit but the mob is outside the observation radius. Fall back to nearest observed
            // hostile, then to 'unknown' as a last resort.
            const lastAttacker = this.dangerState.lastAttacker;
            const threatName = nearbyHostiles.length > 0
                ? nearbyHostiles[0].name
                : (lastAttacker || 'unknown');
            const threatDist = nearbyHostiles.length > 0 ? Math.floor(nearbyHostiles[0].distance) : '?';
            
            // Very close (<5m): flee immediately regardless of health
            if (veryCloseHostiles.length > 0) {
                return {
                    goal: 'flee_danger',
                    reasoning: `Hostile(s) very close (${veryCloseHostiles[0].name} at ${Math.floor(veryCloseHostiles[0].distance)}m). Flee now.`,
                    actions: [
                        { name: 'eat', params: {} },
                        { name: 'flee_from', params: { entity: threatName } }
                    ]
                };
            }
            
            // Recently hit or hostiles within 8m and health <= 16: eat then flee
            // Lower threshold from 12 to 16 because skeletons/pillagers can fire repeatedly
            // from outside the 16m observation radius, chipping health down over time.
            if (recentlyHit || closeHostiles.length > 0) {
                if (observation.player.health <= 16) {
                    return {
                        goal: 'flee_danger',
                        reasoning: `${recentlyHit ? 'Recently hit' : 'Hostile nearby'} (${threatName} ~${threatDist}m), health=${observation.player.health}. Eat and flee.`,
                        actions: [
                            { name: 'eat', params: {} },
                            { name: 'flee_from', params: { entity: threatName } }
                        ]
                    };
                }
                // Health is okay but we're under fire — only eat if actually hurt (not a scratch)
                if (recentlyHit && observation.player.health <= 16) {
                    return {
                        goal: 'heal_from_damage',
                        reasoning: `Took damage from ${threatName} ~${threatDist}m, health low (${observation.player.health}). Eating to recover before continuing.`,
                        actions: [{ name: 'eat', params: {} }]
                    };
                }
                // Recently hit with hostiles nearby but health > 16: still flee to break line of sight
                if (recentlyHit && closeHostiles.length > 0) {
                    return {
                        goal: 'flee_danger',
                        reasoning: `Under fire from ${threatName} ~${threatDist}m. Fleeing to break line of sight even though health is okay.`,
                        actions: [{ name: 'flee_from', params: { entity: threatName } }]
                    };
                }
            }
        }

        // Starvation/health safety guard: applies even in autonomous mode. The LLM can
        // decide its own goals, but running out of food or dying is not a strategic choice.
        const health = observation.player?.health ?? 20;
        const food = observation.player?.food ?? 20;
        const foodItems = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
            'cooked_cod', 'cooked_salmon', 'bread', 'apple', 'golden_apple', 'golden_carrot', 'melon_slice',
            'sweet_berries', 'baked_potato', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'pumpkin_pie',
            'cookie', 'cake', 'dried_kelp', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
            'potato', 'beetroot', 'carrot', 'rotten_flesh', 'spider_eye'];
        const hasFood = inv.some(i => foodItems.includes(i.name));
        const passiveMobs = (observation.entities?.mobs || []).filter(
            m => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(m.name) && m.distance < 16
        );
        if ((health < 12 || food < 10) && hasFood) {
            return {
                goal: 'heal',
                reasoning: `Health or food is low (health=${Math.floor(health)}, food=${Math.floor(food)}). Eating to recover.`,
                actions: [{ name: 'eat', params: {} }]
            };
        }
        if (food < 10 && !hasFood) {
            const passiveMobs = (observation.entities?.mobs || []).filter(
                m => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(m.name) && m.distance < 16
            );
            if (passiveMobs.length > 0) {
                const target = passiveMobs[0];
                return {
                    goal: 'emergency_food',
                    reasoning: `Food is critically low (${Math.floor(food)}) and no food items in inventory. Hunting ${target.name} for food.`,
                    actions: [
                        { name: 'attack', params: { entity: target.name } },
                        { name: 'eat', params: {} }
                    ]
                };
            }
        }

        // Progression guards: disabled in autonomousMode (model decides these itself).
        // Active only in guided mode (guided_baseline config) where scripted progression is intentional.
        if (!this.config.llm?.autonomousMode) {
            // Health/Eating guard: eat when health is low, hunt if no food
            // (health, foodItems, hasFood, and passiveMobs are already defined in the safety guard above.)
            if (health < 14 && hasFood) {
                return {
                    goal: 'heal',
                    reasoning: `Health is low (${Math.floor(health)}/20). Eating food to recover.`,
                    actions: [{ name: 'eat', params: {} }]
                };
            }
            if (health < 10 && !hasFood && passiveMobs.length > 0) {
                return {
                    goal: 'emergency_food',
                    reasoning: `Health critically low (${Math.floor(health)}/20) with no food. Hunting ${passiveMobs[0].name} for food.`,
                    actions: [
                        { name: 'attack', params: { entity: passiveMobs[0].name } },
                        { name: 'eat', params: {} }
                    ]
                };
            }

            // Hunt opportunity: animals nearby when we need food or wool for bed.
            // Don't let explore/mine goals walk past free resources.
            const needsFood = health < 14 || (observation.player?.food ?? 20) < 12;
            const hasWool = inv.some(i => i.name === 'wool');
            const hasBed = has('white_bed') || has('red_bed') || has('blue_bed') || has('yellow_bed');
            const needsWool = !hasBed && !hasWool;
            const nearbyAnimals = (observation.entities?.mobs || []).filter(
                m => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(m.name) && m.distance < 10
            );
            const attackBlocked = (this.blockedActions.get('attack') || 0) > this.loopCount;
            if ((needsFood || needsWool) && nearbyAnimals.length > 0 && !attackBlocked) {
                const target = nearbyAnimals[0];
                return {
                    goal: 'hunt_opportunity',
                    reasoning: `${target.name} nearby (${Math.floor(target.distance)}m) and we need ${needsWool ? 'wool for bed' : 'food'}. Hunting before continuing.`,
                    actions: [
                        { name: 'attack', params: { entity: target.name } },
                        { name: 'eat', params: {} }
                    ]
                };
            }

            // Mine stone guard: force mining when the bot has a pickaxe but no stone tools yet
            const logCount_pre = countLike('_log');
            if (hasPickaxe && logCount_pre >= 3 && cobbleCount < 8 && !hasStonePickaxe) {
                return {
                    goal: 'mine_stone',
                    reasoning: `Have pickaxe and ${logCount_pre} logs but only ${cobbleCount} cobblestone. Mining stone to progress toward stone tools.`,
                    actions: [{ name: 'mine', params: { blockType: 'stone', count: 10 } }]
                };
            }

            // Night cycle guards
            const surfaceY = observation.player?.position?.y ?? 64;
            const timeOfDay = observation.environment?.timeOfDay ?? 6000;
            const isNight = timeOfDay > 12000 || timeOfDay < 1000;
            const onSurfaceAtNight = surfaceY >= 62;
            const slots = observation.inventory?.slots || [];
            const placeableCount = slots.filter(i => i.name && (i.name.includes('planks') || i.name === 'dirt' || i.name === 'cobblestone')).reduce((s, i) => s + i.count, 0);

            // Reset shelter tracking when day comes so we can dig again next night if needed.
            // BUT: only reset if the bot has actually climbed out. If it's still in the pit at
            // dawn, keep the tracker so escape_trap doesn't falsely trigger.
            if (!isNight) {
                this.lastDigShelterLoop = -1;
                this.waitInTreeLoopCount = 0;
                const pos = observation.player?.position;
                const stillInDugShelter = this.lastDigShelterPos && pos &&
                    Math.abs(pos.x - this.lastDigShelterPos.x) <= 3 &&
                    Math.abs(pos.y - this.lastDigShelterPos.y) <= 3 &&
                    Math.abs(pos.z - this.lastDigShelterPos.z) <= 3;
                const stillInBuiltShelter = this.lastBuildShelterPos && pos &&
                    Math.abs(pos.x - this.lastBuildShelterPos.x) <= 3 &&
                    Math.abs(pos.y - this.lastBuildShelterPos.y) <= 3 &&
                    Math.abs(pos.z - this.lastBuildShelterPos.z) <= 3;
                if (!stillInDugShelter && !stillInBuiltShelter) {
                    this.lastDigShelterPos = null;
                    this.lastBuildShelterPos = null;
                }
            }

            if (isNight && onSurfaceAtNight) {
                // SAFETY: Don't dig down if standing on leaves — bot will fall through tree canopy
                const botPos = this.bot.entity.position.floored();
                const blockBelow = this.bot.blockAt(botPos.offset(0, -1, 0));
                if (blockBelow && blockBelow.name.includes('leaves')) {
                    this.waitInTreeLoopCount++;
                    if (this.waitInTreeLoopCount >= 6) {
                        // Force escape after waiting too long — break leaves below and fall to solid ground
                        this.waitInTreeLoopCount = 0;
                        return {
                            goal: 'escape_tree',
                            reasoning: 'Waited in tree too long. Breaking leaves below to fall safely.',
                            actions: [
                                { name: 'look', params: { pitch: -90 } },
                                { name: 'break_around', params: { direction: 'down' } },
                                { name: 'wait', params: { ms: 1500 } }
                            ]
                        };
                    }
                    return {
                        goal: 'wait_in_tree',
                        reasoning: 'Night time but standing in a tree. Digging down would cause a dangerous fall. Waiting for safety.',
                        actions: [{ name: 'wait', params: { ms: 3000 } }]
                    };
                } else {
                    this.waitInTreeLoopCount = 0;
                }
                
                // Already sheltered? Check if there's a solid block above us
                // Check Y+1 through Y+3 to match buildShelter's logic (which checks Y+2 and Y+3)
                const above = observation.environment?.verticalProfile?.above || [];
                const blockAboveHead = (above[0] || '').toLowerCase();
                const blockAbove2 = (above[1] || '').toLowerCase();
                const blockAbove3 = (above[2] || '').toLowerCase();
                const isSolid = (name) => name && name !== 'air' && name !== 'unknown' && !name.includes('leaves');
                const isUnderRoof = isSolid(blockAboveHead) || isSolid(blockAbove2) || isSolid(blockAbove3);
                // If we dug an emergency shelter this night and are still IN it, consider ourselves sheltered.
                // Tight tolerance: must be within 1 block horizontally and at/near shelter floor level.
                // A 3-block radius was too loose — the bot could stand on the surface nearby and think it was safe.
                const pos = observation.player?.position;
                let isInDugShelter = false;
                if (this.lastDigShelterLoop >= 0 && this.lastDigShelterPos && pos) {
                    const dx = Math.abs(pos.x - this.lastDigShelterPos.x);
                    const dy = Math.abs(pos.y - this.lastDigShelterPos.y);
                    const dz = Math.abs(pos.z - this.lastDigShelterPos.z);
                    // Tolerance widened to 2 blocks: bot can move around inside a small pit
                    // or stand right next to it and still be considered sheltered.
                    isInDugShelter = dx <= 2 && dy <= 2 && dz <= 2;
                }
                // Also check if we're still inside a recently-built shelter (wider tolerance
                // because build_shelter roofs can cover a 5x5 or 7x7 area).
                let isInBuiltShelter = false;
                if (this.lastBuildShelterPos && pos) {
                    const dx = Math.abs(pos.x - this.lastBuildShelterPos.x);
                    const dy = Math.abs(pos.y - this.lastBuildShelterPos.y);
                    const dz = Math.abs(pos.z - this.lastBuildShelterPos.z);
                    isInBuiltShelter = dx <= 2 && dy <= 2 && dz <= 2;
                }
                const isSheltered = isUnderRoof || isInDugShelter || isInBuiltShelter;
                if (isSheltered) {
                    if (isInDugShelter && !isUnderRoof) {
                        // If we're taking damage, the shelter isn't working (zombie reached in, or we're not actually in it)
                        if (this.dangerState.underAttack || this.dangerState.lowHealth) {
                            console.log('⚡ Forcing exit from dug shelter — taking damage while "sheltered"');
                            this.lastDigShelterPos = null;
                            return null;
                        }
                        // Break-glass: if we've been waiting in this pit for too many loops,
                        // the shelter tracker may be stale (bot climbed out but tracker wasn't cleared).
                        // Force resume progression.
                        const recentWaits = this.recentActions?.slice(-15).filter(a => a.goal === 'wait_in_shelter').length || 0;
                        if (recentWaits >= 6) {
                            console.log(`⚡ Forcing exit from dug shelter after ${recentWaits} consecutive waits`);
                            this.lastDigShelterPos = null;
                            return null;
                        }
                        // In a dug pit with no roof — safest thing is to wait for day
                        if (!isNight) {
                            // Also clear build shelter tracker on exit so next night we can build fresh
                            this.lastBuildShelterPos = null;
                            // Day has come — actively break out instead of returning null and
                            // hoping the LLM figures out it's trapped. Target the blocks directly
                            // above the shelter floor (the seal + any dirt above it).
                            const escapeY1 = this.lastDigShelterPos.y + 1;
                            const escapeY2 = this.lastDigShelterPos.y + 2;
                            return {
                                goal: 'exit_shelter',
                                reasoning: 'Day has come — breaking seal to exit emergency shelter.',
                                actions: [
                                    { name: 'break_block', params: { x: this.lastDigShelterPos.x, y: escapeY1, z: this.lastDigShelterPos.z } },
                                    { name: 'break_block', params: { x: this.lastDigShelterPos.x, y: escapeY2, z: this.lastDigShelterPos.z } }
                                ]
                            };
                        }
                        return {
                            goal: 'wait_in_shelter',
                            reasoning: 'In emergency pit shelter. Waiting for day.',
                            actions: [{ name: 'wait', params: { ms: 3000 } }]
                        };
                    }
                    // Already under cover — no need to build or dig more shelter
                    return null;
                }

                const hasBed = hasAny('_bed');
                const nearbyBed = observation.environment?.nearbyBed;
                const now = this.loopCount;
                const buildShelterBlocked = (this.blockedActions.get('build_shelter') || 0) > now;
                const digShelterBlocked = (this.blockedActions.get('dig_emergency_shelter') || 0) > now;
                const sleepBlocked = (this.blockedActions.get('sleep_if_possible') || 0) > now;

                if (hasBed && !sleepBlocked) {
                    return {
                        goal: 'sleep_in_bed',
                        reasoning: 'Night time. Have a bed - placing it and sleeping to skip the night.',
                        actions: [{ name: 'sleep_if_possible', params: {} }]
                    };
                }
                if (nearbyBed && !sleepBlocked) {
                    return {
                        goal: 'sleep_in_bed',
                        reasoning: `Night time. Bed found ${nearbyBed.distance}m away - going to sleep.`,
                        actions: [{ name: 'sleep_if_possible', params: {} }]
                    };
                }

                // If health is low, building a shelter is dangerous (mobs may attack during construction).
                // Prefer digging a quick emergency pit instead.
                const healthLow = (observation.player?.health ?? 20) < 10;
                if (placeableCount >= 8 && !buildShelterBlocked && !healthLow) {
                    return {
                        goal: 'build_night_shelter',
                        reasoning: `Night on surface with ${placeableCount} blocks. Building proper shelter.`,
                        actions: [{ name: 'build_shelter', params: {} }]
                    };
                }
                // Only dig emergency shelter if we have some materials/tools to recover.
                // Digging bare-handed with nothing traps us in a hole we can't escape from.
                const woodCount = countLike('_log') + countLike('_planks');
                const trulyEmpty = !hasPickaxe && placeableCount === 0 && woodCount === 0;
                if (!trulyEmpty && !digShelterBlocked) {
                    return {
                        goal: 'emergency_shelter_night',
                        reasoning: 'Night on surface with insufficient building materials. Digging emergency shelter.',
                        actions: [{ name: 'dig_emergency_shelter', params: {} }]
                    };
                }
                // Truly empty at night: fall through and let heuristic/LLM decide (will try chop_tree or wait)
                // All shelter options blocked — fall through and let the heuristic/LLM decide
            }
        }

        if (this.stuckLoopCount >= 4) {
            // If blocked actions are the cause of the deadlock (not physical entrapment), clear
            // the block map and return null so the LLM retries with its actions unvetoed.
            // Physical-escape sequences (break_around, pillar_up) are the wrong remedy here.
            const now = this.loopCount;
            const activeBlocks = Array.from(this.blockedActions.entries()).filter(([, until]) => until > now);
            if (activeBlocks.length > 0) {
                const botY = observation.player?.position?.y ?? 64;
                const blockAboveForRecovery = ((observation.environment?.verticalProfile?.above?.[0]) || '').toLowerCase();
                const solidAboveForRecovery = blockAboveForRecovery && blockAboveForRecovery !== 'air' && !blockAboveForRecovery.includes('leaves');
                const physicallyStuck = botY < 62 || solidAboveForRecovery;
                if (!physicallyStuck) {
                    this.blockedActions.clear();
                    this.stuckLoopCount = 0;
                    this.logEvent('ACTION_UNBLOCKED', { reason: 'forced_recovery_deadlock', clearedActions: activeBlocks.map(([n]) => n) });
                    return null; // Let LLM decide freely on the next loop
                }
            }

            // Rotate through different escape strategies to avoid repeating the same failed approach
            const hasPickaxe = this.bot.inventory.items().some(i => i.name.includes('pickaxe'));
            const hasPlaceableBlocks = (observation.inventory?.slots || []).some(i =>
                i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('planks') || i.name.includes('_log')
            );

            const escapeStrategies = [
                [
                    { name: 'break_around', params: { direction: 'escape' } },
                    { name: 'pillar_up', params: { height: 5 } },
                    { name: 'explore', params: { distance: 30 } }
                ],
                [
                    { name: 'dig_to_surface', params: {} },
                    { name: 'explore', params: { distance: 50 } }
                ],
                [
                    { name: 'break_around', params: { direction: 'forward' } },
                    { name: 'break_around', params: { direction: 'up' } },
                    { name: 'explore', params: { distance: 40 } }
                ],
                [
                    { name: 'pillar_up', params: { height: 10 } },
                    { name: 'explore', params: { distance: 60 } }
                ]
            ];

            // Underground or enclosed: choose safe strategies based on available tools.
            const blockAboveHead = ((observation.environment?.verticalProfile?.above?.[0]) || '').toLowerCase();
            const solidAbove = blockAboveHead && blockAboveHead !== 'air' && !blockAboveHead.includes('leaves');
            const botY = observation.player?.position?.y ?? 64;
            const isUndergroundOrEnclosed = botY < 62 || solidAbove;
            const currentIdx = this.escapeStrategyIndex % escapeStrategies.length;

            // Strategy preference: pillar_up > dig_to_surface > break_around
            // If we have placeable blocks, prefer pillar_up strategies (0 and 3).
            // If no placeable blocks but we have a pickaxe, dig_to_surface (strategy 1) is okay.
            // If no pickaxe and no placeable blocks, break_around (strategy 2) is the only option.
            if (isUndergroundOrEnclosed && !hasPlaceableBlocks && (currentIdx === 0 || currentIdx === 3)) {
                this.escapeStrategyIndex = 1; // skip to dig_to_surface
            }
            if (isUndergroundOrEnclosed && !hasPlaceableBlocks && !hasPickaxe && currentIdx === 1) {
                this.escapeStrategyIndex = 2; // skip to break_around
            }

            const strategy = escapeStrategies[this.escapeStrategyIndex % escapeStrategies.length];
            this.escapeStrategyIndex++;
            this.stuckLoopCount = 0; // Reset so we re-evaluate after executing
            return {
                goal: 'forced_recovery',
                reasoning: `Stuck for many loops; trying escape strategy #${this.escapeStrategyIndex} (rotating to avoid repeating failed approaches).`,
                actions: strategy
            };
        }

        // Trapped in hole / no path: pathfinding or "no accessible" failures -> escape before gathering
        // Cooldown: after running escape, allow 3 loops for LLM to resume previous goal (e.g. chop_tree) before re-checking trapped
        const inEscapeCooldown = this.loopCount <= this.escapeCooldownUntilLoop;
        const recent = this.recentActions.slice(-6);
        const lastTwoActions = recent.slice(-2).map(a => (a.action || '').toLowerCase());
        const lastTwoWereBreakAround = lastTwoActions.length >= 2 && lastTwoActions.every(a => a === 'break_around' || a === 'clear_path');
        if (!inEscapeCooldown && !lastTwoWereBreakAround) {
            const pathFailure = (a) => {
                const err = (a.error || '').toLowerCase();
                return err.includes('no path') || err.includes('failed to reach') ||
                    err.includes('no accessible') || err.includes('cannot reach') ||
                    err.includes('timeout') || err.includes('only moved');
            };
            const pathFailures = recent.filter(a => !a.success && pathFailure(a));
            const verticalProfile = observation.environment?.verticalProfile;
            // Check for solid ceiling within 5 blocks above (not just immediate head level)
            const aboveBlocks = verticalProfile?.above || [];
            const isSolidBlock = (name) => name && name !== 'air' && name !== 'unknown' && !name.includes('leaves');
            const solidCeilingIndex = aboveBlocks.findIndex(b => isSolidBlock((b || '').toLowerCase()));
            const hasSolidCeiling = solidCeilingIndex !== -1;
            const isConfined = hasSolidCeiling;
            // Underground = deep OR shallow with solid ceiling overhead
            const isUnderground = playerY < 62 || (playerY < 75 && hasSolidCeiling);
            const onSurface = playerY >= 62;
            const requireTwoFailuresOnSurface = onSurface && !isConfined && !isUnderground;

            // On open surface, check whether the bot has actually been moving recently.
            // If it moved >4 blocks in the last 3 steps, it is navigating freely — path failures
            // are targeting unreachable resources, not indicating physical entrapment.
            const recentPos = this.recentPositions;
            const movedBetweenFailures = onSurface && !isConfined && recentPos.length >= 2 &&
                (() => {
                    // Only check the last 3 position changes (most recent movement)
                    const startIdx = Math.max(1, recentPos.length - 3);
                    for (let i = startIdx; i < recentPos.length; i++) {
                        const dx = recentPos[i].x - recentPos[i - 1].x;
                        const dz = recentPos[i].z - recentPos[i - 1].z;
                        if (Math.sqrt(dx * dx + dz * dz) > 4) return true;
                    }
                    return false;
                })();

            // Also detect stuck if bot hasn't moved significantly in recent loops
            const hasntMovedMuch = recentPos.length >= 4 && (
                (() => {
                    const first = recentPos[recentPos.length - 4];
                    const last = recentPos[recentPos.length - 1];
                    const dx = last.x - first.x;
                    const dz = last.z - first.z;
                    return Math.sqrt(dx * dx + dz * dz) < 3;
                })()
            );

            // Detect stranded high up: either well above normal ground (Y>75) or standing on leaves/wood.
            // Normal ground level is often 63-70 depending on biome, so Y=65 alone is not "high up".
            const blockBelowName = (observation.environment?.verticalProfile?.below?.[0] || '').toLowerCase();
            const standingOnLeavesOrWood = blockBelowName.includes('leaves') || blockBelowName.includes('log');
            // Don't trigger if the bot was intentionally digging/building/mining (stationary by design)
            const recentShelterActions = recent.filter(a => 
                ['dig_emergency_shelter', 'build_shelter', 'dig_to_surface'].includes(a.action) && a.success
            );
            const recentMiningActions = recent.filter(a =>
                ['mine', 'break_block', 'breakBlock', 'dig'].includes(a.action) && a.success
            );
            const recentChopActions = recent.filter(a =>
                ['chop_tree', 'chopTree'].includes(a.action) && a.success
            );
            const intentionallyStationary = recentShelterActions.length >= 2 || recentMiningActions.length >= 2 || recentChopActions.length >= 2;
            // Threshold raised: Y>78 is genuinely "stranded high up" (cliff/mountain). Y=70-75 is normal terrain.
            const strandedHighUp = !intentionallyStationary && (playerY > 78 || standingOnLeavesOrWood) && hasntMovedMuch;
            // Surface stuck: on open surface, hasn't moved much, and recent actions keep failing
            const surfaceStuck = onSurface && !isConfined && !isUnderground && hasntMovedMuch &&
                recent.length >= 6 && recent.slice(-6).filter(a => !a.success).length >= 4;

            // Only trigger escape if bot is genuinely stuck, not intentionally sheltering/digging
            const physicallyTrapped = !intentionallyStationary && (
                pathFailures.length >= 2 ||
                (pathFailures.length >= 1 && !requireTwoFailuresOnSurface && (isConfined || isUnderground)) ||
                (hasntMovedMuch && (isConfined || isUnderground)) ||
                strandedHighUp ||
                surfaceStuck
            );
            if (!movedBetweenFailures && physicallyTrapped) {
                const hasPickaxe = inv.some(i => i.name && i.name.includes('pickaxe'));
                const hasPlaceable = inv.some(i => i.name === 'dirt' || i.name === 'cobblestone' || (i.name && i.name.includes('planks')));
                // Escape strategy priority:
                // 1. pillar_up with placeable blocks — safest, preserves pickaxe durability,
                //    works for shallow pits (surface) and confined spaces (underground).
                // 2. dig_to_surface — only when deep underground with a pickaxe and no placeable blocks.
                // 3. break_around — last resort when nothing else works.
                const escapeAction = (isUnderground || isConfined)
                    ? (hasPlaceable
                        ? { name: 'pillar_up', params: { height: 10 } }
                        : hasPickaxe
                            ? { name: 'dig_to_surface', params: {} }
                            : { name: 'break_around', params: { direction: 'up' } })
                    : (hasPlaceable
                        ? { name: 'pillar_up', params: { height: 5 } }
                        : { name: 'break_around', params: { direction: 'escape' } });
                return {
                    goal: 'escape_trap',
                    reasoning: strandedHighUp
                        ? 'Stranded high up with no path. Clearing obstacles then exploring to find ground level.'
                        : 'Stuck (no path or surrounded by obstacles). Clearing blocks and exploring to find open space.',
                    actions: [
                        { name: 'break_around', params: { direction: 'escape' } },
                        escapeAction,
                        { name: 'explore', params: { distance: 25 } }
                    ]
                };
            }
        }

        // Crafting-progression guards 8-13: disabled in autonomousMode (model decides crafting itself).
        // Active only in guided mode where scripted tool progression is intentional.
        if (!this.config.llm?.autonomousMode) {
            // Detect if recent crafting failed because we couldn't access a table (stuck in hole)
            const recentCraftTableFail = this.recentActions.slice(-3).some(a =>
                (a.action === 'craft' || a.action === 'ensure_crafted') &&
                !a.success && (a.error || '').includes('windowOpen')
            );

            // No pickaxe but have cobble + sticks -> craft stone_pickaxe.
            // Check inventory OR nearby placed table (crafting action auto-finds placed tables).
            // Skip if we're in escape cooldown (bot is trying to get unstuck) or recent table access failed.
            const nearbyCraftingTableForPick = observation.environment?.nearbyCraftingTable;
            const recentlyCraftedTableForPick = this.recentActions.slice(-5).some(a => {
                const item = (a.params && (a.params.item || a.params.itemName)) || '';
                return (a.action === 'craft' || a.action === 'ensure_crafted') && String(item).includes('crafting_table');
            });
            const effectiveHasTableForPick = hasCraftingTable || !!nearbyCraftingTableForPick || recentlyCraftedTableForPick;
            if (!hasPickaxe && cobbleCount >= 3 && stickCount >= 2 && effectiveHasTableForPick && !inEscapeCooldown && !recentCraftTableFail) {
                return {
                    goal: 'craft_stone_pickaxe',
                    reasoning: 'No pickaxe; have enough cobblestone and sticks. Craft stone_pickaxe to mine again.',
                    actions: [{ name: 'craft', params: { item: 'stone_pickaxe' } }]
                };
            }
            // No pickaxe but have planks + sticks + crafting table -> craft wooden_pickaxe first
            const nearbyCraftingTableForWood = observation.environment?.nearbyCraftingTable;
            const recentlyCraftedTableForWood = this.recentActions.slice(-5).some(a => {
                const item = (a.params && (a.params.item || a.params.itemName)) || '';
                return (a.action === 'craft' || a.action === 'ensure_crafted') && String(item).includes('crafting_table');
            });
            const effectiveHasTableForWood = hasCraftingTable || !!nearbyCraftingTableForWood || recentlyCraftedTableForWood;
            if (!hasPickaxe && plankCount >= 3 && stickCount >= 2 && effectiveHasTableForWood && !inEscapeCooldown && !recentCraftTableFail) {
                return {
                    goal: 'craft_wooden_pickaxe',
                    reasoning: 'No pickaxe; have planks and sticks. Craft wooden_pickaxe to mine stone.',
                    actions: [{ name: 'craft', params: { item: 'wooden_pickaxe' } }]
                };
            }
            // Note: craft_planks_emergency and craft_sticks_emergency removed.
            // progress_from_logs below already handles the full wood-phase progression
            // (planks -> table -> sticks) without micromanaging the LLM.

            // Pre-calculate crafting table availability for use by both stone-tool and wood-phase guards
            const recentlyCraftedTable = this.recentActions.slice(-5).some(a => {
                const item = (a.params && (a.params.item || a.params.itemName)) || '';
                return (a.action === 'craft' || a.action === 'ensure_crafted') && String(item).includes('crafting_table');
            });
            const nearbyCraftingTable = observation.environment?.nearbyCraftingTable;

            // If craft is blocked but we now have materials for critical progression items,
            // unblock it so we can craft stone tools / pickaxes.
            const craftBlockedUntil = this.blockedActions.get('craft') || 0;
            if (craftBlockedUntil > this.loopCount) {
                const canCraftStonePick = cobbleCount >= 3 && stickCount >= 2 && (hasCraftingTable || !!observation.environment?.nearbyCraftingTable);
                const canCraftWoodPick = plankCount >= 3 && stickCount >= 2 && (hasCraftingTable || !!observation.environment?.nearbyCraftingTable);
                if (canCraftStonePick || canCraftWoodPick) {
                    this.blockedActions.delete('craft');
                    this.logEvent('ACTION_UNBLOCKED', { reason: 'craft_materials_available', item: canCraftStonePick ? 'stone_pickaxe' : 'wooden_pickaxe' });
                }
            }

            // Enough cobblestone for stone tools but still no stone pickaxe -> stop mining, craft
            // BUT: only craft if we can actually reach a crafting table (on surface or near one).
            // If deep underground with no table access, keep mining or return to surface first.
            // Also skip if we're in escape cooldown or recent crafting failed (stuck in hole).
            const effectiveHasTableForStone = hasCraftingTable || recentlyCraftedTable || !!nearbyCraftingTable;
            const canCraftStone = effectiveHasTableForStone || playerY >= 62;
            if (cobbleCount >= 8 && stickCount >= 2 && !hasStonePickaxe && canCraftStone && !inEscapeCooldown && !recentCraftTableFail) {
                if (!effectiveHasTableForStone && plankCount >= 4) {
                    return {
                        goal: 'progress_to_stone_tools',
                        reasoning: 'Have cobblestone but no crafting table. Crafting table first.',
                        actions: [{ name: 'craft', params: { item: 'crafting_table' } }]
                    };
                }
                if (effectiveHasTableForStone) {
                    return {
                        goal: 'progress_to_stone_tools',
                        reasoning: 'Enough cobblestone; craft stone_pickaxe instead of mining more.',
                        actions: [
                            { name: 'craft', params: { item: 'stone_pickaxe' } },
                            { name: 'craft', params: { item: 'stone_axe' } }
                        ]
                    };
                }
            }

            // Enough logs: stop chopping, craft planks / table / sticks — but don't block LLM once we've progressed (table + sticks done)
            const logCount = countLike('_log');
            const enoughWood = logCount >= 3 || woodCount >= 6;
            const effectiveHasTable = hasCraftingTable || recentlyCraftedTable || !!nearbyCraftingTable;
            const woodPhaseComplete = effectiveHasTable && stickCount >= 4;
            if (enoughWood && !woodPhaseComplete) {
                if (plankCount < 4 && logCount >= 1) {
                    return {
                        goal: 'progress_from_logs',
                        reasoning: 'Enough logs; craft planks instead of chopping more.',
                        actions: [{ name: 'craft', params: { item: 'planks', count: 4 } }]
                    };
                }
                if (plankCount >= 4 && !effectiveHasTable && !inEscapeCooldown && !recentCraftTableFail) {
                    return {
                        goal: 'progress_from_logs',
                        reasoning: 'Enough planks; craft crafting_table (once).',
                        actions: [{ name: 'craft', params: { item: 'crafting_table' } }]
                    };
                }
                if (effectiveHasTable && stickCount < 4 && (plankCount >= 2 || logCount >= 1)) {
                    return {
                        goal: 'progress_from_logs',
                        reasoning: 'Have table and wood; craft sticks for tools.',
                        actions: [{ name: 'craft', params: { item: 'stick', count: 4 } }]
                    };
                }
            }
        }

        if (!this.config.llm?.autonomousMode) {
            // Bed crafting guard: craft bed when wool + planks available
            const woolCount = countLike('wool') || countLike('_wool');
            const recentlyCraftedTableForBed = this.recentActions.slice(-5).some(a => {
                const item = (a.params && (a.params.item || a.params.itemName)) || '';
                return (a.action === 'craft' || a.action === 'ensure_crafted') && String(item).includes('crafting_table');
            });
            const nearbyCraftingTableForBed = observation.environment?.nearbyCraftingTable;
            const effectiveHasTableForBed = hasCraftingTable || recentlyCraftedTableForBed || !!nearbyCraftingTableForBed;
            if (woolCount >= 3 && plankCount >= 3 && effectiveHasTableForBed) {
                const woolItem = inv.find(i => i && i.name && i.name.includes('wool'));
                const woolColor = woolItem ? woolItem.name.replace('_wool', '') : 'white';
                const bedName = `${woolColor}_bed`;
                return {
                    goal: 'craft_bed',
                    reasoning: `Have ${woolCount} wool and ${plankCount} planks. Crafting ${bedName} so we can sleep through nights.`,
                    actions: [{ name: 'craft', params: { item: bedName } }]
                };
            }

            // Anti-repetition guard: if same goal repeated too many times, force progression
            if (this.consecutiveSameGoal >= 4) {
                const progression = this.getProgressionAction(observation);
                if (progression) {
                    this.consecutiveSameGoal = 0;
                    return progression;
                }
            }
        }

        // Post-water-escape cooldown: block pathfinding actions so we don't immediately path back into water
        if (this.loopCount <= this.waterEscapeCooldownUntil) {
            ['explore', 'go_to', 'go_to_near', 'chop_tree', 'mine'].forEach(a =>
                this.blockedActions.set(a, this.waterEscapeCooldownUntil)
            );
            // Don't return a guard; just block pathfinding and let normal decision flow pick something else
        }

        // Post-rapid-damage cooldown: block explore to prevent cliff re-falls
        if (this.loopCount <= this.rapidDamageCooldownUntil) {
            this.blockedActions.set('explore', this.rapidDamageCooldownUntil);
        }

        // Tool durability guard: if held tool is below 15% durability and the bot has
        // materials + crafting access, proactively craft a replacement before the tool
        // silently breaks mid-action. Sits after all safety guards so it never overrides
        // drowning/combat/stuck responses. Covers pickaxes AND axes.
        const heldItem = this.bot.heldItem;
        const needsTool = (name) => name.includes('pickaxe') || name.includes('_axe');
        if (heldItem && heldItem.maxDurability && needsTool(heldItem.name)) {
            const remaining = heldItem.maxDurability - (heldItem.durabilityUsed || 0);
            const pct = remaining / heldItem.maxDurability;
            if (pct < 0.15) {
                const isPick = heldItem.name.includes('pickaxe');
                const isAxe = heldItem.name.includes('_axe');
                const toolTier = heldItem.name.includes('stone') ? 'stone'
                    : heldItem.name.includes('iron') ? 'iron'
                    : heldItem.name.includes('wooden') ? 'wooden' : null;

                // First: check if we already have a replacement in inventory (same or better tier)
                const invItems = observation.inventory?.slots || [];
                const betterOrSameTool = invItems.find(i => {
                    if (isPick && !i.name.includes('pickaxe')) return false;
                    if (isAxe && !i.name.includes('_axe')) return false;
                    // Better tiers: diamond > iron > stone > wooden
                    const tiers = ['wooden', 'stone', 'iron', 'diamond'];
                    const heldIdx = tiers.findIndex(t => heldItem.name.includes(t));
                    const itemIdx = tiers.findIndex(t => i.name.includes(t));
                    return itemIdx >= heldIdx && i.name !== heldItem.name;
                });
                if (betterOrSameTool) {
                    return {
                        goal: 'replace_worn_tool',
                        reasoning: `${heldItem.displayName || heldItem.name} at ${Math.round(pct * 100)}% durability. Equipping replacement ${betterOrSameTool.name} from inventory.`,
                        actions: [{ name: 'equip', params: { item: betterOrSameTool.name } }]
                    };
                }

                const nearbyCraftingTableForDur = observation.environment?.nearbyCraftingTable;
                const recentlyCraftedTableForDur = this.recentActions.slice(-5).some(a => {
                    const item = (a.params && (a.params.item || a.params.itemName)) || '';
                    return (a.action === 'craft' || a.action === 'ensure_crafted') && String(item).includes('crafting_table');
                });
                const effectiveHasTableForDur = hasCraftingTable || !!nearbyCraftingTableForDur || recentlyCraftedTableForDur;
                // If wooden tool is worn but we can upgrade to stone, do that instead of replacing wooden
                if (toolTier === 'wooden' && cobbleCount >= 3 && stickCount >= 2 && effectiveHasTableForDur) {
                    const upgrade = isPick ? 'stone_pickaxe' : 'stone_axe';
                    return {
                        goal: 'replace_worn_tool',
                        reasoning: `${heldItem.displayName || heldItem.name} at ${Math.round(pct * 100)}% durability. Upgrading to ${upgrade} instead of replacing wooden tool.`,
                        actions: [
                            { name: 'craft', params: { item: upgrade } },
                            { name: 'equip', params: { item: upgrade } }
                        ]
                    };
                }
                // Only replace wooden with wooden if we can't upgrade
                if (toolTier === 'wooden' && plankCount >= 3 && stickCount >= 2 && effectiveHasTableForDur) {
                    const replacement = isPick ? 'wooden_pickaxe' : 'wooden_axe';
                    return {
                        goal: 'replace_worn_tool',
                        reasoning: `${heldItem.displayName || replacement} at ${Math.round(pct * 100)}% durability (${remaining} uses left). Crafting replacement before it breaks.`,
                        actions: [
                            { name: 'craft', params: { item: replacement } },
                            { name: 'equip', params: { item: replacement } }
                        ]
                    };
                }
                if (toolTier === 'stone' && cobbleCount >= 3 && stickCount >= 2 && effectiveHasTableForDur) {
                    const replacement = isPick ? 'stone_pickaxe' : 'stone_axe';
                    return {
                        goal: 'replace_worn_tool',
                        reasoning: `${heldItem.displayName || replacement} at ${Math.round(pct * 100)}% durability (${remaining} uses left). Crafting replacement before it breaks.`,
                        actions: [
                            { name: 'craft', params: { item: replacement } },
                            { name: 'equip', params: { item: replacement } }
                        ]
                    };
                }
            }
        }

        return null;
    }

    trackGoalRepetition(goalName) {
        if (!goalName) return;
        const normalized = goalName.toLowerCase().replace(/[^a-z_]/g, '');
        if (normalized === this.lastGoalName) {
            this.consecutiveSameGoal++;
        } else {
            this.consecutiveSameGoal = 1;
            this.lastGoalName = normalized;
        }
    }

    getProgressionAction(observation) {
        const inv = observation?.inventory?.slots || [];
        const has = (name) => inv.some(i => i.name === name);
        const hasAny = (needle) => inv.some(i => i.name && i.name.includes(needle));
        const countLike = (needle) => inv.filter(i => i.name && i.name.includes(needle)).reduce((s, i) => s + i.count, 0);
        const cobbleCount = inv.filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
        const hasPickaxe = hasAny('pickaxe');
        const hasStonePickaxe = has('stone_pickaxe');

        if (hasStonePickaxe) {
            const passiveMobs = (observation.entities?.mobs || []).filter(
                m => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(m.name) && m.distance < 20
            );
            if (passiveMobs.length > 0) {
                return {
                    goal: 'hunt_for_food',
                    reasoning: 'Breaking repetition. Have stone tools - hunting animals for food and resources.',
                    actions: [
                        { name: 'attack', params: { entity: passiveMobs[0].name } },
                        { name: 'eat', params: {} }
                    ]
                };
            }
            return {
                goal: 'explore_new_area',
                reasoning: 'Breaking repetition. Have stone tools - exploring for new resources.',
                actions: [{ name: 'explore', params: { distance: 40 } }]
            };
        }
        if (hasPickaxe && cobbleCount < 8) {
            return {
                goal: 'mine_stone',
                reasoning: 'Breaking repetition. Have pickaxe - mining stone to progress.',
                actions: [{ name: 'mine', params: { blockType: 'stone', count: 10 } }]
            };
        }
        if (!hasPickaxe && countLike('_log') >= 3) {
            return {
                goal: 'craft_tools',
                reasoning: 'Breaking repetition. Have logs - crafting planks and tools.',
                actions: [{ name: 'craft', params: { item: 'planks', count: 4 } }]
            };
        }
        return {
            goal: 'explore_new_area',
            reasoning: 'Breaking repetition. Exploring to find new resources.',
            actions: [{ name: 'explore', params: { distance: 30 } }]
        };
    }

    calculateSuccessRate(actions) {
        if (!actions || actions.length === 0) return 0;
        const successful = actions.filter(a => a.success).length;
        return Math.round((successful / actions.length) * 100);
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStateFilePath() {
        const runDir = this.logger?.getRunDirectory ? this.logger.getRunDirectory() : null;
        if (!runDir) return null;
        return path.join(runDir, 'runtime_state.json');
    }

    async persistRuntimeStateIfNeeded(force = false) {
        const now = Date.now();
        if (!force && now - this.lastStatePersistAt < this.statePersistIntervalMs) return;
        const stateFile = this.getStateFilePath();
        if (!stateFile) return;
        const payload = {
            savedAt: now,
            loopCount: this.loopCount,
            goalManager: this.goalManager.exportState(),
            longMemory: this.longMemory.exportState(),
            blockedActions: Array.from(this.blockedActions.entries())
        };
        try {
            fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), 'utf8');
            this.lastStatePersistAt = now;
        } catch (e) {
            this.logEvent('STATE_PERSIST_FAILED', { error: e.message });
        }
    }

    loadRuntimeStateIfPresent() {
        const stateFile = this.getStateFilePath();
        if (!stateFile || !fs.existsSync(stateFile)) return false;
        try {
            const payload = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            this.goalManager.importState(payload.goalManager);
            this.longMemory.importState(payload.longMemory);
            this.blockedActions = new Map(Array.isArray(payload.blockedActions) ? payload.blockedActions : []);
            this.logEvent('STATE_RESTORED', { savedAt: payload.savedAt || null });
            return true;
        } catch (e) {
            this.logEvent('STATE_RESTORE_FAILED', { error: e.message });
            return false;
        }
    }

    stop() {
        this.isRunning = false;
        console.log('Agent runtime stopped');
        
        // Clear inventory display interval
        if (this.inventoryDisplayInterval) {
            clearInterval(this.inventoryDisplayInterval);
            this.inventoryDisplayInterval = null;
        }
        
        // Remove all event handlers to prevent duplicate death handlers
        // from old runtimes corrupting logger state on respawn
        if (this._eventHandlers && this.bot) {
            for (const [event, handler] of Object.entries(this._eventHandlers)) {
                this.bot.removeListener(event, handler);
            }
            this._eventHandlers = {};
        }
        
        // Close logging system
        if (this.logger) {
            this.logEvent('RUN_END', {
                loops_executed: this.loopCount,
                memory_size: this.memory.length
            });
            this.persistRuntimeStateIfNeeded(true);
            this.logger.close();
        }
    }

    // Get statistics
    getStats() {
        const stats = {
            loops_executed: this.loopCount,
            memory_size: this.memory.length,
            events_logged: this.eventLog.length,
            current_goal: this.currentGoal,
            action_history_size: this.action.actionHistory.length,
            is_running: this.isRunning,
            tier: this.goalManager.currentTier,
            achievements: this.longMemory.getSummary().achievements.length
        };
        
        if (this.logger) {
            stats.logging = this.logger.getStats();
        }
        
        return stats;
    }
}

module.exports = AgentRuntime;
