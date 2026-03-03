/**
 * Bond Sync Scheduler — STUB (ETL not yet implemented)
 *
 * TODO: This scheduler requires `../lib/etl/bondSync` which does not yet exist.
 * Before enabling this scheduler, you must implement:
 *   - bond-directory/lib/etl/bondSync.js  (exports `syncBonds({ type, deepSync })`)
 *   - Connect Mongoose to the database (app currently uses only the native driver)
 *   - Ensure IngestionLog model uses the same DB connection as the rest of the app
 *
 * Schedule (once ETL is ready):
 *   - Every 12 days at 2:00 AM IST (configurable via BOND_SYNC_SCHEDULE env)
 *   - Deep sync: Sundays at 3:00 AM IST
 *   - Startup check: runs sync if last successful run was > 12 days ago
 *
 * Usage (once implemented): Call startScheduler() after MongoDB is connected.
 */

'use strict';

// const cron = require('node-cron');
// const { syncBonds } = require('../lib/etl/bondSync'); // TODO: not yet implemented
// const IngestionLog = require('../models/IngestionLog');  // TODO: requires mongoose.connect()

// eslint-disable-next-line prefer-const -- will be reassigned once ETL is implemented
let isRunning = false;

/**
 * TODO: Implement once bondSync ETL module exists.
 * Run sync with guard against concurrent runs.
 */
async function runSync(type) {
    if (isRunning) {
        console.log(`[Scheduler] ⏭️  Sync already in progress — skipping ${type} run`);
        return null;
    }
    console.warn('[Scheduler] ⚠️  ETL not implemented — runSync() is a no-op. See bond-directory/jobs/syncScheduler.js for setup instructions.');
    return null;
}

/**
 * TODO: Implement once bondSync ETL module exists.
 * Set up cron jobs for periodic bond sync.
 */
function startScheduler() {
    console.warn('[Scheduler] ⚠️  Scheduler is disabled — ETL (bondSync) not yet implemented.');
    console.warn('[Scheduler]    See bond-directory/jobs/syncScheduler.js for implementation notes.');
    // Uncomment and implement when bondSync is ready:
    //
    // const schedule = process.env.BOND_SYNC_SCHEDULE || '0 2 */12 * *';
    // cron.schedule(schedule, () => { runSync('periodic', false); }, { timezone: 'Asia/Kolkata' });
    // cron.schedule('0 3 * * 0', () => { runSync('weekly', true); }, { timezone: 'Asia/Kolkata' });
    // setTimeout(() => checkStartupSync().catch(console.error), 15000);
}

function getSchedulerStatus() {
    return {
        isRunning,
        etlImplemented: false,
        schedule: process.env.BOND_SYNC_SCHEDULE || '0 2 */12 * *',
        timezone: 'Asia/Kolkata',
    };
}

module.exports = { startScheduler, getSchedulerStatus, runSync };
