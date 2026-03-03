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
 *   GET /api/bonds/search    — Text search by ISIN or issuer name (paginated)
 *   GET /api/bonds/:isin     — Single bond detail
 *
 *   GET /api/issuers         — List issuers (derived from bonds)
 *   GET /api/issuers/search  — Search issuers by name (paginated)
 *   GET /api/issuers/:id     — Single issuer with stats
 *   GET /api/issuers/:id/bonds — Bonds for a given issuer
 */

'use strict';

const express = require('express');
const { normalizeRating, getRatingRank } = require('../lib/ratingNormalizer');
const { validate, schemas } = require('../middleware/validate');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const {
    MAX_PAGE_LIMIT,
    DEFAULT_PAGE_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    RELATED_BONDS_LIMIT,
    SAME_RATING_LIMIT,
    TOP_ISSUERS_LIMIT,
} = require('../config/constants');

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

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/**
 * Parse and clamp page + limit from validated query.
 * After Zod coercion, values are already numbers — no parseInt needed.
 */
function parsePagination(query) {
    const pageNum = Math.max(1, query.page || 1);
    const pageSize = Math.min(MAX_PAGE_LIMIT, Math.max(1, query.limit || DEFAULT_PAGE_LIMIT));
    return { pageNum, pageSize };
}

/**
 * Build a standard pagination meta object.
 */
function toPaginationMeta(total, pageNum, pageSize) {
    const totalPages = Math.ceil(total / pageSize);
    return { total, page: pageNum, limit: pageSize, pages: totalPages, totalPages };
}

/**
 * Paginate an in-memory array.
 */
function paginateArray(array, pageNum, pageSize) {
    const start = (pageNum - 1) * pageSize;
    const data = array.slice(start, start + pageSize);
    return { data, ...toPaginationMeta(array.length, pageNum, pageSize) };
}

/**
 * Escape user input for safe use in MongoDB $regex filters.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return a MongoDB sort object AND an in-memory comparator for the given sort param.
 * Uses `ratingRank` (numeric) for MongoDB so "best rating first" works correctly.
 */
function getBondSort(sortParam) {
    switch (sortParam) {
        case 'rating:asc':
            return {
                mongoSort: { ratingRank: -1 }, // higher rank = worse rating
                memorySort: (a, b) => getRatingRank(normalizeRating(b.creditRating)) - getRatingRank(normalizeRating(a.creditRating)),
            };
        case 'couponRate:desc':
        case 'couponRate':
            return {
                mongoSort: { couponRate: -1 },
                memorySort: (a, b) => (b.couponRate || 0) - (a.couponRate || 0),
            };
        case 'couponRate:asc':
            return {
                mongoSort: { couponRate: 1 },
                memorySort: (a, b) => (a.couponRate || 0) - (b.couponRate || 0),
            };
        case 'maturityDate:desc':
            return {
                mongoSort: { maturityDate: -1 },
                memorySort: (a, b) => new Date(b.maturityDate) - new Date(a.maturityDate),
            };
        case 'maturityDate:asc':
        case 'maturityDate':
            return {
                mongoSort: { maturityDate: 1 },
                memorySort: (a, b) => new Date(a.maturityDate) - new Date(b.maturityDate),
            };
        case 'rating:desc':
        case 'rating':
        default:
            // ratingRank ascending = best rating first (AAA=1)
            return {
                mongoSort: { ratingRank: 1 },
                memorySort: (a, b) => getRatingRank(normalizeRating(a.creditRating)) - getRatingRank(normalizeRating(b.creditRating)),
            };
    }
}

/**
 * Guard: ensure fallback data is available or throw a 503.
 */
function requireFallback() {
    if (!fallbackDb) throw new AppError('Bond data not available', 503, 'DATA_UNAVAILABLE');
}

/**
 * Shared response shape for every successful API response.
 */
