/**
 * Rating Normalizer — Single Source of Truth
 *
 * Normalizes raw credit rating strings (e.g. "CRISILAAA/STABLE", "INDAA+CE")
 * into canonical grades (e.g. "AAA", "AA+").
 *
 * Used by:
 *   - Seed script (pre-compute normalizedRating on each bond document)
 *   - API routes (filter/sort by normalizedRating)
 *   - Stats aggregation
 */

'use strict';

// Sorted longest-first so greedy match picks 'AA+' before 'AA' before 'A'
const KNOWN_GRADES = [
    'AAA', 'AA+', 'AA-', 'AA',
    'A+', 'A-', 'A',
    'BBB+', 'BBB-', 'BBB',
    'BB+', 'BB-', 'BB',
    'B+', 'B-', 'B',
    'C+', 'C-', 'C',
    'D',
];

const NOISE_RESULTS = new Set([
    'WITHDRAWN', 'ISSUERNOTCOOPERATING', 'CISSUERNOTCOOPERATING',
    'PROVISIONALCAREWITHDRAWN', 'INDWITHDRAWN',
]);

const AGENCY_PREFIXES_RE = /^(PROVISIONAL)?(CRISIL|ICRA|CARE|IVR|BWR|ACUITE|SMERA|BRICKWORK|INDIARATINGS?|INFOMERICS|CRISILBBL|INDIA\s+RATINGS)/i;
const IND_PREFIX_RE = /^(IND|PP-MLD)/i;
const SUFFIXES_RE = /(CE|SO|RSO|STABLE|POSITIVE|NEGATIVE|WATCH|OUTLOOK|SUSPENSION|REAFFIRMED)$/i;

// Lower = better quality
const GRADE_RANK = {
    'AAA': 1, 'AA+': 2, 'AA': 3, 'AA-': 4,
    'A+': 5, 'A': 6, 'A-': 7,
    'BBB+': 8, 'BBB': 9, 'BBB-': 10,
    'BB+': 11, 'BB': 12, 'BB-': 13,
    'B+': 14, 'B': 15, 'B-': 16,
    'C+': 17, 'C': 18, 'C-': 19,
    'D': 20,
    'PP-MLD': 80,
    'WITHDRAWN': 90,
    'Unrated': 99,
};

/**
 * Normalize a raw credit rating string to a canonical grade.
 * @param {string} raw — e.g. "CRISILAAA/STABLE", "INDAA+CE", "BWR BBB+"
 * @returns {string|null} — e.g. "AAA", "AA+", "BBB+", or null if empty
 */
function normalizeRating(raw) {
    if (!raw || !raw.trim()) return null;

    // Take first segment (before semicolons) and first part (before /)
    let s = raw.split(';')[0].trim().toUpperCase();
    const slash = s.indexOf('/');
    if (slash !== -1) s = s.slice(0, slash);
    s = s.replace(/\*+$/, '').replace(/\s+/g, '').replace(/[()]/g, '').trim();

    // Known noise
    if (NOISE_RESULTS.has(s)) return 'WITHDRAWN';

    // Strip PROVISIONAL + agency prefix
    s = s.replace(AGENCY_PREFIXES_RE, '').trim();
    if (s.startsWith('PROVISIONAL')) s = s.slice(11).trim();

    // PP-MLD bonds
    if (s.includes('PP-MLD')) return 'PP-MLD';

    // Strip IND prefix
    s = s.replace(IND_PREFIX_RE, '').trim();

    // Strip trailing suffixes (may need multiple passes)
    for (let i = 0; i < 3; i++) {
        const before = s;
        s = s.replace(SUFFIXES_RE, '').trim();
        if (s === before) break;
    }

    // Exact match
    for (const g of KNOWN_GRADES) {
        if (s === g) return g;
    }
    // Prefix match (e.g. 'AAAC' → 'AAA')
    for (const g of KNOWN_GRADES) {
        if (s.startsWith(g)) return g;
    }

    return s || null;
}

/**
 * Get numeric rank for a rating grade (lower = better).
 * @param {string|null} grade
 * @returns {number}
 */
function getRatingRank(grade) {
    return GRADE_RANK[grade] ?? 99;
}

module.exports = {
    normalizeRating,
    getRatingRank,
    KNOWN_GRADES,
    GRADE_RANK,
};
