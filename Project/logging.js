/**
 * Logging System (Section 8)
 * Generates dataset files for behavioral analysis
 * 
 * For each run:
 * - observations.jsonl
 * - actions.jsonl
 * - goals.jsonl
 * - memory_summaries.json
 * - events.json
 */

const fs = require('fs');
const path = require('path');

class LoggingSystem {
    constructor(config = {}) {
        this.config = {
            baseDirectory: config.baseDirectory || './runs',
            runName: config.runName || null,
            flushInterval: config.flushInterval || 1000, // ms
            ...config
        };

        this.runId = null;
        this.runDirectory = null;
        this.baseRunDirectory = null;  // Top-level experiment folder
        this.lifeNumber = 0;           // Increments on each death
        this.startTime = null;
        
        // File streams
        this.streams = {
            observations: null,
            actions: null,
            goals: null,
            llmRequests: null
        };

        // In-memory buffers (for batch writing)
        this.buffers = {
            observations: [],
            actions: [],
            goals: [],
            events: [],
            memorySummaries: [],
            llmRequests: []
        };

        // Metadata
        this.metadata = {
            minecraftVersion: null,
            mineflayerVersion: null,
            nodeVersion: process.version,
            seed: null,
            llmConfig: null,
            actionSet: null
        };

        // Behavioral pattern tracking (for research analysis)
        this.behavioralMetrics = {
            totalDecisions: 0,
            goalsStarted: 0,
            goalsCompleted: 0,
            actionTypeFrequency: {},
            goalTypeFrequency: {},
            consecutiveFailures: 0,
            maxConsecutiveFailures: 0,
            perturbationRecoveryTimes: [],
            lastPerturbationTime: null,
            actionSequences: [], // Track common action patterns
            behavioralLoops: []  // Detect repetitive behavior
        };
    }

    /**
     * Initialize a new run
     * Creates directory structure and metadata
     */
    initializeRun(metadata = {}) {
        this.startTime = Date.now();
        const isRecovery = metadata.deathRecovery === true;
        
        if (!isRecovery) {
            // FIRST LIFE: create the base experiment folder
            this.lifeNumber = 1;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            this.runId = this.config.runName || `run_${timestamp}`;
            this.baseRunDirectory = path.join(this.config.baseDirectory, this.runId);
            this.runDirectory = path.join(this.baseRunDirectory, 'life_01');
        } else {
            // SUBSEQUENT LIFE: find existing base folder and increment life number.
            // This handles both rotateOnDeath (same logger) and respawn with new logger.
            const candidateBase = path.join(this.config.baseDirectory, this.config.runName || '');
            if (!this.baseRunDirectory && fs.existsSync(candidateBase)) {
                this.baseRunDirectory = candidateBase;
            }
            if (!this.baseRunDirectory) {
                // Fallback: base folder missing, create it fresh
                this.baseRunDirectory = candidateBase;
            }
            // Find highest existing life number
            let maxLife = 0;
            if (fs.existsSync(this.baseRunDirectory)) {
                const entries = fs.readdirSync(this.baseRunDirectory);
                for (const entry of entries) {
                    const match = entry.match(/^life_(\d+)$/);
                    if (match) {
                        maxLife = Math.max(maxLife, parseInt(match[1], 10));
                    }
                }
            }
            this.lifeNumber = maxLife + 1;
            this.runId = `${path.basename(this.baseRunDirectory)}_life_${String(this.lifeNumber).padStart(2, '0')}`;
            this.runDirectory = path.join(this.baseRunDirectory, `life_${String(this.lifeNumber).padStart(2, '0')}`);
        }
        
        // Create directories
        if (!fs.existsSync(this.config.baseDirectory)) {
            fs.mkdirSync(this.config.baseDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.baseRunDirectory)) {
            fs.mkdirSync(this.baseRunDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.runDirectory)) {
            fs.mkdirSync(this.runDirectory, { recursive: true });
        }

        // Store metadata
        this.metadata = {
            ...this.metadata,
            ...metadata,
            runId: this.runId,
            startTime: this.startTime,
            startTimeISO: new Date(this.startTime).toISOString()
        };

        // Write initial metadata
        this.writeMetadata();

        // Open file streams for JSONL files
        this.streams.observations = fs.createWriteStream(
            path.join(this.runDirectory, 'observations.jsonl'),
            { flags: 'a' }
        ).on('error', (err) => {
            console.error(' observations stream error:', err.message);
        });
        this.streams.actions = fs.createWriteStream(
            path.join(this.runDirectory, 'actions.jsonl'),
            { flags: 'a' }
        ).on('error', (err) => {
            console.error(' actions stream error:', err.message);
        });
        this.streams.goals = fs.createWriteStream(
            path.join(this.runDirectory, 'goals.jsonl'),
            { flags: 'a' }
        ).on('error', (err) => {
            console.error(' goals stream error:', err.message);
        });
        this.streams.llmRequests = fs.createWriteStream(
            path.join(this.runDirectory, 'llm_requests.jsonl'),
            { flags: 'a' }
        ).on('error', (err) => {
            console.error(' llm_requests stream error:', err.message);
        });

        console.log(`\n📁 Logging initialized: ${this.runDirectory}`);
        console.log(`   Run ID: ${this.runId}\n`);

        // Setup auto-flush
        this.flushInterval = setInterval(() => {
            this.flushBuffers();
        }, this.config.flushInterval);

        return this.runId;
    }