function sendSuccess(res, data, meta = {}) {
    res.json({
        success: true,
        ...data,
        ...meta,
        attribution: 'Data sourced from publicly available information via IndiaBondInfo (NSDL)',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOND ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /stats ────────────────────────────────────────────────────────────────

bondRoutes.get('/stats', asyncHandler(async (req, res) => {
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
                { $limit: TOP_ISSUERS_LIMIT },
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
    requireFallback();

    const ratingAgg = {};
    fallbackDb.bonds.forEach(b => {
        const grade = normalizeRating(b.creditRating) || 'Unrated';
        ratingAgg[grade] = (ratingAgg[grade] || 0) + 1;
    });

    const ratingDistribution = Object.entries(ratingAgg)
        .map(([rating, count]) => ({ rating, count }))
        .sort((a, b) => b.count - a.count);

    // Compute topIssuers from in-memory bonds so the shape matches the Mongo response
    const issuerCounts = {};
    const issuerNames = {};
    fallbackDb.bonds.forEach(b => {
        const id = b.issuer?.id;
        if (id) {
            issuerCounts[id] = (issuerCounts[id] || 0) + 1;
            issuerNames[id] = issuerNames[id] || b.issuer?.name;
        }
    });
    const topIssuers = Object.entries(issuerCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_ISSUERS_LIMIT)
        .map(([id, count]) => ({ id, name: issuerNames[id], count }));

    sendSuccess(res, {
        stats: {
            total: fallbackDb.bonds.length,
            active: fallbackDb.stats?.totalActive || fallbackDb.bonds.length,
            matured: 0,
            restructured: fallbackDb.bonds.filter(b => b.isRestructured).length,
            uniqueIssuers: fallbackDb.stats?.uniqueIssuers || Object.keys(issuerCounts).length,
            ratingDistribution,
            topIssuers,
        },
    });
}));

// ─── GET /maturing-soon ───────────────────────────────────────────────────────

bondRoutes.get('/maturing-soon', validate(schemas.maturingSoonSchema), asyncHandler(async (req, res) => {
    const { months, ratingNorm } = req.query;
    const { pageNum, pageSize } = parsePagination(req.query);

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() + months);

    if (isMongoAvailable()) {
        const filter = { maturityDate: { $gte: now, $lte: cutoff } };
        if (ratingNorm) filter.normalizedRating = ratingNorm;

        const [bonds, total] = await Promise.all([
            collection.find(filter).sort({ maturityDate: 1 }).skip((pageNum - 1) * pageSize).limit(pageSize).toArray(),
            collection.countDocuments(filter),
        ]);

        return sendSuccess(res, {
            window: { from: now.toISOString().slice(0, 10), to: cutoff.toISOString().slice(0, 10), months },
            bonds,
            pagination: toPaginationMeta(total, pageNum, pageSize),
        });
    }

    // Fallback: in-memory
    requireFallback();

    let maturing = fallbackDb.bonds.filter(b => {
        if (!b.maturityDate) return false;
        const m = new Date(b.maturityDate);
        return m >= now && m <= cutoff;
    });
    if (ratingNorm) maturing = maturing.filter(b => normalizeRating(b.creditRating) === ratingNorm);
    maturing.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));

    const paginated = paginateArray(maturing, pageNum, pageSize);
    sendSuccess(res, {
        window: { from: now.toISOString().slice(0, 10), to: cutoff.toISOString().slice(0, 10), months },
        bonds: paginated.data,
        pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit),
    });
}));

// ─── GET /search ──────────────────────────────────────────────────────────────

bondRoutes.get('/search', validate(schemas.searchSchema), asyncHandler(async (req, res) => {
    const { q, status } = req.query;
    const { pageNum, pageSize } = parsePagination({ page: req.query.page, limit: Math.min(req.query.limit || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT) });

    const safeQ = q.trim();

    if (isMongoAvailable()) {
        const escaped = escapeRegex(safeQ.toUpperCase());

        const filter = {
            $or: [
                { isin: { $regex: escaped, $options: 'i' } },
                { 'issuer.name': { $regex: escapeRegex(safeQ), $options: 'i' } },
            ],
        };
        if (status && status !== 'all') filter.activeStatus = status;

        const [results, total] = await Promise.all([
            collection.find(filter).skip((pageNum - 1) * pageSize).limit(pageSize).toArray(),
            collection.countDocuments(filter),
        ]);

        return sendSuccess(res, {
            query: safeQ,
            results,
            pagination: toPaginationMeta(total, pageNum, pageSize),
        });
    }

    // Fallback
    requireFallback();

    let results = fallbackDb.bonds.filter(b =>
        (b.isin && b.isin.includes(safeQ.toUpperCase())) ||
        (b.issuer?.name && b.issuer.name.toLowerCase().includes(safeQ.toLowerCase())),
    );
    if (status && status !== 'all') results = results.filter(b => b.activeStatus?.toLowerCase() === status.toLowerCase());

    const paginated = paginateArray(results, pageNum, pageSize);
    sendSuccess(res, {
        query: safeQ,
        results: paginated.data,
        pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit),
    });
}));

// ─── GET /:isin ───────────────────────────────────────────────────────────────

