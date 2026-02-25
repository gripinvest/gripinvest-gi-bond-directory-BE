/**
 * Zod Validation Middleware + Schemas
 *
 * Validates query parameters for Bond Directory API routes.
 * Returns 400 with detailed error messages on validation failure.
 */

'use strict';

const { z } = require('zod');

// ─── Schemas ──────────────────────────────────────────────────────────────────

const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

const bondsListSchema = paginationSchema.extend({
    sort: z.enum([
        'rating', 'rating:desc', 'rating:asc',
        'couponRate', 'couponRate:desc', 'couponRate:asc',
        'maturityDate', 'maturityDate:asc', 'maturityDate:desc',
    ]).default('rating:desc'),
    activeStatus: z.string().max(20).optional(),
    bondType: z.string().max(50).optional(),
    issuer: z.string().max(100).optional(),
    rating: z.string().max(50).optional(),
    ratingNorm: z.string().max(20).optional(),
    maturityYear: z.coerce.number().int().min(2000).max(2100).optional(),
    isRestructured: z.enum(['true', 'false']).optional(),
    minRate: z.coerce.number().min(0).max(100).optional(),
    maxRate: z.coerce.number().min(0).max(100).optional(),
});

const searchSchema = z.object({
    q: z.string().min(2).max(100),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    status: z.string().max(20).optional(),
});

const maturingSoonSchema = paginationSchema.extend({
    months: z.coerce.number().int().min(1).max(120).default(6),
    ratingNorm: z.string().max(20).optional(),
});

const isinParamSchema = z.object({
    isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, 'Invalid ISIN format').transform(v => v.toUpperCase()),
});

const issuerIdParamSchema = z.object({
    id: z.string().min(1).max(200).transform(v => v.toLowerCase()),
});

const issuerListSchema = paginationSchema.extend({
    issuerType: z.string().max(50).optional(),
    ownershipType: z.string().max(30).optional(),
    sector: z.string().max(100).optional(),
    sort: z.enum(['name', 'totalActiveBonds']).default('totalActiveBonds'),
    q: z.string().max(100).optional(),
});

const issuerBondsSchema = paginationSchema.extend({
    activeStatus: z.string().max(20).optional(),
    creditRating: z.string().max(50).optional(),
    minRate: z.coerce.number().min(0).max(100).optional(),
    maxRate: z.coerce.number().min(0).max(100).optional(),
    sort: z.enum(['couponRate', 'rating', 'maturityDate']).default('maturityDate'),
});

// ─── Middleware Factory ───────────────────────────────────────────────────────

/**
 * Creates Express middleware that validates req.query against a Zod schema.
 * On success, replaces req.query with the parsed (coerced) values.
 * On failure, returns 400 with detailed error messages.
 *
 * @param {z.ZodSchema} schema
 * @param {'query'|'params'} source — which part of the request to validate
 */
function validate(schema, source = 'query') {
    return (req, res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            const errors = result.error.issues.map(i => ({
                field: i.path.join('.'),
                message: i.message,
            }));
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request parameters',
                    details: errors,
                },
                requestId: req.id || null,
            });
        }
        // Express 5+ makes req.query a getter — merge validated values back
        if (source === 'query') {
            // Clear existing keys and merge validated data
            for (const key of Object.keys(req.query)) {
                delete req.query[key];
            }
            Object.assign(req.query, result.data);
        } else {
            req[source] = result.data;
        }
        next();
    };
}

module.exports = {
    validate,
    schemas: {
        bondsListSchema,
        searchSchema,
        maturingSoonSchema,
        isinParamSchema,
        issuerIdParamSchema,
        issuerListSchema,
        issuerBondsSchema,
        paginationSchema,
    },
};
