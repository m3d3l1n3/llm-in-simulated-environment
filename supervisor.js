/**
 * Experiment Supervisor (Section 7)
 * Controls the entire experimental run with perturbations
 * 
 * 7.1 Run Controller:
 * - Start server (assumed running)
 * - Spawn agent
 * - Start timer
 * - Stop run cleanly after T hours
 * 
 * 7.2 Perturbation Injector:
 * - Pre-scheduled perturbations
 * - Event logging
 */

const { spawn } = require('child_process');
const path = require('path');

class ExperimentSupervisor {
    constructor(config = {}) {
        this.config = {
            duration: config.duration || 3600000, // Default: 1 hour in ms
            serverHost: config.serverHost || 'localhost',
            serverPort: config.serverPort || 25565,
            runName: config.runName || null,
            perturbationSchedule: config.perturbationSchedule || [],
            ...config
        };

        this.bot = null;
        this.agentRuntime = null;
        this.startTime = null;
        this.endTime = null;
        this.timerHandle = null;
        this.perturbationTimers = [];
        this.isRunning = false;
        this.watchdogTimer = null;
        this.lastLoopCount = 0;
        this.lastLoopAdvanceAt = 0;
    }

    /**
     * Initialize and start the experiment
     */
    async start() {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║         EXPERIMENT SUPERVISOR - STARTING RUN             ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');
        
        this.startTime = Date.now();
        this.isRunning = true;

        const durationMinutes = Math.round(this.config.duration / 60000);
        console.log(`⏱  Duration: ${durationMinutes} minutes`);
        console.log(`🌐 Server: ${this.config.serverHost}:${this.config.serverPort}`);
        console.log(`📋 Perturbations: ${this.config.perturbationSchedule.length} scheduled\n`);

        // Schedule the run termination
        this.scheduleTermination();

        // Schedule perturbations
        this.schedulePerturbations();
        this.startHealthWatchdog();

        console.log('✓ Experiment initialized');
        console.log('✓ Waiting for bot to connect...\n');
    }

    /**
     * Register the bot instance
     */
    registerBot(bot, agentRuntime) {
        this.bot = bot;
        this.agentRuntime = agentRuntime;
        
        console.log('✓ Bot registered with supervisor\n');

        // Setup bot event handlers for supervisor
        this.bot.on('end', () => {
            if (this.isRunning) {
                console.log('\n⚠️  Bot disconnected unexpectedly');
                // Let run_experiment reconnect first when enabled.
                if (!this.config.allowReconnect) {
                    this.handleUnexpectedEnd();
                }
            }
        });

        // Note: BOT_DEATH is logged by AgentRuntime's death handler (agent.js)
        // to avoid duplicate events. Supervisor does NOT log it here.
    }

    startHealthWatchdog() {
        this.lastLoopAdvanceAt = Date.now();
        this.watchdogTimer = setInterval(() => {
            if (!this.isRunning || !this.agentRuntime) return;
            const loops = this.agentRuntime.loopCount || 0;
            if (loops > this.lastLoopCount) {
                this.lastLoopCount = loops;
                this.lastLoopAdvanceAt = Date.now();
                return;
            }
            const stalledFor = Date.now() - this.lastLoopAdvanceAt;
            if (stalledFor > 120000) {
                console.log('⚠️  Watchdog: agent loop appears stalled for >60s');
                if (this.agentRuntime?.logger) {
                    this.agentRuntime.logger.logEvent('WATCHDOG_STALL', {
                        stalledForMs: stalledFor,
                        loopCount: loops
                    });
                }
                try {
                    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
                    if (this.bot?.clearControlStates) this.bot.clearControlStates();
                } catch (e) {
                    // best effort
                }
                this.lastLoopAdvanceAt = Date.now();
            }
        }, 30000);
    }

    /**
     * Schedule run termination
     */
    scheduleTermination() {
        this.timerHandle = setTimeout(() => {
            console.log('\n\n⏰ Experiment duration reached - Terminating run...');
            this.stop('DURATION_COMPLETE');
        }, this.config.duration);
    }

    /**
     * Schedule all perturbations
     */
    schedulePerturbations() {
        if (!this.config.perturbationSchedule || this.config.perturbationSchedule.length === 0) {
            return;
        }

        console.log('📅 Scheduling perturbations:\n');
        
        this.config.perturbationSchedule.forEach((perturbation, index) => {
            const delay = perturbation.time; // Configs store time in milliseconds
            const minutes = Math.round(delay / 60000);
            
            console.log(`   ${index + 1}. ${perturbation.type} @ ${minutes}min`);
            
            const timer = setTimeout(() => {
                this.executePerturbation(perturbation);
            }, delay);
            
            this.perturbationTimers.push(timer);
        });
        
        console.log('');
    }