bondRoutes.get('/:isin', validate(schemas.isinParamSchema, 'params'), asyncHandler(async (req, res) => {
    const isin = req.params.isin; // already validated & uppercased by Zod

    if (isMongoAvailable()) {
        const bond = await collection.findOne({ isin });
        if (!bond) throw new AppError(`Bond ${isin} not found`, 404, 'BOND_NOT_FOUND');

        const [relatedBonds, sameRatingBonds] = await Promise.all([
            collection.find({ 'issuer.id': bond.issuer?.id, isin: { $ne: isin } }).limit(RELATED_BONDS_LIMIT).toArray(),
            bond.normalizedRating && bond.normalizedRating !== 'Unrated'
                ? collection.find({ normalizedRating: bond.normalizedRating, 'issuer.id': { $ne: bond.issuer?.id } }).limit(SAME_RATING_LIMIT).toArray()
                : Promise.resolve([]),
        ]);

        return sendSuccess(res, { bond, relatedBonds, sameRatingBonds, changeHistory: [] });
    }

    // Fallback
    requireFallback();

    const bond = fallbackDb.bonds.find(b => b.isin === isin);
    if (!bond) throw new AppError(`Bond ${isin} not found`, 404, 'BOND_NOT_FOUND');

    const relatedBonds = fallbackDb.bonds.filter(b => b.issuer?.id === bond.issuer?.id && b.isin !== isin).slice(0, RELATED_BONDS_LIMIT);
    const sameRatingBonds = bond.creditRating
        ? fallbackDb.bonds.filter(b => b.creditRating === bond.creditRating && b.issuer?.id !== bond.issuer?.id).slice(0, SAME_RATING_LIMIT)
        : [];

    sendSuccess(res, { bond, relatedBonds, sameRatingBonds, changeHistory: [] });
}));

// ─── GET / ────────────────────────────────────────────────────────────────────

