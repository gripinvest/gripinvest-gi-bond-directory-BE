/**
 * Bond Directory Routes — MongoDB-First with In-Memory Fallback
 *
 * All endpoints query the `bondsdirectory` MongoDB collection.
 * If MongoDB is unavailable, falls back to in-memory JSON data.
 *
 * Endpoints:
 *   GET /api/bonds           — List bonds (filtered, sorted, paginated)
 *   GET /api/bonds/stats     — Aggregated statistics + rating distribution
 *   GET /api/bonds/maturing-soon — Bonds expiring within N months
 *   GET /api/bonds/search    — Text search by ISIN or issuer name
 *   GET /api/bonds/:isin     — Single bond detail
 *
 *   GET /api/issuers         — List issuers (derived from bonds)
 *   GET /api/issuers/search  — Search issuers by name
 *   GET /api/issuers/:id     — Single issuer with stats
 *   GET /api/issuers/:id/bonds — Bonds for a given issuer
 */

'use strict';

const express = require('express');
const { normalizeRating, getRatingRank, GRADE_RANK } = require('../lib/ratingNormalizer');
const { validate, schemas } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');

// ─── DB Access ────────────────────────────────────────────────────────────────

let collection = null;
let fallbackDb = null; // in-memory fallback

/**
 * Inject the MongoDB collection reference.
 * Called by index.js after connecting to Bond Directory DB.
 */
function setBondCollection(col) {
    collection = col;
}

/**
 * Set fallback in-memory data for when MongoDB is unavailable.
 */
function setFallbackData(data) {
    fallbackDb = data;
}

function isMongoAvailable() {
    return !!collection;
}

// ─── Routers ──────────────────────────────────────────────────────────────────

const bondRoutes = express.Router();
const issuerRoutes = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paginateArray(array, page, limit) {
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const start = (p - 1) * l;
    return {
        data: array.slice(start, start + l),
        total: array.length,
        page: p,
        limit: l,
        pages: Math.ceil(array.length / l),
    };
}

function sendSuccess(res, data, meta = {}) {
    res.json({ success: true, ...data, ...meta, attribution: 'Data sourced from publicly available information via IndiaBondInfo (NSDL)' });
}