    /**
     * Log an observation (Section 4.1)
     */
    logObservation(observation) {
        const entry = {
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            ...observation
        };

        this.buffers.observations.push(entry);
        
        // Write immediately if buffer is large
        if (this.buffers.observations.length >= 10) {
            this.flushObservations();
        }
    }

    /**
     * Log an action (Section 5)
     */
    logAction(action) {
        const entry = {
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            action: action.action,
            params: action.params,
            success: action.success,
            duration: action.duration,
            result: action.result,
            error: action.error
        };

        this.buffers.actions.push(entry);

        // Track behavioral metrics
        const actionType = action.action || 'unknown';
        this.behavioralMetrics.actionTypeFrequency[actionType] = 
            (this.behavioralMetrics.actionTypeFrequency[actionType] || 0) + 1;
        
        // Track consecutive failures for loop detection
        if (action.success === false) {
            this.behavioralMetrics.consecutiveFailures++;
            this.behavioralMetrics.maxConsecutiveFailures = Math.max(
                this.behavioralMetrics.maxConsecutiveFailures,
                this.behavioralMetrics.consecutiveFailures
            );
        } else {
            this.behavioralMetrics.consecutiveFailures = 0;
        }

        if (this.buffers.actions.length >= 10) {
            this.flushActions();
        }
    }

    /**
     * Log a goal/decision (Section 3.2)
     */
    logGoal(goal) {
        const entry = {
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            goal: goal.goal,
            reasoning: goal.reasoning,
            actions: goal.actions,
            context: goal.context || null,
            isGuard: goal.isGuard || false,
            guardType: goal.guardType || null
        };

        this.buffers.goals.push(entry);

        // Track behavioral metrics
        this.behavioralMetrics.totalDecisions++;
        this.behavioralMetrics.goalsStarted++;
        
        // Track goal types for pattern analysis
        const goalKey = goal.goal ? goal.goal.toLowerCase().substring(0, 30) : 'unknown';
        this.behavioralMetrics.goalTypeFrequency[goalKey] = 
            (this.behavioralMetrics.goalTypeFrequency[goalKey] || 0) + 1;

        if (this.buffers.goals.length >= 10) {
            this.flushGoals();
        }
    }

    /**
     * Record a completed goal / milestone (for behavioral analysis)
     */
    recordGoalCompletion(tier) {
        this.behavioralMetrics.goalsCompleted++;
        this.logEvent('GOAL_COMPLETED', { tier });
    }

    /**
     * Log an event (death, perturbation, etc.)
     */
    logEvent(eventType, data = {}) {
        const entry = {
            event: eventType,
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            ...data
        };

        // Track perturbation recovery time
        if (eventType.includes('PERTURBATION')) {
            this.behavioralMetrics.lastPerturbationTime = Date.now();
        }
        if (eventType === 'GOAL_COMPLETED' && this.behavioralMetrics.lastPerturbationTime) {
            const recoveryTime = Date.now() - this.behavioralMetrics.lastPerturbationTime;
            this.behavioralMetrics.perturbationRecoveryTimes.push(recoveryTime);
        }

        this.buffers.events.push(entry);
        
        // Events are critical - write immediately
        this.flushEvents();
    }

    /**
     * Log a memory summary (Section 6.2)
     */
    logMemorySummary(summary) {
        const entry = {
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            summary: summary.summary,
            environmentSnapshot: summary.environmentSnapshot || null,
            period: summary.period || null
        };

        this.buffers.memorySummaries.push(entry);
        this.flushMemorySummaries();
    }