bondRoutes.get('/', validate(schemas.bondsListSchema), asyncHandler(async (req, res) => {
    const { sort, activeStatus, bondType, issuer, rating, ratingNorm, maturityYear, isRestructured, minRate, maxRate } = req.query;
    const { pageNum, pageSize } = parsePagination(req.query);
    const { mongoSort, memorySort } = getBondSort(sort);

    if (isMongoAvailable()) {
        const filter = {};
        // Escape all user-supplied strings used in $regex to prevent regex injection
        if (activeStatus && activeStatus !== 'all') filter.activeStatus = { $regex: `^${escapeRegex(activeStatus)}$`, $options: 'i' };
        if (bondType) filter.bondsType = { $regex: `^${escapeRegex(bondType)}$`, $options: 'i' };
        if (issuer) filter['issuer.id'] = { $regex: escapeRegex(issuer.toLowerCase().replace(/\s+/g, '-')), $options: 'i' };
        if (rating) filter.creditRating = { $regex: `^${escapeRegex(rating)}$`, $options: 'i' };
        if (ratingNorm) filter.normalizedRating = ratingNorm;
        if (maturityYear) {
            filter.maturityDate = {
                $gte: new Date(`${maturityYear}-01-01`),
                $lt: new Date(`${maturityYear + 1}-01-01`),
            };
        }
        if (isRestructured === 'true') filter.isRestructured = true;
        if (isRestructured === 'false') filter.isRestructured = false;
        if (minRate !== undefined || maxRate !== undefined) {
            filter.couponRate = {};
            if (minRate !== undefined) filter.couponRate.$gte = minRate;
            if (maxRate !== undefined) filter.couponRate.$lte = maxRate;
        }

        const [bonds, total] = await Promise.all([
            collection.find(filter).sort(mongoSort).skip((pageNum - 1) * pageSize).limit(pageSize).toArray(),
            collection.countDocuments(filter),
        ]);

        return sendSuccess(res, { bonds, pagination: toPaginationMeta(total, pageNum, pageSize) });
    }

    // Fallback: in-memory
    requireFallback();

    let filtered = [...fallbackDb.bonds];
    if (activeStatus && activeStatus !== 'all') filtered = filtered.filter(b => b.activeStatus?.toLowerCase() === activeStatus.toLowerCase());
    if (bondType) filtered = filtered.filter(b => b.bondsType?.toLowerCase() === bondType.toLowerCase());
    if (issuer) filtered = filtered.filter(b => b.issuer?.id?.includes(issuer.toLowerCase().replace(/\s+/g, '-')));
    if (rating) filtered = filtered.filter(b => b.creditRating?.toUpperCase() === rating.toUpperCase());
    if (ratingNorm) filtered = filtered.filter(b => normalizeRating(b.creditRating) === ratingNorm);
    if (maturityYear) filtered = filtered.filter(b => b.maturityDate && new Date(b.maturityDate).getFullYear() === maturityYear);
    if (isRestructured === 'true') filtered = filtered.filter(b => b.isRestructured === true);
    if (isRestructured === 'false') filtered = filtered.filter(b => !b.isRestructured);
    if (minRate !== undefined) filtered = filtered.filter(b => b.couponRate >= minRate);
    if (maxRate !== undefined) filtered = filtered.filter(b => b.couponRate <= maxRate);

    filtered.sort(memorySort);

    const paginated = paginateArray(filtered, pageNum, pageSize);
    sendSuccess(res, { bonds: paginated.data, pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit) });
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  ISSUER ROUTES (derived from bonds via aggregation)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /issuers/search ──────────────────────────────────────────────────────

issuerRoutes.get('/search', validate(schemas.issuerSearchSchema), asyncHandler(async (req, res) => {
    const { q } = req.query;
    const { pageNum, pageSize } = parsePagination({ page: req.query.page, limit: req.query.limit });
    const safeQ = q.trim();
    const escaped = escapeRegex(safeQ);

    if (isMongoAvailable()) {
        const pipeline = [
            { $match: { 'issuer.name': { $regex: escaped, $options: 'i' } } },
            {
                $group: {
                    _id: '$issuer.id',
                    name: { $first: '$issuer.name' },
                    sector: { $first: '$issuer.sector' },
                    issuerType: { $first: '$issuer.issuerType' },
                    ownershipType: { $first: '$issuer.ownershipType' },
                    totalActiveBonds: { $sum: 1 },
                },
            },
            { $sort: { totalActiveBonds: -1 } },
        ];

        const countPipeline = [...pipeline, { $count: 'total' }];
        const dataPipeline = [
            ...pipeline,
            { $skip: (pageNum - 1) * pageSize },
            { $limit: pageSize },
            { $project: { _id: 0, id: '$_id', name: 1, sector: 1, issuerType: 1, ownershipType: 1, totalActiveBonds: 1 } },
        ];

        const [countResult, results] = await Promise.all([
            collection.aggregate(countPipeline).toArray(),
            collection.aggregate(dataPipeline).toArray(),
        ]);

        const total = countResult[0]?.total || 0;
        return sendSuccess(res, { query: safeQ, results, pagination: toPaginationMeta(total, pageNum, pageSize) });
    }

    // Fallback
    requireFallback();

    const matched = fallbackDb.issuers.filter(i => i.name.toLowerCase().includes(safeQ.toLowerCase()));
    const paginated = paginateArray(matched, pageNum, pageSize);
    sendSuccess(res, { query: safeQ, results: paginated.data, pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit) });
}));

// ─── GET /issuers/:id/bonds ───────────────────────────────────────────────────

issuerRoutes.get('/:id/bonds', validate(schemas.issuerIdParamSchema, 'params'), validate(schemas.issuerBondsSchema), asyncHandler(async (req, res) => {
    const issuerId = req.params.id; // already lowercased by Zod
    const { activeStatus, creditRating, minRate, maxRate, sort } = req.query;
    const { pageNum, pageSize } = parsePagination(req.query);

    if (isMongoAvailable()) {
        const filter = { 'issuer.id': issuerId };
        if (activeStatus) filter.activeStatus = { $regex: `^${escapeRegex(activeStatus)}$`, $options: 'i' };
        if (creditRating) filter.creditRating = { $regex: `^${escapeRegex(creditRating)}$`, $options: 'i' };
        if (minRate !== undefined || maxRate !== undefined) {
            filter.couponRate = {};
            if (minRate !== undefined) filter.couponRate.$gte = minRate;
            if (maxRate !== undefined) filter.couponRate.$lte = maxRate;
        }

        const mongoSort = sort === 'couponRate' ? { couponRate: -1 } : sort === 'rating' ? { ratingRank: 1 } : { maturityDate: 1 };

        const [bonds, total] = await Promise.all([
            collection.find(filter).sort(mongoSort).skip((pageNum - 1) * pageSize).limit(pageSize).toArray(),
            collection.countDocuments(filter),
        ]);

        return sendSuccess(res, { issuerId, bonds, pagination: toPaginationMeta(total, pageNum, pageSize) });
    }

    // Fallback
    requireFallback();

    let filtered = fallbackDb.bonds.filter(b => b.issuer?.id === issuerId);
    if (activeStatus) filtered = filtered.filter(b => b.activeStatus?.toLowerCase() === activeStatus.toLowerCase());
    if (creditRating) filtered = filtered.filter(b => b.creditRating?.toUpperCase() === creditRating.toUpperCase());
    if (minRate !== undefined) filtered = filtered.filter(b => b.couponRate >= minRate);
    if (maxRate !== undefined) filtered = filtered.filter(b => b.couponRate <= maxRate);

    if (sort === 'couponRate') filtered.sort((a, b) => (b.couponRate || 0) - (a.couponRate || 0));
    else if (sort === 'rating') filtered.sort((a, b) => getRatingRank(normalizeRating(a.creditRating)) - getRatingRank(normalizeRating(b.creditRating)));
    else filtered.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));

    const paginated = paginateArray(filtered, pageNum, pageSize);
    sendSuccess(res, { issuerId, bonds: paginated.data, pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit) });
}));

