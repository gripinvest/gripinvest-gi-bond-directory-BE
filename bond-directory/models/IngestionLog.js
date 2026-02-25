/**
 * Ingestion Log Model
 * 
 * Tracks every sync run for monitoring and debugging.
 */

const mongoose = require('mongoose');

const ingestionLogSchema = new mongoose.Schema({
    runId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    type: {
        type: String,
        enum: ['daily', 'weekly', 'manual', 'startup'],
        default: 'manual',
    },
    status: {
        type: String,
        enum: ['running', 'completed', 'failed', 'partial'],
        default: 'running',
    },
    startedAt: {
        type: Date,
        default: Date.now,
    },
    completedAt: Date,
    durationMs: Number,

    // Counters
    stats: {
        totalFetched: { type: Number, default: 0 },
        totalEnriched: { type: Number, default: 0 },
        totalCreated: { type: Number, default: 0 },
        totalUpdated: { type: Number, default: 0 },
        totalSkipped: { type: Number, default: 0 },   // Unchanged records
        totalErrors: { type: Number, default: 0 },
    },

    // Endpoints used
    endpoints: [{
        name: String,
        recordCount: Number,
        durationMs: Number,
        success: Boolean,
        error: String,
    }],

    // Individual errors (renamed from 'errors' to avoid Mongoose reserved key)
    syncErrors: [{
        isin: String,
        stage: String,  // 'fetch', 'enrich', 'validate', 'upsert'
        message: String,
        timestamp: { type: Date, default: Date.now },
    }],

    // Circuit breaker state at end of run
    circuitBreakerState: String,

    // Schema drift detection
    schemaDrift: [{
        isin: String,
        missingFields: [String],
        unexpectedFields: [String],
    }],
}, {
    timestamps: true,
    collection: 'academy_ingestion_logs',
});

// Index for querying recent runs
ingestionLogSchema.index({ startedAt: -1 });
ingestionLogSchema.index({ status: 1, startedAt: -1 });

const IngestionLog = mongoose.model('IngestionLog', ingestionLogSchema);

module.exports = IngestionLog;
