'use strict';

// =============================================================================
// Bond Directory Backend — Centralized Constants
// =============================================================================
// ⚠️  This is the SINGLE SOURCE OF TRUTH for all backend shared constants.
//    Never hardcode these values in route handlers, clients, or scripts.

// ─── NSDL / IndiaBondInfo API ─────────────────────────────────────────────────
const NSDL_ORIGIN = 'https://www.indiabondinfo.nsdl.com';

/** Full base URL for the authenticated bdsinfo endpoints (client.js, nsdlClient.js) */
const NSDL_BASE_URL = `${NSDL_ORIGIN}/bds-service/v1/public/bdsinfo`;

/** Base URL for the unauthenticated public endpoints (publicClient.js) */
const NSDL_PUBLIC_URL = `${NSDL_ORIGIN}/bds-service/v1/public`;

/** Referer header required by NSDL to avoid 403 rejection */
const NSDL_REFERER = `${NSDL_ORIGIN}/CBDServices/`;

// ─── API Pagination ───────────────────────────────────────────────────────────
/** Hard cap on results per page — prevent unbounded queries */
const MAX_PAGE_LIMIT = 200;

/** Default results per page when the caller does not specify */
const DEFAULT_PAGE_LIMIT = 50;

/** Default search result limit (autocomplete, compact lists) */
const DEFAULT_SEARCH_LIMIT = 10;

/** Maximum search result count */
const MAX_SEARCH_LIMIT = 50;

// ─── HTTP Client Timeouts (ms) ────────────────────────────────────────────────
/** Timeout for standard NSDL API HTTP requests */
const NSDL_HTTP_TIMEOUT_MS = 45000;

/** Timeout for the public (unauthenticated) NSDL client */
const NSDL_PUBLIC_HTTP_TIMEOUT_MS = 30000;

/** Circuit breaker reset timeout for nsdlClient (authenticated) */
const NSDL_CIRCUIT_BREAKER_RESET_MS = 90000;

/** Circuit breaker reset timeout for the public client / indiaBondInfo client */
const CIRCUIT_BREAKER_RESET_MS = 60000;

// ─── Server Timeouts (ms) ─────────────────────────────────────────────────────
/** How long to wait for in-flight requests to finish during graceful shutdown */
const GRACEFUL_SHUTDOWN_MS = 10000;

/** MongoDB connection + server selection timeout for the seed script */
const MONGO_CONNECT_TIMEOUT_MS = 15000;

// ─── Bond Detail Limits ───────────────────────────────────────────────────────
/** Max related bonds (same issuer) returned on bond detail page */
const RELATED_BONDS_LIMIT = 8;

/** Max same-rating bonds (different issuer) returned on bond detail page */
const SAME_RATING_LIMIT = 5;

/** Max top issuers returned in stats */
const TOP_ISSUERS_LIMIT = 12;

// ─── Rate Limiting ────────────────────────────────────────────────────────────
/** Max API requests per minute (applied to /bond-directory/api/* routes) */
const API_RATE_LIMIT_MAX = 200;

/** Rate limit window in milliseconds (1 minute) */
const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;

module.exports = {
    // NSDL
    NSDL_ORIGIN,
    NSDL_BASE_URL,
    NSDL_PUBLIC_URL,
    NSDL_REFERER,
    // Pagination
    MAX_PAGE_LIMIT,
    DEFAULT_PAGE_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    // Bond detail limits
    RELATED_BONDS_LIMIT,
    SAME_RATING_LIMIT,
    TOP_ISSUERS_LIMIT,
    // HTTP timeouts
    NSDL_HTTP_TIMEOUT_MS,
    NSDL_PUBLIC_HTTP_TIMEOUT_MS,
    NSDL_CIRCUIT_BREAKER_RESET_MS,
    CIRCUIT_BREAKER_RESET_MS,
    // Server
    GRACEFUL_SHUTDOWN_MS,
    MONGO_CONNECT_TIMEOUT_MS,
    // Rate limiting
    API_RATE_LIMIT_MAX,
    API_RATE_LIMIT_WINDOW_MS,
};
