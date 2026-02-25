const mongoose = require('mongoose');

/**
 * Bond Schema for MongoDB
 *
 * Design: Denormalized (embedded issuer data) for fast reads by ISIN
 * Issuer collection (Issuer.js) is kept in sync for issuer-level queries
 * Target: 50,000+ bonds with <10ms lookup by ISIN
 */
const bondSchema = new mongoose.Schema({

    // ─── PRIMARY KEY ─────────────────────────────────────────────────────────
    isin: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        validate: {
            validator: v => /^[A-Z]{2}[A-Z0-9]{10}$/.test(v),
            message: 'Invalid ISIN format. Must be 2 letters + 10 alphanumeric characters',
        },
        index: true,
    },

    // ─── ISSUER (EMBEDDED/DENORMALIZED) ──────────────────────────────────────
    issuer: {
        id: {
            type: String,
            required: true,
            index: true,
            lowercase: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        sector: { type: String, trim: true },
        ownershipType: {
            type: String,
            enum: ['private', 'psu', 'government', 'unknown'],
            lowercase: true,
            default: 'unknown',
        },
        issuerType: { type: String, trim: true },
        latestRating: String,
        description: String,
    },

    // ─── BOND CORE DETAILS ───────────────────────────────────────────────────
    couponRate: {
        type: Number,
        min: 0,
        max: 100,
        default: 0,
    },
    couponType: {
        type: String,
        enum: ['fixed', 'floating', 'zero', 'unknown'],
        default: 'fixed',
        lowercase: true,
    },
    couponFrequency: {
        type: String,
        enum: ['annual', 'semi-annual', 'quarterly', 'monthly', null],
        lowercase: true,
    },
    maturityDate: {
        type: Date,
        index: true,
    },
    issueDate: Date,
    faceValue: Number,
    minInvestment: Number,
    issueSize: Number,

    // ─── CREDIT RATING ───────────────────────────────────────────────────────
    creditRating: {
        type: String,
        trim: true,
        index: true,
    // e.g. "AAA", "AA+", "AA", "AA-", "A+", "BBB", "D"
    },
    ratingAgency: {
        type: String,
        trim: true,
    // e.g. "CRISIL", "ICRA", "CARE", "India Ratings", "ACUITE"
    },
    interestRateCategory: {
        type: String,
        trim: true,
    // Range bucket from /interestratewise e.g. "8-9%", "9-10%"
    },

    // ─── STATUS FLAGS ────────────────────────────────────────────────────────
    activeStatus: {
        type: String,
        enum: ['Active', 'Matured'],
        default: 'Active',
        index: true,
    },
    isRestructured: {
        type: Boolean,
        default: false,
        index: true,
    },
    secured: Boolean,
    taxFree: {
        type: Boolean,
        default: false,
    },
    issuerType: {
        type: String,
        trim: true,
        index: true,
    },

    // ─── LISTING ─────────────────────────────────────────────────────────────
    listingExchange: {
        type: String,
        enum: ['NSE', 'BSE', 'Both', null],
    },
    bondType: {
        type: String,
        enum: ['corporate', 'psu', 'gsec', 'sdl', 'tax-free', 'unknown'],
        index: true,
        lowercase: true,
        default: 'corporate',
    },

    // ─── EMBEDDED ARRAYS ─────────────────────────────────────────────────────
    couponSchedule: [{
        date: Date,
        amount: Number,
        status: {
            type: String,
            enum: ['paid', 'upcoming', 'future'],
            default: 'future',
        },
    }],

    ratingHistory: [{
        agency: String,
        value: String,
        date: Date,
        outlook: {
            type: String,
            enum: ['stable', 'positive', 'negative', null],
        },
    }],

    // ─── SEARCH OPTIMIZATION ─────────────────────────────────────────────────
    searchText: {
        type: String,
    },

    // ─── METADATA ────────────────────────────────────────────────────────────
    dataSource: {
        type: String,
        default: 'IndiaBondInfo-NSDL',
    },
    apiResponseRaw: mongoose.Schema.Types.Mixed,
    lastSyncedAt: {
        type: Date,
        index: true,
    },
}, {
    timestamps: true,
    collection: 'academy_bonds',
});

// ─── INDEXES ─────────────────────────────────────────────────────────────────

