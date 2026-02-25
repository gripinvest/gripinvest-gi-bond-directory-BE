/**
 * Issuer Model — Normalized issuer collection
 *
 * Populated during bond sync. Each unique issuer gets one document.
 * Bonds reference issuers via issuer.id (slug).
 */

const mongoose = require('mongoose');

const issuerSchema = new mongoose.Schema({
    // Slug-based unique ID (e.g. "state-bank-of-india")
    id: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true,
    },

    name: {
        type: String,
        required: true,
        trim: true,
    },

    sector: {
        type: String,
        trim: true,
    },

    issuerType: {
        type: String,
        trim: true,
        // e.g. "Corporate", "PSU", "Government", "Financial Institution"
    },

    ownershipType: {
        type: String,
        enum: ['private', 'psu', 'government', 'unknown'],
        default: 'unknown',
    },

    // Rolling counts updated on every sync
    totalActiveBonds: {
        type: Number,
        default: 0,
    },

    totalMaturedBonds: {
        type: Number,
        default: 0,
    },

    // Rating distribution snapshot — { "AAA": 3, "AA+": 1, "AA": 2 }
    ratingSummary: {
        type: Map,
        of: Number,
        default: {},
    },

    // Avg coupon rate across active bonds
    avgCouponRate: {
        type: Number,
        default: 0,
    },

    // For text search
    searchText: {
        type: String,
    },
}, {
    timestamps: true,
    collection: 'academy_issuers',
});

// Text search index
issuerSchema.index({ name: 'text', searchText: 'text' }, { weights: { name: 10 }, name: 'issuer_text_search' });
issuerSchema.index({ issuerType: 1 });
issuerSchema.index({ ownershipType: 1 });
issuerSchema.index({ totalActiveBonds: -1 });

// Pre-save: generate searchText
issuerSchema.pre('save', function (next) {
    this.searchText = `${this.name} ${this.sector || ''} ${this.issuerType || ''}`;
    next();
});

// Static: find or create by slug
issuerSchema.statics.upsertFromBond = async function (issuerData) {
    return this.findOneAndUpdate(
        { id: issuerData.id },
        {
            $set: {
                name: issuerData.name,
                sector: issuerData.sector || undefined,
                issuerType: issuerData.issuerType || undefined,
                ownershipType: issuerData.ownershipType || 'unknown',
                searchText: `${issuerData.name} ${issuerData.sector || ''} ${issuerData.issuerType || ''}`,
            },
        },
        { upsert: true, new: true },
    );
};

module.exports = mongoose.model('Issuer', issuerSchema);
