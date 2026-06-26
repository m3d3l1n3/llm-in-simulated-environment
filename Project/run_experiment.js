/**
 * Experiment Runner
 * Main entry point for running supervised experiments
 * 
 * Usage:
 *   node run_experiment.js [config_file]
 * 
 * Example:
 *   node run_experiment.js experiment_config.js
 */

require('dotenv').config();

const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const ObservationSystem = require('./observation');
const ActionSystem = require('./actions');
const AgentRuntime = require('./agent');
const ExperimentSupervisor = require('./supervisor');

// Suppress minecraft-protocol partial packet noise (e.g. creeper explosion dumps).
// The library emits these via console.log (not console.warn), so both need to be filtered.
const _origConsoleWarn = console.warn;
console.warn = (...args) => {
    const msg = String(args[0] || '');
    if (msg.includes('partial packet') || msg.includes('Chunk size is')) return;
    _origConsoleWarn.apply(console, args);
};
const _origConsoleLog = console.log;
console.log = (...args) => {
    const msg = String(args[0] || '');
    if (msg.includes('partial packet') || msg.includes('Chunk size is')) return;
    _origConsoleLog.apply(console, args);
};

// Load configuration
let configFile = process.argv[2] || './experiment_config.js';
// Normalize relative paths so Node can require them from the cwd.
if (!path.isAbsolute(configFile) && !configFile.startsWith('./') && !configFile.startsWith('../')) {
    configFile = './' + configFile;
}
let config;

try {
    config = require(configFile);
    console.log(`✓ Loaded configuration from: ${configFile}\n`);
} catch (error) {
    console.error(`❌ Failed to load configuration: ${error.message}`);
    console.error('Usage: node run_experiment.js [config_file]');
    process.exit(1);
}

// Display experiment info
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║              MINECRAFT LLM EXPERIMENT                    ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
console.log(`📝 Experiment: ${config.experiment.name}`);
console.log(`📄 Description: ${config.experiment.description}`);
console.log(`⏱  Duration: ${Math.round(config.experiment.duration / 60000)} minutes`);
console.log(`🌱 Seed: ${config.experiment.seed}`);
console.log(`🤖 LLM: ${config.llm.provider} (${config.llm.model})`);
console.log('');

// Initialize supervisor
const supervisor = new ExperimentSupervisor({
    duration: config.experiment.duration,
    serverHost: config.bot.host,
    serverPort: config.bot.port,
    runName: config.experiment.name,
    perturbationSchedule: config.experiment.perturbations || [],
    allowReconnect: true
});

// Start supervisor
supervisor.start();

// Create bot
console.log(`🌐 Connecting to Minecraft server...`);
let bot = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = config.agent.maxReconnectAttempts || 3;

// Initialize systems
let observationSystem;
let actionSystem;
let hasSetSpawnTime = false;
let agentRuntime;
let isInitializing = false;  // Flag to prevent duplicate initialization