    /**
     * Log a raw LLM request/response pair to llm_requests.jsonl
     * Kept separate from events.jsonl to avoid bloating the append-only event log.
     */
    logLLMRequest(requestLog) {
        if (!this.streams.llmRequests) return;
        const entry = {
            timestamp: Date.now(),
            runTime: Date.now() - this.startTime,
            requestId: requestLog.requestId,
            provider: requestLog.provider,
            model: requestLog.model,
            promptLength: requestLog.promptLength,
            prompt: requestLog.prompt,
            success: requestLog.success,
            rawResponse: requestLog.response?.content ?? null,
            decision: requestLog.decision ?? null,
            tokensUsed: requestLog.tokensUsed ?? null,
            duration: requestLog.duration ?? null,
            error: requestLog.error ?? null
        };
        this.buffers.llmRequests.push(entry);
        if (this.buffers.llmRequests.length >= 5) {
            this.flushLLMRequests();
        }
    }

    /**
     * Flush observation buffer to file
     */
    flushObservations() {
        if (this.buffers.observations.length === 0) return;
        
        this.buffers.observations.forEach(obs => {
            this.streams.observations.write(JSON.stringify(obs) + '\n');
        });
        
        this.buffers.observations = [];
    }

    /**
     * Flush action buffer to file
     */
    flushActions() {
        if (this.buffers.actions.length === 0) return;
        
        this.buffers.actions.forEach(action => {
            this.streams.actions.write(JSON.stringify(action) + '\n');
        });
        
        this.buffers.actions = [];
    }

    /**
     * Flush goal buffer to file
     */
    flushGoals() {
        if (this.buffers.goals.length === 0) return;
        
        this.buffers.goals.forEach(goal => {
            this.streams.goals.write(JSON.stringify(goal) + '\n');
        });
        
        this.buffers.goals = [];
    }

    flushLLMRequests() {
        if (this.buffers.llmRequests.length === 0) return;
        this.buffers.llmRequests.forEach(entry => {
            this.streams.llmRequests.write(JSON.stringify(entry) + '\n');
        });
        this.buffers.llmRequests = [];
    }

    /**
     * Flush events to file (append-only JSONL for linear I/O)
     */
    flushEvents() {
        if (this.buffers.events.length === 0) return;
        if (!this.runDirectory) {
            // Logger hasn't been initialized yet or was reset; drop events silently
            this.buffers.events = [];
            return;
        }

        const eventsPath = path.join(this.runDirectory, 'events.jsonl');

        for (const entry of this.buffers.events) {
            fs.appendFileSync(eventsPath, JSON.stringify(entry) + '\n');
        }

        this.buffers.events = [];
    }

    /**
     * Flush memory summaries to file (append-only JSONL for linear I/O)
     */
    flushMemorySummaries() {
        if (this.buffers.memorySummaries.length === 0) return;
        if (!this.runDirectory) {
            this.buffers.memorySummaries = [];
            return;
        }

        const summariesPath = path.join(this.runDirectory, 'memory_summaries.jsonl');

        for (const entry of this.buffers.memorySummaries) {
            fs.appendFileSync(summariesPath, JSON.stringify(entry) + '\n');
        }

        this.buffers.memorySummaries = [];
    }

    /**
     * Flush all buffers
     */
    flushBuffers() {
        this.flushObservations();
        this.flushActions();
        this.flushGoals();
        this.flushLLMRequests();
        this.flushEvents();
        this.flushMemorySummaries();
    }

