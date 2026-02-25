/**
 * BondHistory Model — field-level change tracking per ISIN
 *
 * Written during sync whenever a field value changes.
 * Enables rating change timeline graphs and audit trail.
 */

const mongoose = require('mongoose');

const bondHistorySchema = new mongoose.Schema({
    isin: {
        type: String,
        required: true,
        uppercase: true,
        index: true
    },

    fieldChanged: {
        type: String,
        required: true
        // e.g. "creditRating", "activeStatus", "isRestructured", "couponRate"
    },

    oldValue: {
        type: mongoose.Schema.Types.Mixed
    },

    newValue: {
        type: mongoose.Schema.Types.Mixed
    },

    changedAt: {
        type: Date,
        default: Date.now,
        index: true
    },

    // Which sync run detected this change
    syncRunId: {
        type: String
    }
}, {
    collection: 'academy_bond_history',
    // No timestamps — changedAt IS the timestamp
});

// Compound index for querying history of a specific ISIN in time order
bondHistorySchema.index({ isin: 1, changedAt: -1 });
bondHistorySchema.index({ fieldChanged: 1, changedAt: -1 });

/**
 * Record a field change
 */
bondHistorySchema.statics.record = async function (isin, fieldChanged, oldValue, newValue, syncRunId) {
    // Only write if values actually differ
    const oldStr = JSON.stringify(oldValue);
    const newStr = JSON.stringify(newValue);
    if (oldStr === newStr) return null;

    return this.create({ isin, fieldChanged, oldValue, newValue, syncRunId, changedAt: new Date() });
};

module.exports = mongoose.model('BondHistory', bondHistorySchema);
