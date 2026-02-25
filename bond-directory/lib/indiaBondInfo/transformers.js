/**
 * NSDL Data Transformers
 *
 * Transforms raw API responses from each of the 7 NSDL endpoints
 * into the normalized Bond schema format.
 *
 * NOTE: The exact field names in NSDL responses are discovered from live
 * API calls. Field mappings here cover the most common patterns; the
 * `apiResponseRaw` field preserves the full original record.
 */

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function generateSlug(name) {
    if (!name) return 'unknown';
    return name
        .toLowerCase()
        .replace(/\blimited\b/gi, 'ltd')
        .replace(/\bprivate\b/gi, 'pvt')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80); // cap slug length
}

/**
 * Parse dates in multiple formats:
 * - DD-MM-YYYY, DD/MM/YYYY (NSDL common)
 * - YYYY-MM-DD (ISO)
 * - Timestamps
 */
function parseDate(dateString) {
    if (!dateString) return null;
    if (dateString instanceof Date) return dateString;

    const str = String(dateString).trim();
    if (!str) return null;

    // DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
        const [, d, m, y] = dmyMatch;
        return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00.000Z`);
    }

    // YYYY-MM-DD
    const iso = new Date(str);
    return isNaN(iso.getTime()) ? null : iso;
}

function detectOwnershipType(issuerName = '') {
    const n = issuerName.toLowerCase();
    if (n.includes('government') || n.includes('govt') || n.includes(' goi') || n.includes('india bonds')) return 'government';
    if (n.includes(' psu') || n.includes('public sector') || n.includes('bhel') || n.includes('ongc') || n.includes('ntpc') || n.includes('gail') || n.includes('iocl') || n.includes('hpcl') || n.includes('bpcl')) return 'psu';
    return 'private';
}

function detectBondType(issuerName = '', apiData = {}) {
    const n = issuerName.toLowerCase();
    if (apiData.taxFree === true || apiData.taxFreeStatus === 'Yes') return 'tax-free';
    if (n.includes('government') || n.includes('gsec') || n.includes('g-sec')) return 'gsec';
    if (n.includes('sdl') || n.includes('state development loan')) return 'sdl';
    if (detectOwnershipType(issuerName) === 'psu') return 'psu';
    return 'corporate';
}

function mapCouponType(raw = '') {
    const t = String(raw).toLowerCase();
    if (t.includes('float') || t.includes('variable')) return 'floating';
    if (t.includes('zero')) return 'zero';
    if (!t || t === 'unknown' || t === 'null') return 'fixed';
    return 'fixed';
}

function mapCouponFrequency(raw = '') {
    const f = String(raw).toLowerCase();
    if (f.includes('semi') || f.includes('half')) return 'semi-annual';
    if (f.includes('quarter')) return 'quarterly';
    if (f.includes('month')) return 'monthly';
    if (f.includes('annual') || f.includes('yearly')) return 'annual';
    return null;
}

function normalizeRating(raw = '') {
    // Standardize rating strings: strip extra spaces, parentheses, etc.
    return String(raw || '').replace(/\s+/g, '').replace(/[()]/g, '').toUpperCase().trim() || null;
}

function determineActiveStatus(maturityDate) {
    if (!maturityDate) return 'Active';
    return new Date(maturityDate) > new Date() ? 'Active' : 'Matured';
}

/**
 * Extract multiple possible field names from raw data.
 * NSDL API is inconsistent with camelCase vs snake_case vs PascalCase.
 */
function pick(raw, ...keys) {
    for (const key of keys) {
        const val = raw[key];
        if (val !== undefined && val !== null && val !== '') return val;
    }
    return null;
}

// ─── Primary Transformer: List of Securities (Active + Matured) ───────────────

/**
 * Transform a record from /listofsecurities?type=Active|Matured
 * These are the PRIMARY source records — most complete.
 *
 * Common field shapes from NSDL:
 * { isin, issuerName/companyName, allotmentDate/issueDate, maturityDate,
 *   issueSize, faceValue, couponRate/interestRate, interestType/couponType,
 *   interestFrequency, creditRating, ratingAgency, exchange/listingExchange }
 */
function transformListedSecurity(raw, activeStatus = 'Active') {
    const issuerName = pick(raw, 'Name of Issuer', 'issuerName', 'companyName', 'issuer_name', 'company_name') || '';
    const issuerId = generateSlug(issuerName);

    const couponRate = parseFloat(pick(raw, 'Coupon Rate (%)', 'couponRate', 'interestRate', 'coupon_rate', 'interest_rate') || 0);
    const matDate = parseDate(pick(raw, 'Date of Redemption/Conversion', 'maturityDate', 'redemptionDate', 'maturity_date'));
    const issDate = parseDate(pick(raw, 'Date of Allotment', 'allotmentDate', 'issueDate', 'allotment_date', 'issue_date'));
    const rawRating = pick(raw, 'Credit Rating', 'creditRating', 'rating', 'credit_rating');

    return {
        isin: (pick(raw, 'ISIN', 'isin') || '').toUpperCase(),
        issuer: {
            id: issuerId,
            name: issuerName,
            sector: pick(raw, 'Business Sector', 'sector', 'industrySector') || null,
            ownershipType: detectOwnershipType(issuerName),
            issuerType: pick(raw, 'Type of Issuer-Ownership', 'Type of Issuer-Nature', 'issuerType', 'issuer_type', 'ownerType') || null,
            latestRating: normalizeRating(rawRating),
            description: null
        },
        couponRate: isNaN(couponRate) ? 0 : couponRate,
        couponType: mapCouponType(pick(raw, 'Coupon Type', 'couponType', 'interestType', 'coupon_type', 'interest_type')),
        couponFrequency: mapCouponFrequency(pick(raw, 'Frequency of Interest Payment', 'couponFrequency', 'interestFrequency', 'payment_frequency')),
        maturityDate: matDate,
        issueDate: issDate,
        faceValue: parseFloat(pick(raw, 'Face Value(in Rs.)', 'faceValue', 'face_value') || 0) || null,
        minInvestment: parseFloat(pick(raw, 'minInvestment', 'minimum_investment') || 0) || null,
        issueSize: parseFloat(pick(raw, 'Issue Size(in Rs.)', 'issueSize', 'issue_size', 'issuedAmount') || 0),
        creditRating: normalizeRating(rawRating),
        ratingAgency: pick(raw, 'ratingAgency', 'rating_agency', 'ratingAgencyName') || null,
        activeStatus,
        isRestructured: false, // Will be overridden by /restructuredisins data
        bondsType: detectBondType(issuerName, raw),
        issuerType: pick(raw, 'Type of Issuer-Ownership', 'Type of Issuer-Nature', 'issuerType', 'issuer_type', 'ownerType') || null,
        listingExchange: pick(raw, 'listingExchange', 'exchange', 'stockExchange') || null,
        taxFree: raw.taxFree === true || raw.taxFreeStatus === 'Yes' || false,
        secured: raw.secured === true || raw.securedStatus === 'Yes' || null,
        couponSchedule: [],
        ratingHistory: rawRating ? [{
            agency: pick(raw, 'ratingAgency', 'rating_agency') || 'Unknown',
            value: normalizeRating(rawRating),
            date: new Date(),
            outlook: 'stable'
        }] : [],
        dataSource: `IndiaBondInfo-${activeStatus}`,
        apiResponseRaw: raw,
        lastSyncedAt: new Date()
    };
}

// ─── Credit Rating-Wise Enrichment ────────────────────────────────────────────

/**
 * Extract enrichment data from /creditratingwise response
 * Returns a Map of isin → { creditRating, ratingAgency }
 */
function extractCreditRatingMap(rawArray) {
    const map = new Map();
    for (const record of rawArray) {
        const isin = (pick(record, 'isin', 'ISIN') || '').toUpperCase();
        if (!isin) continue;
        const rating = normalizeRating(pick(record, 'creditRating', 'rating', 'credit_rating'));
        const agency = pick(record, 'ratingAgency', 'rating_agency', 'agencyName') || null;
        if (isin && rating) {
            map.set(isin, { creditRating: rating, ratingAgency: agency });
        }
    }
    return map;
}

// ─── Interest Rate-Wise Enrichment ────────────────────────────────────────────

/**
 * Extract enrichment data from /interestratewise response
 * Returns a Map of isin → { interestRateCategory, couponRate }
 */
function extractInterestRateMap(rawArray) {
    const map = new Map();
    for (const record of rawArray) {
        const isin = (pick(record, 'isin', 'ISIN') || '').toUpperCase();
        if (!isin) continue;
        const bucket = pick(record, 'interestRateRange', 'rateRange', 'bucket', 'rate_range', 'category') || null;
        const rate = parseFloat(pick(record, 'interestRate', 'couponRate', 'rate') || 0);
        map.set(isin, {
            interestRateCategory: bucket,
            couponRate: isNaN(rate) ? undefined : rate
        });
    }
    return map;
}

// ─── Issuer Type-Wise Enrichment ─────────────────────────────────────────────

/**
 * Extract issuer-type classification from /issuertypewise
 * Returns a Map of issuer name/slug → { issuerType }
 */
function extractIssuerTypeMap(rawArray) {
    const map = new Map();
    for (const record of rawArray) {
        const name = pick(record, 'issuerName', 'companyName', 'name', 'issuer_name') || '';
        const type = pick(record, 'issuerType', 'issuer_type', 'ownerType', 'category') || null;
        const isin = (pick(record, 'isin', 'ISIN') || '').toUpperCase();

        if (isin && type) {
            map.set(isin, { issuerType: type });
        }
        if (name && type) {
            map.set(generateSlug(name), { issuerType: type });
        }
    }
    return map;
}

// ─── Restructured ISINs ────────────────────────────────────────────────────────

/**
 * Extract restructured ISIN set from /restructuredisins
 * Returns a Set of ISIN strings
 */
function extractRestructuredSet(rawArray) {
    const set = new Set();
    for (const record of rawArray) {
        const isin = (pick(record, 'isin', 'ISIN') || '').toUpperCase();
        if (isin) set.add(isin);
    }
    return set;
}

// ─── Issuer-Wise Data ─────────────────────────────────────────────────────────

/**
 * Extract issuer enrichment data from /issuerwise
 * Returns a Map of issuer slug → { sector, issuerType, totalBonds }
 */
function extractIssuerWiseMap(rawArray) {
    const map = new Map();
    for (const record of rawArray) {
        const name = pick(record, 'issuerName', 'companyName', 'name', 'issuer_name') || '';
        const slug = generateSlug(name);
        if (!slug || slug === 'unknown') continue;

        map.set(slug, {
            name,
            sector: pick(record, 'sector', 'industrySector', 'industry') || null,
            issuerType: pick(record, 'issuerType', 'issuer_type', 'ownerType', 'category') || null,
            totalBonds: parseInt(pick(record, 'totalBonds', 'total_bonds', 'bondCount') || 0)
        });
    }
    return map;
}

module.exports = {
    // Primary transformer
    transformListedSecurity,

    // Enrichment extractors — return Maps/Sets to be applied to bonds
    extractCreditRatingMap,
    extractInterestRateMap,
    extractIssuerTypeMap,
    extractRestructuredSet,
    extractIssuerWiseMap,

    // Exposed helpers for testing
    generateSlug,
    parseDate,
    normalizeRating
};