    /**
     * Write metadata file
     */
    writeMetadata() {
        if (!this.runDirectory) return;
        const metadataPath = path.join(this.runDirectory, 'metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(this.metadata, null, 2));
    }

    /**
     * Update metadata
     */
    updateMetadata(updates) {
        this.metadata = { ...this.metadata, ...updates };
        this.writeMetadata();
    }

    /**
     * Rotate to a new run folder (called on death)
     * Closes current logs and creates a new run directory
     */
    rotateOnDeath(deathData = {}) {
        console.log(`\n💀 Death detected - rotating to new life folder...`);
        
        // Log the death event before closing
        this.logEvent('BOT_DEATH_FINAL', {
            ...deathData,
            runDuration: Date.now() - this.startTime
        });
        
        // Close current life
        this.close();
        
        // Store old metadata to carry forward
        const oldMetadata = { ...this.metadata };
        
        // Reset state (keep baseRunDirectory and lifeNumber — initializeRun increments it)
        this.buffers = {
            observations: [],
            actions: [],
            goals: [],
            events: [],
            memorySummaries: [],
            llmRequests: []
        };
        
        // Initialize next life subfolder
        this.initializeRun({
            ...oldMetadata,
            previousRun: oldMetadata.runId || 'unknown',
            deathRecovery: true,
            deathTime: Date.now()
        });
        
        console.log(`📁 New life started: ${this.runDirectory}\n`);
        
        return this.runId;
    }

    /**
     * Close the logging system
     */
    close() {
        console.log(`\n📊 Finalizing logs for life ${this.lifeNumber}: ${this.runId}`);
        
        // Stop auto-flush
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }

        // Flush remaining buffers
        this.flushBuffers();

        // Update metadata with end time
        this.metadata.endTime = Date.now();
        this.metadata.endTimeISO = new Date(this.metadata.endTime).toISOString();
        this.metadata.duration = this.metadata.endTime - this.startTime;
        this.metadata.durationMinutes = Math.round(this.metadata.duration / 60000);
        this.writeMetadata();

        // Close streams
        if (this.streams.observations) this.streams.observations.end();
        if (this.streams.actions) this.streams.actions.end();
        if (this.streams.goals) this.streams.goals.end();
        if (this.streams.llmRequests) this.streams.llmRequests.end();

        // Generate summary
        this.generateRunSummary();

        console.log(`✓ Logs saved to: ${this.runDirectory}`);
        console.log(`✓ Duration: ${this.metadata.durationMinutes} minutes\n`);
    }

    /**
     * Close the entire experiment and generate aggregate summary
     * Call this once when the experiment ends (after all lives)
     */
    closeExperiment() {
        if (!this.baseRunDirectory || !fs.existsSync(this.baseRunDirectory)) return;
        
        // Collect summaries from all lives
        const lifeDirs = fs.readdirSync(this.baseRunDirectory)
            .filter(name => name.startsWith('life_'))
            .sort();
        
        const lifeSummaries = [];
        let totalObservations = 0;
        let totalActions = 0;
        let totalGoals = 0;
        let totalEvents = 0;
        let totalDuration = 0;
        let totalDeaths = 0;
        
        for (const lifeDir of lifeDirs) {
            const summaryPath = path.join(this.baseRunDirectory, lifeDir, 'summary.json');
            if (fs.existsSync(summaryPath)) {
                try {
                    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                    lifeSummaries.push({
                        life: lifeDir,
                        ...summary
                    });
                    totalObservations += summary.stats?.observations || 0;
                    totalActions += summary.stats?.actions || 0;
                    totalGoals += summary.stats?.goals || 0;
                    totalEvents += summary.stats?.events || 0;
                    totalDuration += summary.duration || 0;
                    if (summary.metadata?.deathRecovery) totalDeaths++;
                } catch (e) {
                    console.log(`⚠️  Failed to read summary for ${lifeDir}: ${e.message}`);
                }
            }
        }
        
        const experimentSummary = {
            experimentName: path.basename(this.baseRunDirectory),
            totalLives: lifeDirs.length,
            totalDeaths: totalDeaths,
            totalDurationMs: totalDuration,
            totalDurationMinutes: Math.round(totalDuration / 60000),
            aggregateStats: {
                observations: totalObservations,
                actions: totalActions,
                goals: totalGoals,
                events: totalEvents
            },
            lives: lifeSummaries,
            generatedAt: new Date().toISOString()
        };
        
        const expSummaryPath = path.join(this.baseRunDirectory, 'experiment_summary.json');
        fs.writeFileSync(expSummaryPath, JSON.stringify(experimentSummary, null, 2));
        
        console.log(`\n📊 Experiment Summary:`);
        console.log(`   Lives: ${lifeDirs.length} (${totalDeaths} deaths)`);
        console.log(`   Total Duration: ${Math.round(totalDuration / 60000)} minutes`);
        console.log(`   Total Observations: ${totalObservations}`);
        console.log(`   Total Actions: ${totalActions}`);
        console.log(`   Saved to: ${expSummaryPath}\n`);
    }