function sendError(res, status, message) {
    res.status(status).json({ success: false, error: message });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOND ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /stats ────────────────────────────────────────────────────────────────

bondRoutes.get('/stats', asyncHandler(async (req, res) => {
    try {
        if (isMongoAvailable()) {
            const [totalResult, ratingDist, restructuredCount, issuerCount, topIssuers] = await Promise.all([
                collection.countDocuments(),
                collection.aggregate([
                    { $group: { _id: '$normalizedRating', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]).toArray(),
                collection.countDocuments({ isRestructured: true }),
                collection.aggregate([
                    { $group: { _id: '$issuer.id' } },
                    { $count: 'count' },
                ]).toArray(),
                collection.aggregate([
                    { $match: { 'issuer.id': { $exists: true, $ne: null } } },
                    { $group: { _id: '$issuer.id', name: { $first: '$issuer.name' }, count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 12 },
                ]).toArray(),
            ]);

            const total = totalResult;
            const uniqueIssuers = issuerCount[0]?.count || 0;
            const ratingDistribution = ratingDist.map(r => ({ rating: r._id || 'Unrated', count: r.count }));

            return sendSuccess(res, {
                stats: {
                    total,
                    active: total, // all loaded bonds are active in current dataset
                    matured: 0,
                    restructured: restructuredCount,
                    uniqueIssuers,
                    ratingDistribution,
                    topIssuers: topIssuers.map(r => ({ id: r._id, name: r.name, count: r.count })),
                },
            });
        }

        // Fallback: in-memory
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');

        const ratingAgg = {};
        fallbackDb.bonds.forEach(b => {
            const grade = normalizeRating(b.creditRating) || 'Unrated';
            ratingAgg[grade] = (ratingAgg[grade] || 0) + 1;
        });

        const ratingDistribution = Object.entries(ratingAgg)
            .map(([rating, count]) => ({ rating, count }))
            .sort((a, b) => b.count - a.count);

        sendSuccess(res, {
            stats: {
                total: fallbackDb.bonds.length,
                active: fallbackDb.stats.totalActive,
                matured: 0,
                restructured: fallbackDb.bonds.filter(b => b.isRestructured).length,
                uniqueIssuers: fallbackDb.stats.uniqueIssuers,
                ratingDistribution,
            },
        });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /maturing-soon ───────────────────────────────────────────────────────

bondRoutes.get('/maturing-soon', validate(schemas.maturingSoonSchema), asyncHandler(async (req, res) => {
    try {
        const { months = 6, page = 1, limit = 50, ratingNorm } = req.query;
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const cutoff = new Date(now);
        cutoff.setMonth(cutoff.getMonth() + parseInt(months) || 6);

        if (isMongoAvailable()) {
            const filter = {
                maturityDate: { $gte: now, $lte: cutoff },
            };
            if (ratingNorm) filter.normalizedRating = ratingNorm;

            const p = Math.max(1, parseInt(page) || 1);
            const l = Math.min(200, Math.max(1, parseInt(limit) || 50));

            const [bonds, total] = await Promise.all([
                collection.find(filter).sort({ maturityDate: 1 }).skip((p - 1) * l).limit(l).toArray(),
                collection.countDocuments(filter),
            ]);

            return sendSuccess(res, {
                window: { from: now.toISOString().slice(0, 10), to: cutoff.toISOString().slice(0, 10), months: parseInt(months) || 6 },
                bonds,
                pagination: { total, page: p, limit: l, pages: Math.ceil(total / l), totalPages: Math.ceil(total / l) },
            });
        }

        // Fallback: in-memory
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');

        let maturing = fallbackDb.bonds.filter(b => {
            if (!b.maturityDate) return false;
            const m = new Date(b.maturityDate);
            return m >= now && m <= cutoff;
        });
        if (ratingNorm) maturing = maturing.filter(b => normalizeRating(b.creditRating) === ratingNorm);
        maturing.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));

        const paginated = paginateArray(maturing, page, limit);
        sendSuccess(res, {
            window: { from: now.toISOString().slice(0, 10), to: cutoff.toISOString().slice(0, 10), months: parseInt(months) || 6 },
            bonds: paginated.data,
            pagination: { total: paginated.total, page: paginated.page, limit: paginated.limit, pages: paginated.pages, totalPages: paginated.pages },
        });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /search ──────────────────────────────────────────────────────────────

bondRoutes.get('/search', validate(schemas.searchSchema), asyncHandler(async (req, res) => {
    try {
        const { q, limit = 10, status } = req.query;
        if (!q || q.trim().length < 2) return sendSuccess(res, { results: [], query: q || '', count: 0 });

        const safeQ = q.trim();
        const lim = Math.min(50, Math.max(1, parseInt(limit) || 10));

        if (isMongoAvailable()) {
            // Escape regex special chars for safety
            const escaped = safeQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const isinMatch = safeQ.toUpperCase();

            const filter = {
                $or: [
                    { isin: { $regex: isinMatch, $options: 'i' } },
                    { 'issuer.name': { $regex: escaped, $options: 'i' } },
                ],
            };
            if (status && status !== 'all') filter.activeStatus = status;

            const results = await collection.find(filter).limit(lim).toArray();
            return sendSuccess(res, { query: safeQ, count: results.length, results });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        let results = fallbackDb.bonds.filter(b =>
            (b.isin && b.isin.includes(safeQ.toUpperCase())) ||
            (b.issuer?.name && b.issuer.name.toLowerCase().includes(safeQ.toLowerCase()))
        );
        if (status && status !== 'all') results = results.filter(b => b.activeStatus?.toLowerCase() === status.toLowerCase());
        sendSuccess(res, { query: safeQ, count: Math.min(results.length, lim), results: results.slice(0, lim) });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /:isin ───────────────────────────────────────────────────────────────

bondRoutes.get('/:isin', asyncHandler(async (req, res) => {
    try {
        const isin = req.params.isin.toUpperCase();

        if (isMongoAvailable()) {
            const bond = await collection.findOne({ isin });
            if (!bond) return sendError(res, 404, `Bond ${isin} not found`);

            const [relatedBonds, sameRatingBonds] = await Promise.all([
                collection.find({ 'issuer.id': bond.issuer?.id, isin: { $ne: isin } }).limit(8).toArray(),
                bond.normalizedRating && bond.normalizedRating !== 'Unrated'
                    ? collection.find({ normalizedRating: bond.normalizedRating, 'issuer.id': { $ne: bond.issuer?.id } }).limit(5).toArray()
                    : Promise.resolve([]),
            ]);

            return sendSuccess(res, { bond, relatedBonds, sameRatingBonds, changeHistory: [] });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        const bond = fallbackDb.bonds.find(b => b.isin === isin);
        if (!bond) return sendError(res, 404, `Bond ${isin} not found`);

        const relatedBonds = fallbackDb.bonds.filter(b => b.issuer?.id === bond.issuer?.id && b.isin !== isin).slice(0, 8);
        const sameRatingBonds = bond.creditRating
            ? fallbackDb.bonds.filter(b => b.creditRating === bond.creditRating && b.issuer?.id !== bond.issuer?.id).slice(0, 5)
            : [];
        sendSuccess(res, { bond, relatedBonds, sameRatingBonds, changeHistory: [] });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET / ────────────────────────────────────────────────────────────────────

bondRoutes.get('/', validate(schemas.bondsListSchema), asyncHandler(async (req, res) => {
    try {
        const { page = 1, limit = 50, sort, activeStatus, bondType, issuer, rating, ratingNorm, maturityYear, isRestructured, minRate, maxRate } = req.query;

        const p = Math.max(1, parseInt(page) || 1);
        const l = Math.min(200, Math.max(1, parseInt(limit) || 50));

        if (isMongoAvailable()) {
            const filter = {};
            if (activeStatus && activeStatus !== 'all') filter.activeStatus = { $regex: `^${activeStatus}$`, $options: 'i' };
            if (bondType) filter.bondsType = { $regex: `^${bondType}$`, $options: 'i' };
            if (issuer) filter['issuer.id'] = { $regex: issuer.toLowerCase().replace(/\s+/g, '-'), $options: 'i' };
            if (rating) filter.creditRating = { $regex: `^${rating}$`, $options: 'i' };
            if (ratingNorm) filter.normalizedRating = ratingNorm;
            if (maturityYear) {
                const yr = parseInt(maturityYear);
                filter.maturityDate = {
                    $gte: new Date(`${yr}-01-01`),
                    $lt: new Date(`${yr + 1}-01-01`),
                };
            }
            if (isRestructured === 'true') filter.isRestructured = true;
            if (minRate || maxRate) {
                filter.couponRate = {};
                if (minRate) filter.couponRate.$gte = parseFloat(minRate);
                if (maxRate) filter.couponRate.$lte = parseFloat(maxRate);
            }

            // Build sort object
            let sortObj = { normalizedRating: 1 }; // default: best rating first
            const sortParam = sort || 'rating:desc';
            if (sortParam === 'rating:desc' || sortParam === 'rating') sortObj = { normalizedRating: 1 };
            else if (sortParam === 'rating:asc') sortObj = { normalizedRating: -1 };
            else if (sortParam === 'couponRate:desc' || sortParam === 'couponRate') sortObj = { couponRate: -1 };
            else if (sortParam === 'couponRate:asc') sortObj = { couponRate: 1 };
            else if (sortParam === 'maturityDate:asc' || sortParam === 'maturityDate') sortObj = { maturityDate: 1 };
            else if (sortParam === 'maturityDate:desc') sortObj = { maturityDate: -1 };

            const [bonds, total] = await Promise.all([
                collection.find(filter).sort(sortObj).skip((p - 1) * l).limit(l).toArray(),
                collection.countDocuments(filter),
            ]);

            return sendSuccess(res, {
                bonds,
                pagination: { total, page: p, limit: l, pages: Math.ceil(total / l), totalPages: Math.ceil(total / l) },
            });
        }

        // Fallback: in-memory
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');

        let filtered = [...fallbackDb.bonds];
        if (activeStatus && activeStatus !== 'all') filtered = filtered.filter(b => b.activeStatus?.toLowerCase() === activeStatus.toLowerCase());
        if (bondType) filtered = filtered.filter(b => b.bondsType?.toLowerCase() === bondType.toLowerCase());
        if (issuer) filtered = filtered.filter(b => b.issuer?.id?.includes(issuer.toLowerCase().replace(/\s+/g, '-')));
        if (rating) filtered = filtered.filter(b => b.creditRating?.toUpperCase() === rating.toUpperCase());
        if (ratingNorm) filtered = filtered.filter(b => normalizeRating(b.creditRating) === ratingNorm);
        if (maturityYear) { const yr = parseInt(maturityYear); filtered = filtered.filter(b => b.maturityDate && new Date(b.maturityDate).getFullYear() === yr); }
        if (isRestructured === 'true') filtered = filtered.filter(b => b.isRestructured);
        if (minRate) filtered = filtered.filter(b => b.couponRate >= parseFloat(minRate));
        if (maxRate) filtered = filtered.filter(b => b.couponRate <= parseFloat(maxRate));

        const sortParam = sort || 'rating:desc';
        if (sortParam === 'rating:desc' || sortParam === 'rating') {
            filtered.sort((a, b) => getRatingRank(normalizeRating(a.creditRating)) - getRatingRank(normalizeRating(b.creditRating)));
        } else if (sortParam === 'rating:asc') {
            filtered.sort((a, b) => getRatingRank(normalizeRating(b.creditRating)) - getRatingRank(normalizeRating(a.creditRating)));
        } else if (sortParam === 'couponRate:desc' || sortParam === 'couponRate') {
            filtered.sort((a, b) => (b.couponRate || 0) - (a.couponRate || 0));
        } else if (sortParam === 'couponRate:asc') {
            filtered.sort((a, b) => (a.couponRate || 0) - (b.couponRate || 0));
        } else if (sortParam === 'maturityDate:asc' || sortParam === 'maturityDate') {
            filtered.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
        } else if (sortParam === 'maturityDate:desc') {
            filtered.sort((a, b) => new Date(b.maturityDate) - new Date(a.maturityDate));
        }

        const paginated = paginateArray(filtered, page, limit);
        sendSuccess(res, {
            bonds: paginated.data,
            pagination: { total: paginated.total, page: paginated.page, limit: paginated.limit, pages: paginated.pages, totalPages: paginated.pages },
        });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  ISSUER ROUTES (derived from bonds via aggregation)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /issuers/search ──────────────────────────────────────────────────────

issuerRoutes.get('/search', asyncHandler(async (req, res) => {
    try {
        const { q, limit = 5 } = req.query;
        if (!q || q.trim().length < 2) return sendSuccess(res, { results: [] });

        const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lim = Math.min(20, Math.max(1, parseInt(limit) || 5));

        if (isMongoAvailable()) {
            const results = await collection.aggregate([
                { $match: { 'issuer.name': { $regex: escaped, $options: 'i' } } },
                {
                    $group: {
                        _id: '$issuer.id',
                        name: { $first: '$issuer.name' },
                        sector: { $first: '$issuer.sector' },
                        issuerType: { $first: '$issuer.issuerType' },
                        ownershipType: { $first: '$issuer.ownershipType' },
                        totalActiveBonds: { $sum: 1 },
                    }
                },
                { $sort: { totalActiveBonds: -1 } },
                { $limit: lim },
                { $project: { _id: 0, id: '$_id', name: 1, sector: 1, issuerType: 1, ownershipType: 1, totalActiveBonds: 1 } },
            ]).toArray();

            return sendSuccess(res, { query: q, results });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        const results = fallbackDb.issuers.filter(i => i.name.toLowerCase().includes(q.toLowerCase())).slice(0, lim);
        sendSuccess(res, { query: q, results });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /issuers/:id/bonds ───────────────────────────────────────────────────

issuerRoutes.get('/:id/bonds', validate(schemas.issuerBondsSchema), asyncHandler(async (req, res) => {
    try {
        const issuerId = req.params.id.toLowerCase();
        const { page = 1, limit = 50, activeStatus, creditRating, minRate, maxRate, sort } = req.query;

        const p = Math.max(1, parseInt(page) || 1);
        const l = Math.min(200, Math.max(1, parseInt(limit) || 50));

        if (isMongoAvailable()) {
            const filter = { 'issuer.id': issuerId };
            if (activeStatus) filter.activeStatus = { $regex: `^${activeStatus}$`, $options: 'i' };
            if (creditRating) filter.creditRating = { $regex: `^${creditRating}$`, $options: 'i' };
            if (minRate || maxRate) {
                filter.couponRate = {};
                if (minRate) filter.couponRate.$gte = parseFloat(minRate);
                if (maxRate) filter.couponRate.$lte = parseFloat(maxRate);
            }

            const sortObj = sort === 'couponRate' ? { couponRate: -1 } : sort === 'rating' ? { normalizedRating: 1 } : { maturityDate: 1 };

            const [bonds, total] = await Promise.all([
                collection.find(filter).sort(sortObj).skip((p - 1) * l).limit(l).toArray(),
                collection.countDocuments(filter),
            ]);

            return sendSuccess(res, { issuerId, bonds, pagination: { total, page: p, limit: l, pages: Math.ceil(total / l) } });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        let filtered = fallbackDb.bonds.filter(b => b.issuer?.id === issuerId);
        if (activeStatus) filtered = filtered.filter(b => b.activeStatus?.toLowerCase() === activeStatus.toLowerCase());
        if (creditRating) filtered = filtered.filter(b => b.creditRating?.toUpperCase() === creditRating.toUpperCase());
        if (minRate) filtered = filtered.filter(b => b.couponRate >= parseFloat(minRate));
        if (maxRate) filtered = filtered.filter(b => b.couponRate <= parseFloat(maxRate));

        const sortField = sort === 'couponRate' ? 'couponRate' : sort === 'rating' ? 'creditRating' : 'maturityDate';
        const sortOrder = sort === 'couponRate' ? -1 : 1;
        filtered.sort((a, b) => {
            const va = a[sortField] || 0;
            const vb = b[sortField] || 0;
            return va > vb ? sortOrder : va < vb ? -sortOrder : 0;
        });

        const paginated = paginateArray(filtered, page, limit);
        sendSuccess(res, { issuerId, bonds: paginated.data, pagination: { total: paginated.total, page: paginated.page, limit: paginated.limit, pages: paginated.pages } });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /issuers/:id ─────────────────────────────────────────────────────────

issuerRoutes.get('/:id', asyncHandler(async (req, res) => {
    try {
        const issuerId = req.params.id.toLowerCase();

        if (isMongoAvailable()) {
            const [issuerAgg, ratingDist, maturityDist, couponStats] = await Promise.all([
                // Basic issuer info + counts
                collection.aggregate([
                    { $match: { 'issuer.id': issuerId } },
                    {
                        $group: {
                            _id: '$issuer.id',
                            name: { $first: '$issuer.name' },
                            sector: { $first: '$issuer.sector' },
                            ownershipType: { $first: '$issuer.ownershipType' },
                            issuerType: { $first: '$issuer.issuerType' },
                            latestRating: { $first: '$issuer.latestRating' },
                            totalActiveBonds: { $sum: 1 },
                        }
                    },
                ]).toArray(),

                // Rating distribution
                collection.aggregate([
                    { $match: { 'issuer.id': issuerId, normalizedRating: { $ne: null } } },
                    { $group: { _id: '$normalizedRating', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]).toArray(),

                // Maturity distribution by year
                collection.aggregate([
                    { $match: { 'issuer.id': issuerId, maturityDate: { $ne: null } } },
                    { $group: { _id: { $year: '$maturityDate' }, count: { $sum: 1 } } },
                    { $sort: { _id: 1 } },
                    { $limit: 20 },
                ]).toArray(),

                // Coupon rate stats
                collection.aggregate([
                    { $match: { 'issuer.id': issuerId, couponRate: { $gt: 0 } } },
                    { $group: { _id: null, min: { $min: '$couponRate' }, max: { $max: '$couponRate' }, avg: { $avg: '$couponRate' } } },
                ]).toArray(),
            ]);

            if (!issuerAgg.length) return sendError(res, 404, `Issuer '${issuerId}' not found`);

            const iss = issuerAgg[0];
            const cs = couponStats[0] || { min: 0, max: 0, avg: 0 };

            return sendSuccess(res, {
                issuer: {
                    id: iss._id,
                    name: iss.name,
                    sector: iss.sector,
                    ownershipType: iss.ownershipType,
                    issuerType: iss.issuerType,
                    latestRating: iss.latestRating,
                    totalActiveBonds: iss.totalActiveBonds,
                    totalMaturedBonds: 0,
                    ratingDistribution: ratingDist.map(r => ({ rating: r._id, count: r.count })),
                    maturityDistribution: maturityDist.map(r => ({ year: r._id, count: r.count })),
                    couponRateRange: {
                        min: +(cs.min || 0).toFixed(2),
                        max: +(cs.max || 0).toFixed(2),
                        avg: +(cs.avg || 0).toFixed(2),
                    },
                },
            });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        const issuer = fallbackDb.issuers.find(i => i.id === issuerId);
        if (!issuer) return sendError(res, 404, `Issuer '${issuerId}' not found`);

        issuer.maturityDistribution = [];
        issuer.couponRateRange = { min: issuer.avgCouponRate, max: issuer.avgCouponRate, avg: issuer.avgCouponRate };
        issuer.totalMaturedBonds = 0;
        sendSuccess(res, { issuer });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

// ─── GET /issuers ─────────────────────────────────────────────────────────────

issuerRoutes.get('/', validate(schemas.issuerListSchema), asyncHandler(async (req, res) => {
    try {
        const { page = 1, limit = 50, issuerType, ownershipType, sector, sort, q } = req.query;
        const p = Math.max(1, parseInt(page) || 1);
        const l = Math.min(200, Math.max(1, parseInt(limit) || 50));

        if (isMongoAvailable()) {
            // Build match stage
            const matchStage = {};
            if (issuerType) matchStage['issuer.issuerType'] = { $regex: issuerType, $options: 'i' };
            if (ownershipType) matchStage['issuer.ownershipType'] = ownershipType.toLowerCase();
            if (sector) matchStage['issuer.sector'] = { $regex: sector, $options: 'i' };
            if (q) {
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                matchStage['issuer.name'] = { $regex: escaped, $options: 'i' };
            }

            const sortField = sort === 'name' ? 'name' : 'totalActiveBonds';
            const sortDir = sort === 'name' ? 1 : -1;

            // Use $facet for count + paginated data in one query
            const result = await collection.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: '$issuer.id',
                        name: { $first: '$issuer.name' },
                        sector: { $first: '$issuer.sector' },
                        issuerType: { $first: '$issuer.issuerType' },
                        ownershipType: { $first: '$issuer.ownershipType' },
                        totalActiveBonds: { $sum: 1 },
                        avgCouponRate: { $avg: '$couponRate' },
                    }
                },
                {
                    $facet: {
                        metadata: [{ $count: 'total' }],
                        data: [
                            { $sort: { [sortField]: sortDir } },
                            { $skip: (p - 1) * l },
                            { $limit: l },
                            { $project: { _id: 0, id: '$_id', name: 1, sector: 1, issuerType: 1, ownershipType: 1, totalActiveBonds: 1, avgCouponRate: { $round: ['$avgCouponRate', 2] } } },
                        ],
                    }
                },
            ]).toArray();

            const total = result[0]?.metadata[0]?.total || 0;
            const issuers = result[0]?.data || [];

            return sendSuccess(res, {
                issuers,
                pagination: { total, page: p, limit: l, pages: Math.ceil(total / l) },
            });
        }

        // Fallback
        if (!fallbackDb) return sendError(res, 503, 'Bond data not available');
        let filtered = [...fallbackDb.issuers];
        if (issuerType) filtered = filtered.filter(i => i.issuerType?.toLowerCase().includes(issuerType.toLowerCase()));
        if (ownershipType) filtered = filtered.filter(i => i.ownershipType?.toLowerCase() === ownershipType.toLowerCase());
        if (sector) filtered = filtered.filter(i => i.sector?.toLowerCase().includes(sector.toLowerCase()));
        if (q) filtered = filtered.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));

        const sortField = sort === 'name' ? 'name' : 'totalActiveBonds';
        const sortOrder = sort === 'name' ? 1 : -1;
        filtered.sort((a, b) => {
            const va = a[sortField] || 0;
            const vb = b[sortField] || 0;
            return va > vb ? sortOrder : va < vb ? -sortOrder : 0;
        });

        const paginated = paginateArray(filtered, page, limit);
        sendSuccess(res, {
            issuers: paginated.data,
            pagination: { total: paginated.total, page: paginated.page, limit: paginated.limit, pages: paginated.pages },
        });
    } catch (e) {
        sendError(res, 500, e.message);
    }
}));

module.exports = {
    mockBondRoutes: bondRoutes,
    mockIssuerRoutes: issuerRoutes,
    setBondCollection,
    setFallbackData,
};