    /**
     * Execute a perturbation
     */
    async executePerturbation(perturbation) {
        if (!this.bot || !this.isRunning) return;

        const elapsedTime = Date.now() - this.startTime;
        const elapsedMinutes = Math.round(elapsedTime / 60000);

        console.log(`\n╔══════════════════════════════════════════════════════════╗`);
        console.log(`║  PERTURBATION @ ${elapsedMinutes}min: ${perturbation.type.padEnd(37)}║`);
        console.log(`╚══════════════════════════════════════════════════════════╝\n`);

        // Log the perturbation event
        if (this.agentRuntime && this.agentRuntime.logger) {
            this.agentRuntime.logger.logEvent('PERTURBATION', {
                type: perturbation.type,
                time: elapsedTime,
                params: perturbation.params || {}
            });
        }

        try {
            switch (perturbation.type) {
                case 'FORCED_DEATH':
                    await this.killBot();
                    break;
                
                case 'TELEPORT':
                    await this.teleportBot(perturbation.params);
                    break;
                
                case 'DIFFICULTY_CHANGE':
                    await this.changeDifficulty(perturbation.params.difficulty);
                    break;
                
                case 'INVENTORY_WIPE':
                    await this.wipeInventory();
                    break;
                
                case 'SPAWN_MOBS':
                    await this.toggleMobSpawning(perturbation.params.enable);
                    break;
                
                case 'TIME_SET':
                    await this.setTime(perturbation.params.time);
                    break;
                
                case 'WEATHER_CHANGE':
                    await this.setWeather(perturbation.params.weather);
                    break;
                
                case 'GIVE_ITEM':
                    await this.giveItem(perturbation.params);
                    break;
                
                default:
                    console.log(`⚠️  Unknown perturbation type: ${perturbation.type}`);
            }
        } catch (error) {
            console.error(`❌ Perturbation failed: ${error.message}`);
            if (this.agentRuntime && this.agentRuntime.logger) {
                this.agentRuntime.logger.logEvent('PERTURBATION_FAILED', {
                    type: perturbation.type,
                    error: error.message
                });
            }
        }

        console.log('✓ Perturbation executed\n');
    }

    // ==================== PERTURBATION METHODS ====================

    async killBot() {
        console.log('💀 Executing: Kill bot');
        this.bot.chat('/kill @p');
    }

    async teleportBot(params) {
        const { x, z, maxRange = 100, minDistance = 0 } = params;
        // Use spreadplayers to guarantee solid ground instead of /tp which may
        // drop the bot in water or inside blocks.
        const centerX = x;
        const centerZ = z ?? x;
        console.log(`🌀 Executing: Spread to safe land near (${centerX}, ${centerZ}), range ${maxRange}`);
        this.bot.chat(`/spreadplayers ${centerX} ${centerZ} ${minDistance} ${maxRange} false @p`);

        // Brief delay then clear mobs at destination. Teleporting into a mob swarm
        // is a random spawn artifact, not a test of displacement recovery skill.
        await new Promise(resolve => setTimeout(resolve, 2000));
        this.bot.chat('/kill @e[type=!player,distance=..30]');
        console.log('💥 Cleared mobs at teleport destination');
    }

    async changeDifficulty(difficulty) {
        console.log(`⚔️  Executing: Change difficulty to ${difficulty}`);
        this.bot.chat(`/difficulty ${difficulty}`);
    }

    async wipeInventory() {
        console.log('🗑️  Executing: Wipe inventory');
        this.bot.chat('/clear @p');
    }

    async toggleMobSpawning(enable) {
        const rule = enable ? 'true' : 'false';
        console.log(`👾 Executing: ${enable ? 'Enable' : 'Disable'} mob spawning`);
        this.bot.chat(`/gamerule doMobSpawning ${rule}`);
    }

    async setTime(time) {
        console.log(`🕐 Executing: Set time to ${time}`);
        this.bot.chat(`/time set ${time}`);
    }

    async setWeather(weather) {
        console.log(`🌦️  Executing: Set weather to ${weather}`);
        this.bot.chat(`/weather ${weather}`);
    }

    async giveItem(params) {
        const { item, count = 1 } = params;
        console.log(`🎁 Executing: Give ${count}x ${item}`);
        this.bot.chat(`/give @p ${item} ${count}`);
    }

    // ==================== RUN CONTROL ====================

    /**
     * Stop the experiment
     */
    stop(reason = 'MANUAL_STOP') {
        if (!this.isRunning) return;

        this.isRunning = false;
        this.endTime = Date.now();
        const duration = this.endTime - this.startTime;
        const durationMinutes = Math.round(duration / 60000);

        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║         EXPERIMENT SUPERVISOR - STOPPING RUN             ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');
        console.log(`⏱  Duration: ${durationMinutes} minutes`);
        console.log(`📝 Reason: ${reason}\n`);

        // Clear timers
        if (this.timerHandle) {
            clearTimeout(this.timerHandle);
        }
        
        this.perturbationTimers.forEach(timer => clearTimeout(timer));
        this.perturbationTimers = [];
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }

        // Log experiment end
        if (this.agentRuntime && this.agentRuntime.logger) {
            this.agentRuntime.logger.logEvent('EXPERIMENT_END', {
                reason: reason,
                duration: duration,
                durationMinutes: durationMinutes
            });
        }

        // Stop agent
        if (this.agentRuntime) {
            this.agentRuntime.stop();
        }

        // Generate experiment-level aggregate summary
        if (this.agentRuntime && this.agentRuntime.logger) {
            this.agentRuntime.logger.closeExperiment();
        }

        // Disconnect bot
        if (this.bot) {
            setTimeout(() => {
                this.bot.quit();
            }, 1000);
        }

        console.log('✓ Experiment stopped cleanly\n');
    }

    /**
     * Handle unexpected disconnection
     */
    handleUnexpectedEnd() {
        this.stop('UNEXPECTED_DISCONNECT');
    }

    /**
     * Get experiment status
     */
    getStatus() {
        if (!this.isRunning) {
            return {
                running: false,
                duration: 0,
                elapsed: 0,
                remaining: 0
            };
        }

        const elapsed = Date.now() - this.startTime;
        const remaining = this.config.duration - elapsed;

        return {
            running: this.isRunning,
            duration: this.config.duration,
            elapsed: elapsed,
            elapsedMinutes: Math.round(elapsed / 60000),
            remaining: remaining,
            remainingMinutes: Math.round(remaining / 60000),
            perturbationsScheduled: this.config.perturbationSchedule.length
        };
    }
}

module.exports = ExperimentSupervisor;