    /**
     * Generate a summary of the run
     */
    generateRunSummary() {
        if (!this.runDirectory) return;
        const summary = {
            runId: this.runId,
            duration: this.metadata.duration,
            durationMinutes: this.metadata.durationMinutes,
            startTime: this.metadata.startTimeISO,
            endTime: this.metadata.endTimeISO,
            stats: {
                observations: this.countLines('observations.jsonl'),
                actions: this.countLines('actions.jsonl'),
                goals: this.countLines('goals.jsonl'),
                events: this.buffers.events.length + this.countLines('events.jsonl'),
                memorySummaries: this.buffers.memorySummaries.length + this.countLines('memory_summaries.jsonl')
            },
            metadata: this.metadata
        };

        const summaryPath = path.join(this.runDirectory, 'summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

        // Generate behavioral analysis for research
        this.generateBehavioralAnalysis();

        console.log('\n📈 Run Statistics:');
        console.log(`   Observations: ${summary.stats.observations}`);
        console.log(`   Actions: ${summary.stats.actions}`);
        console.log(`   Goals: ${summary.stats.goals}`);
        console.log(`   Events: ${summary.stats.events}`);
        console.log(`   Memory Summaries: ${summary.stats.memorySummaries}`);
    }

    /**
     * Generate behavioral pattern analysis (for research)
     */
    generateBehavioralAnalysis() {
        if (!this.runDirectory) return;
        const analysis = {
            runId: this.runId,
            generatedAt: new Date().toISOString(),
            
            // Decision coherence metrics
            coherence: {
                totalDecisions: this.behavioralMetrics.totalDecisions,
                goalsStarted: this.behavioralMetrics.goalsStarted,
                goalsCompleted: this.behavioralMetrics.goalsCompleted,
                completionRate: this.behavioralMetrics.goalsStarted > 0 
                    ? (this.behavioralMetrics.goalsCompleted / this.behavioralMetrics.goalsStarted * 100).toFixed(1) + '%'
                    : 'N/A'
            },
            
            // Action patterns
            actionDistribution: this.behavioralMetrics.actionTypeFrequency,
            mostFrequentActions: this.getTopN(this.behavioralMetrics.actionTypeFrequency, 5),
            
            // Goal patterns
            goalDistribution: this.behavioralMetrics.goalTypeFrequency,
            mostFrequentGoals: this.getTopN(this.behavioralMetrics.goalTypeFrequency, 5),
            
            // Failure analysis
            failures: {
                maxConsecutiveFailures: this.behavioralMetrics.maxConsecutiveFailures
            },
            
            // Adaptation metrics
            adaptation: {
                perturbationCount: this.behavioralMetrics.perturbationRecoveryTimes.length,
                averageRecoveryTime: this.behavioralMetrics.perturbationRecoveryTimes.length > 0
                    ? (this.behavioralMetrics.perturbationRecoveryTimes.reduce((a,b) => a+b, 0) / 
                       this.behavioralMetrics.perturbationRecoveryTimes.length / 1000).toFixed(1) + 's'
                    : 'N/A'
            }
        };

        const analysisPath = path.join(this.runDirectory, 'behavioral_analysis.json');
        fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
        
        console.log('\n🧠 Behavioral Analysis:');
        console.log(`   Decision Coherence: ${analysis.coherence.completionRate}`);
        console.log(`   Most Common Action: ${analysis.mostFrequentActions[0]?.action || 'N/A'}`);
        console.log(`   Max Consecutive Failures: ${analysis.failures.maxConsecutiveFailures}`);
    }

    /**
     * Get top N entries from frequency map
     */
    getTopN(frequencyMap, n = 5) {
        return Object.entries(frequencyMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([action, count]) => ({ action, count }));
    }

    /**
     * Count lines in a JSONL file
     */
    countLines(filename) {
        if (!this.runDirectory) return 0;
        const filepath = path.join(this.runDirectory, filename);
        if (!fs.existsSync(filepath)) return 0;
        
        const content = fs.readFileSync(filepath, 'utf8');
        return content.split('\n').filter(line => line.trim()).length;
    }



    /**
     * Get the current run directory
     */
    getRunDirectory() {
        return this.runDirectory;
    }

    /**
     * Get run statistics
     */
    getStats() {
        return {
            runId: this.runId,
            startTime: this.startTime,
            runTime: Date.now() - this.startTime,
            buffered: {
                observations: this.buffers.observations.length,
                actions: this.buffers.actions.length,
                goals: this.buffers.goals.length,
                events: this.buffers.events.length,
                memorySummaries: this.buffers.memorySummaries.length
            }
        };
    }
}

module.exports = LoggingSystem;
