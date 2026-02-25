/**
 * Bond Sync Scheduler
 *
 * Schedule: Every 12 days at 2:00 AM IST (configurable via BOND_SYNC_SCHEDULE env)
 * Deep sync: Sundays at 3:00 AM IST (re-processes all ISINs regardless of change detection)
 * Startup: Runs a sync if last successful sync was > 12 days ago
 *
 * Usage: Call startScheduler() after MongoDB is connected.
 */

const cron = require('node-cron');
const { syncBonds } = require('../lib/etl/bondSync');
const IngestionLog = require('../models/IngestionLog');

let isRunning = false;

/**
 * Run sync with guard against concurrent runs
 */
async function runSync(type, deepSync = false) {
    if (isRunning) {
        console.log(`[Scheduler] ⏭️  Sync already in progress — skipping ${type} run`);
        return null;
    }

    isRunning = true;
    try {
        console.log(`[Scheduler] 🔄 Starting ${type} sync (deep=${deepSync})...`);
        const stats = await syncBonds({ type, deepSync });
        console.log(`[Scheduler] ✅ ${type} sync done — created: ${stats.totalCreated}, updated: ${stats.totalUpdated}, skipped: ${stats.totalSkipped}`);
        return stats;
    } catch (error) {
        console.error(`[Scheduler] ❌ ${type} sync failed: ${error.message}`);
        return null;
    } finally {
        isRunning = false;
    }
}

/**
 * Check if we need a startup sync (last run > 12 days ago or no runs at all)
 */
async function checkStartupSync() {
    try {
        const lastRun = await IngestionLog.findOne({ status: { $in: ['completed', 'partial'] } })
            .sort({ startedAt: -1 })
            .lean();

        if (!lastRun) {
            console.log('[Scheduler] 🆕 No previous sync found — running initial deep sync');
            await runSync('startup', true);
            return;
        }

        const daysSinceLast = (Date.now() - new Date(lastRun.startedAt).getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceLast > 12) {
            console.log(`[Scheduler] ⏰ Last sync was ${daysSinceLast.toFixed(1)} days ago — running startup sync`);
            await runSync('startup', false);
        } else {
            console.log(`[Scheduler] ✅ Last sync was ${daysSinceLast.toFixed(1)} days ago — within 12-day window, skipping`);
        }
    } catch (error) {
        console.error('[Scheduler] Error checking startup sync:', error.message);
        // Run anyway as a safety net
        await runSync('startup', false);
    }
}

/**
 * Start the cron scheduler
 */
function startScheduler() {
    console.log('[Scheduler] Initializing bond sync scheduler...');

    // Every 12 days at 2:00 AM IST
    // Configurable via env var BOND_SYNC_SCHEDULE
    const schedule = process.env.BOND_SYNC_SCHEDULE || '0 2 */12 * *';

    cron.schedule(schedule, () => {
        runSync('daily', false);
    }, {
        timezone: 'Asia/Kolkata'
    });

    console.log(`[Scheduler] ✅ Bond sync scheduled: ${schedule} (Asia/Kolkata)`);

    // Weekly deep sync on Sundays at 3:00 AM IST
    cron.schedule('0 3 * * 0', () => {
        runSync('weekly', true);
    }, {
        timezone: 'Asia/Kolkata'
    });

    console.log('[Scheduler] ✅ Deep sync scheduled: Sunday 3:00 AM IST');

    // Startup sync check — delay 15s for DB to settle
    setTimeout(() => {
        checkStartupSync().catch(err => {
            console.error('[Scheduler] Startup sync check error:', err.message);
        });
    }, 15000);

    console.log('[Scheduler] ✅ Startup sync check will run in 15s');
}

function getSchedulerStatus() {
    return {
        isRunning,
        schedule: process.env.BOND_SYNC_SCHEDULE || '0 2 */12 * *',
        timezone: 'Asia/Kolkata'
    };
}

module.exports = { startScheduler, getSchedulerStatus, runSync };