// ─── GET /issuers/:id ─────────────────────────────────────────────────────────

issuerRoutes.get('/:id', validate(schemas.issuerIdParamSchema, 'params'), asyncHandler(async (req, res) => {
    const issuerId = req.params.id; // already lowercased by Zod

    if (isMongoAvailable()) {
        const [issuerAgg, ratingDist, maturityDist, couponStats] = await Promise.all([
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
                    },
                },
            ]).toArray(),
            collection.aggregate([
                { $match: { 'issuer.id': issuerId, normalizedRating: { $ne: null } } },
                { $group: { _id: '$normalizedRating', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]).toArray(),
            collection.aggregate([
                { $match: { 'issuer.id': issuerId, maturityDate: { $ne: null } } },
                { $group: { _id: { $year: '$maturityDate' }, count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
                { $limit: 20 },
            ]).toArray(),
            collection.aggregate([
                { $match: { 'issuer.id': issuerId, couponRate: { $gt: 0 } } },
                { $group: { _id: null, min: { $min: '$couponRate' }, max: { $max: '$couponRate' }, avg: { $avg: '$couponRate' } } },
            ]).toArray(),
        ]);

        if (!issuerAgg.length) throw new AppError(`Issuer '${issuerId}' not found`, 404, 'ISSUER_NOT_FOUND');

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

    // Fallback — clone before mutating to avoid corrupting shared in-memory cache
    requireFallback();

    const rawIssuer = fallbackDb.issuers.find(i => i.id === issuerId);
    if (!rawIssuer) throw new AppError(`Issuer '${issuerId}' not found`, 404, 'ISSUER_NOT_FOUND');

    const issuer = { ...rawIssuer };
    issuer.maturityDistribution = [];
    issuer.couponRateRange = { min: issuer.avgCouponRate, max: issuer.avgCouponRate, avg: issuer.avgCouponRate };
    issuer.totalMaturedBonds = 0;

    sendSuccess(res, { issuer });
}));

// ─── GET /issuers ─────────────────────────────────────────────────────────────

issuerRoutes.get('/', validate(schemas.issuerListSchema), asyncHandler(async (req, res) => {
    const { issuerType, ownershipType, sector, sort, q } = req.query;
    const { pageNum, pageSize } = parsePagination(req.query);

    if (isMongoAvailable()) {
        const matchStage = {};
        if (issuerType) matchStage['issuer.issuerType'] = { $regex: escapeRegex(issuerType), $options: 'i' };
        if (ownershipType) matchStage['issuer.ownershipType'] = ownershipType.toLowerCase();
        if (sector) matchStage['issuer.sector'] = { $regex: escapeRegex(sector), $options: 'i' };
        if (q) matchStage['issuer.name'] = { $regex: escapeRegex(q), $options: 'i' };

        const sortField = sort === 'name' ? 'name' : 'totalActiveBonds';
        const sortDir = sort === 'name' ? 1 : -1;

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
                },
            },
            {
                $facet: {
                    metadata: [{ $count: 'total' }],
                    data: [
                        { $sort: { [sortField]: sortDir } },
                        { $skip: (pageNum - 1) * pageSize },
                        { $limit: pageSize },
                        { $project: { _id: 0, id: '$_id', name: 1, sector: 1, issuerType: 1, ownershipType: 1, totalActiveBonds: 1, avgCouponRate: { $round: ['$avgCouponRate', 2] } } },
                    ],
                },
            },
        ]).toArray();

        const total = result[0]?.metadata[0]?.total || 0;
        const issuers = result[0]?.data || [];

        return sendSuccess(res, { issuers, pagination: toPaginationMeta(total, pageNum, pageSize) });
    }

    // Fallback
    requireFallback();

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

    const paginated = paginateArray(filtered, pageNum, pageSize);
    sendSuccess(res, { issuers: paginated.data, pagination: toPaginationMeta(paginated.total, paginated.page, paginated.limit) });
}));

module.exports = {
    bondRoutes,
    issuerRoutes,
    setBondCollection,
    setFallbackData,
};