// Generate experiment run name ONCE with timestamp. Reused across all lives
// so deaths create subfolders instead of new top-level folders.
const experimentRunName = config.experiment.name
    ? `${config.experiment.name}_${new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19)}`
    : `run_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;

async function initializeAgent() {
    // Prevent duplicate initialization
    if (isInitializing) {
        console.log('⚠️  Already initializing, skipping...');
        return;
    }
    isInitializing = true;
    
    try {
        console.log('✓ Bot spawned in world!');
        
        // Safety: bot.entity may be undefined during rapid respawn/reconnect
        if (!bot.entity) {
            console.log('⚠️  bot.entity not available yet, waiting...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!bot.entity) {
                console.log('❌ bot.entity still unavailable, aborting initialization');
                isInitializing = false;
                return;
            }
        }
        
        const pos = bot.entity.position;
        console.log(`✓ Position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
        console.log(`✓ Health: ${bot.health}, Food: ${bot.food}\n`);
        
        // Wait for world to load (chunks need to sync from server)
        console.log('Waiting for world chunks to load...');
        
        // Wait until we can see some blocks
        let attempts = 0;
        while (attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
            if (blockBelow && blockBelow.name !== 'air') {
                console.log(`✓ World loaded (block below: ${blockBelow.name})`);
                break;
            }
            attempts++;
            if (attempts % 5 === 0) {
                console.log(`  Still waiting for chunks... (${attempts * 0.5}s)`);
            }
        }
        if (attempts >= 30) {
            console.log('⚠️  Timeout waiting for chunks, continuing anyway');
        }
        
        // SPAWN SAFETY: If spawned in a tree (on leaves), break them immediately
        // so the bot falls to solid ground before mobs or fall damage can kill it
        // during the agent initialization window.
        const spawnBlockBelow = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (spawnBlockBelow && spawnBlockBelow.name.includes('leaves')) {
            console.log('⚠️  Spawned in tree on ' + spawnBlockBelow.name + ' — breaking for safe landing');
            try {
                // Break leaves below feet
                await bot.dig(spawnBlockBelow);
                await new Promise(r => setTimeout(r, 800)); // Wait for gravity to pull us down
                // If still on leaves, break again
                const afterFall = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
                if (afterFall && afterFall.name.includes('leaves')) {
                    await bot.dig(afterFall);
                    await new Promise(r => setTimeout(r, 800));
                }
                console.log('✓ Safe landing at (' + Math.floor(bot.entity.position.x) + ', ' + Math.floor(bot.entity.position.y) + ', ' + Math.floor(bot.entity.position.z) + ')');
            } catch (e) {
                console.log('⚠️  Failed to break leaves at spawn:', e.message);
            }
        }
        
        // Stop existing agent runtime if it exists (prevents duplicate loops)
        // Preserve long-term memory (death context, known locations, achievements) across respawns
        let previousMemory = null;
        if (agentRuntime) {
            previousMemory = agentRuntime.longMemory?.exportState() || null;
            if (agentRuntime.isRunning) {
                console.log('⚠️  Stopping existing agent runtime before reinitializing...');
                agentRuntime.stop();
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for it to stop
            }
        }
        
        // Initialize agent systems
        console.log('Initializing agent systems...');
        observationSystem = new ObservationSystem(bot);
        actionSystem = new ActionSystem(bot);
        agentRuntime = new AgentRuntime(bot, observationSystem, actionSystem, {
            ...config.agent,
            llm: config.llm,  // Pass LLM config to agent
            runName: experimentRunName
        });
        if (previousMemory) {
            agentRuntime.longMemory.importState(previousMemory);
            console.log('✓ Long-term memory restored from previous life');
        }
        
        console.log('✓ Observation system ready');
        console.log('✓ Action system ready');
        console.log('✓ Agent runtime ready\n');
        
        // Register bot with supervisor
        supervisor.registerBot(bot, agentRuntime);
        
        // Start autonomous agent
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('🤖 Starting autonomous agent loop...\n');
        
        const metadata = {
            experimentName: config.experiment.name || 'openai_test',
            experimentDescription: config.experiment.description || 'OpenAI LLM test',
            botUsername: bot.username,
            minecraftVersion: config.bot.version,
            seed: config.experiment.seed || '-1613247987266390429',
            llmConfig: {
                ...config.llm,
                apiKey: config.llm.apiKey ? '***REDACTED***' : undefined
            },
            perturbationCount: config.experiment.perturbations ? config.experiment.perturbations.length : 0,
            deathRecovery: !!previousMemory  // Tell logger this is a respawn, not first spawn
        };
        
        agentRuntime.startLoop(metadata);
    } finally {
        isInitializing = false;
    }
}