// Text search index — weighted for relevance
bondSchema.index({
    'issuer.name': 'text',
    isin: 'text',
    searchText: 'text',
    creditRating: 'text',
}, {
    weights: {
        'issuer.name': 10,
        isin: 8,
        creditRating: 4,
        searchText: 2,
    },
    name: 'bond_text_search',
});

// Compound indexes for common filters
bondSchema.index({ activeStatus: 1, bondType: 1, maturityDate: 1 }, { name: 'filter_status_type_maturity' });
bondSchema.index({ activeStatus: 1, creditRating: 1 }, { name: 'filter_status_rating' });
bondSchema.index({ 'issuer.id': 1, activeStatus: 1 }, { name: 'issuer_active_bonds' });
bondSchema.index({ isRestructured: 1, activeStatus: 1 }, { name: 'restructured_active' });
bondSchema.index({ couponRate: -1, activeStatus: 1 }, { name: 'coupon_rate_desc' });

// ─── VIRTUAL FIELDS ───────────────────────────────────────────────────────────

bondSchema.virtual('slug').get(function () {
    return `${this.isin}-${this.issuer.id}`.toLowerCase();
});

bondSchema.virtual('yearsToMaturity').get(function () {
    if (!this.maturityDate) return null;
    const diffTime = this.maturityDate - new Date();
    const diffYears = diffTime / (1000 * 60 * 60 * 24 * 365);
    return Math.max(0, diffYears).toFixed(2);
});

// ─── HOOKS ───────────────────────────────────────────────────────────────────

bondSchema.pre('save', function (next) {
    this.searchText = [
        this.issuer?.name,
        this.isin,
        this.creditRating,
        this.ratingAgency,
        this.bondType,
        this.issuerType,
    ].filter(Boolean).join(' ');
    next();
});

bondSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate();
    if (update.$set) {
    // Regenerate searchText on updates
        const fields = update.$set;
        if (fields['issuer.name'] || fields.creditRating || fields.issuerType) {
            // Will be regenerated on next full save; mark for re-index
        }
        update.$set.lastSyncedAt = new Date();
    }
    next();
});

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

bondSchema.statics.findByIsin = function (isin) {
    return this.findOne({ isin: isin.toUpperCase() });
};

bondSchema.statics.findByIssuer = function (issuerId, status = 'Active') {
    return this.find({ 'issuer.id': issuerId, activeStatus: status });
};

/**
 * Full-text search using MongoDB text index.
 * Falls back to regex search for short queries.
 */
bondSchema.statics.searchBonds = function (query, limit = 10) {
    const trimmed = query.trim();

    // For 12-char ISIN-like queries, do exact prefix match
    if (/^[A-Z]{2}[A-Z0-9]+$/i.test(trimmed) && trimmed.length >= 4) {
        return this.find({ isin: { $regex: `^${trimmed.toUpperCase()}` } })
            .select('isin issuer.name issuer.id couponRate creditRating maturityDate activeStatus isRestructured bondType')
            .limit(limit)
            .lean();
    }

    // For short or name queries, use text index
    return this.find(
        { $text: { $search: trimmed } },
        { score: { $meta: 'textScore' } },
    )
        .select('isin issuer.name issuer.id couponRate creditRating maturityDate activeStatus isRestructured bondType')
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .lean();
};

// ─── METHODS ─────────────────────────────────────────────────────────────────

bondSchema.methods.toPublicJSON = function () {
    return {
        isin: this.isin,
        issuer: this.issuer,
        couponRate: this.couponRate,
        couponType: this.couponType,
        couponFrequency: this.couponFrequency,
        maturityDate: this.maturityDate,
        issueDate: this.issueDate,
        faceValue: this.faceValue,
        minInvestment: this.minInvestment,
        issueSize: this.issueSize,
        creditRating: this.creditRating,
        ratingAgency: this.ratingAgency,
        interestRateCategory: this.interestRateCategory,
        activeStatus: this.activeStatus,
        isRestructured: this.isRestructured,
        secured: this.secured,
        taxFree: this.taxFree,
        listingExchange: this.listingExchange,
        bondType: this.bondType,
        issuerType: this.issuerType,
        ratingHistory: this.ratingHistory,
        couponSchedule: this.couponSchedule,
        lastSyncedAt: this.lastSyncedAt,
        slug: this.slug,
        yearsToMaturity: this.yearsToMaturity,
    };
};

module.exports = mongoose.model('Bond', bondSchema);