function attachBotHandlers() {
    bot.on('login', () => {
        console.log('✓ Bot logged in successfully!');
        console.log(`✓ Username: ${bot.username}`);
    });

    // Use 'once' for initial spawn to prevent duplicate handlers
    bot.once('spawn', () => {
        reconnectAttempts = 0;
        // Set time to 1000 (mid-morning) on first spawn so the bot starts with
        // plenty of daylight instead of immediately panicking into shelter mode.
        if (!hasSetSpawnTime) {
            console.log('☀️  Setting time to 1000 (mid-morning) for safe start');
            bot.chat('/time set 1000');
            hasSetSpawnTime = true;
        }
        initializeAgent();
    });

    // Handle respawn separately
    bot.on('respawn', async () => {
        console.log('🔄 Bot respawned\n');
        reconnectAttempts = 0;

        // Reset to day — night-time spawn deaths are a world-state artifact,
        // not a test of LLM skill. We want to observe autonomous progression,
        // not repeated spawn-kill loops.
        bot.chat('/time set day');

        // Clear accumulated mobs in a larger radius to prevent death loops.
        // Repeated deaths cause mobs to pile up near spawn, which corrupts
        // the experiment by making respawns artificially lethal.
        bot.chat('/kill @e[type=!player,distance=..60]');
        console.log('💥 Cleared mobs near spawn (60-block radius)');

        // Brief pause lets chunks load and mobs clear before the agent starts
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Re-initialize agent on respawn
        await initializeAgent();
    });

    bot.on('error', (err) => {
        console.error('❌ Bot error:', err.message);
    });

    bot.on('kicked', (reason) => {
        console.log('⚠️ Bot was kicked:', reason);
        // Treat kicks like disconnects — attempt reconnect unless supervisor is already stopped
        if (!supervisor.isRunning) return;
        if (reconnectAttempts >= maxReconnectAttempts) {
            console.log(`❌ Reconnect attempts exhausted (${maxReconnectAttempts}) after kick`);
            supervisor.stop('BOT_KICKED');
            return;
        }
        reconnectAttempts++;
        const backoffMs = Math.min(30000, 2000 * reconnectAttempts);
        console.log(`🔁 Reconnecting after kick, attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${Math.round(backoffMs / 1000)}s...`);
        setTimeout(() => {
            createBotInstance();
        }, backoffMs);
    });

    bot.on('end', () => {
        console.log('\n📡 Bot disconnected from server');
        if (!supervisor.isRunning) return;
        if (reconnectAttempts >= maxReconnectAttempts) {
            console.log(`❌ Reconnect attempts exhausted (${maxReconnectAttempts})`);
            supervisor.stop('RECONNECT_EXHAUSTED');
            return;
        }
        reconnectAttempts++;
        const backoffMs = Math.min(30000, 2000 * reconnectAttempts);
        console.log(`🔁 Reconnecting attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${Math.round(backoffMs / 1000)}s...`);
        setTimeout(() => {
            createBotInstance();
        }, backoffMs);
    });

    bot.on('death', () => {
        console.log('\n💀 Bot died!');
        if (bot.entity) {
            const pos = bot.entity.position;
            console.log(`   Death position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
        }
        // Note: Do NOT call /spawnpoint here. /spawnpoint @p without coordinates
        // sets spawn to the player's CURRENT location (the death location), which
        // causes respawn-death loops if the bot died in a cave or near mobs.
        // The default behavior (respawn at world spawn) is safer.
    });
}

function createBotInstance() {
    bot = mineflayer.createBot(config.bot);
    bot.loadPlugin(pathfinder);
    attachBotHandlers();
}

createBotInstance();

// Status reporting every minute
const statusInterval = setInterval(() => {
    const status = supervisor.getStatus();
    if (status.running) {
        console.log(`\n📊 Experiment Status: ${status.elapsedMinutes}/${Math.round(config.experiment.duration / 60000)} minutes`);
        if (agentRuntime) {
            const stats = agentRuntime.getStats();
            console.log(`   Loops: ${stats.loops_executed}, Memory: ${stats.memory_size}, Events: ${stats.events_logged}`);
        }
    }
}, 60000);
statusInterval.unref();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Interrupt signal received');
    supervisor.stop('MANUAL_INTERRUPT');
    clearInterval(statusInterval);
    setTimeout(() => process.exit(0), 2000);
});
