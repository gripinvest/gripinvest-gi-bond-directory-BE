# GripInvest Bond Directory — Backend Architecture

**Version:** 1.0.0  
**Date:** 2026-02-25  
**Owner:** GripInvest Engineering

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Repository Structure](#repository-structure)
3. [Middleware Stack](#middleware-stack)
4. [API Reference](#api-reference)
5. [Database Schema](#database-schema)
6. [Security](#security)
7. [Observability & Logging](#observability--logging)
8. [Performance Architecture](#performance-architecture)
9. [Deployment](#deployment)
10. [Environment Variables](#environment-variables)
11. [Data Migration (Seed)](#data-migration-seed)
12. [Production Checklist](#production-checklist)
13. [Known Limitations & Next Steps](#known-limitations--next-steps)

---

## System Overview

The Bond Directory Backend is a **standalone Express.js microservice** serving bond and issuer data from the NSDL IndiaBondInfo public API. It uses a single MongoDB collection (`bondsdirectory`) for all data, with a built-in in-memory fallback for resilience.

```
┌─────────────────────────────────────────────────────┐
│                  React Frontend                     │
└───────────────────┬─────────────────────────────────┘
                    │ HTTPS REST
                    ▼
┌─────────────────────────────────────────────────────┐
│         Bond Directory Backend :5050                │
│                                                     │
│  ┌─────── Middleware Stack ────────────────────┐    │
│  │ 1. Request ID  (X-Request-ID per request)  │    │
│  │ 2. Helmet      (9 security headers)        │    │
│  │ 3. Compression (gzip)                      │    │
│  │ 4. CORS        (configurable origins)      │    │
│  │ 5. Rate Limit  (200 req/min)               │    │
│  │ 6. JSON Logger (structured, JSON)          │    │
│  │ 7. Routes      (Zod-validated)             │    │
│  │ 8. Error Handler (centralized)             │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─── MongoDB-first ───┐  ┌─── Fallback ─────┐     │
│  │  bondsdirectory     │  │  In-memory JSON   │     │
│  │  MongoDB Atlas      │  │  (26,679 bonds)  │     │
│  └─────────────────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────────┘
                    │
                    ▼ (ETL cron — every 12 days)
┌─────────────────────────────────────────────────────┐
│          NSDL IndiaBondInfo Public API              │
│  /listedsecurities  /newbondissues  /dropdown  …   │
└─────────────────────────────────────────────────────┘
```

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| **Single collection** (`bondsdirectory`) | All queries are by ISIN or issuer; no JOINs needed. Simpler ops. |
| **Embedded issuer data** | Avoids N+1 lookups — issuer info stored per bond document |
| **Pre-computed `normalizedRating`** | Eliminates per-request normalization of 26K bonds |
| **in-memory fallback** | Ensures 100% API uptime even when MongoDB is unavailable |
| **Native MongoDB driver** | More control over aggregation pipelines; no Mongoose overhead |

---

## Repository Structure

```
gi-bond-directory-BE/
├── index.js                              # Server entry point
├── package.json
├── Dockerfile                            # Multi-stage, non-root, HEALTHCHECK
├── .dockerignore
├── .env.example                          # Template — never commit real .env
├── .eslintrc.json
├── .prettierrc
│
├── bond-directory/
│   ├── config/
│   │   ├── bondDirectoryDb.js            # MongoDB connection manager
│   │   └── envValidation.js              # Zod env validation (startup)
│   │
│   ├── middleware/
│   │   ├── errorHandler.js               # AppError + asyncHandler + centralized handler
│   │   ├── requestId.js                  # UUID per request (X-Request-ID)
│   │   ├── requestLogger.js              # Structured JSON logging
│   │   └── validate.js                   # Zod schemas + validate() factory
│   │
│   ├── lib/
│   │   ├── ratingNormalizer.js           # Single source of truth: credit rating normalization
│   │   └── indiaBondInfo/
│   │       ├── client.js                 # Rate-limited, retry, circuit-breaker NSDL client
│   │       ├── nsdlClient.js             # Session-cookie NSDL client (CBDServices)
│   │       ├── publicClient.js           # Unauthenticated public endpoints
│   │       ├── transformers.js           # NSDL API → Bond schema transformers
│   │       └── circuitBreaker.js         # Circuit breaker implementation
│   │
│   ├── routes/
│   │   └── mockLocalRoutes.js            # All API endpoints (MongoDB-first + fallback)
│   │
│   ├── models/                           # Mongoose schemas (legacy reference)
│   │   ├── Bond.js
│   │   ├── BondHistory.js
│   │   ├── IngestionLog.js
│   │   └── Issuer.js
│   │
│   ├── scripts/
│   │   └── seedBonds.js                  # JSON → MongoDB migration (run once)
│   │
│   └── jobs/
│       └── syncScheduler.js              # Cron: NSDL data sync (every 12 days)
│
└── docs/
    └── ARCHITECTURE.md                   # This file
```

---

## Middleware Stack

Middleware is applied in this **exact order** (order is critical):

| # | Middleware | Purpose | Config |
|---|-----------|---------|--------|
| 1 | `requestId` | Assigns UUID to every request; sets `X-Request-ID` response header | `uuid.v4()` |
| 2 | `helmet` | Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy | CSP disabled |
| 3 | `compression` | Gzip response compression | Default threshold |
| 4 | `cors` | Origin restriction | `CORS_ORIGINS` env |
| 5 | `express-rate-limit` | 200 requests/min per IP | `windowMs: 60000, max: 200` |
| 6 | `requestLogger` | Structured JSON request/response logging | INFO/WARN/ERROR by duration |
| 7 | Routes | Zod-validated endpoints | Zod schemas per route |
| 8 | `errorHandler` | Catches all unhandled errors; returns standard error JSON | Last middleware |

---

## API Reference

### Base URL
```
http://localhost:5050/api
```

### Bond Endpoints

#### `GET /bonds`
List all bonds with filtering, sorting, and pagination.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | integer | 1 | Page number (1–10000) |
| `limit` | integer | 50 | Results per page (1–200) |
| `sort` | string | `rating:desc` | Sort field: `rating`, `couponRate`, `maturityDate` with `:asc`/`:desc` |
| `activeStatus` | string | — | Filter: `Active`, `Matured` |
| `bondType` | string | — | Filter by bond type |
| `issuer` | string | — | Filter by issuer name |
| `rating` | string | — | Filter by raw credit rating |
| `ratingNorm` | string | — | Filter by normalized rating (e.g., `AAA`, `AA`) |
| `maturityYear` | integer | — | Filter by maturity year (2000–2100) |
| `isRestructured` | boolean | — | `true` or `false` |
| `minRate` | number | — | Minimum coupon rate (%) |
| `maxRate` | number | — | Maximum coupon rate (%) |

**Response:**
```json
{
  "success": true,
  "bonds": [ { "isin": "...", "issuer": {}, "couponRate": 9.5, ... } ],
  "pagination": { "page": 1, "limit": 50, "total": 26679, "pages": 534 }
}
```

---

#### `GET /bonds/stats`
Aggregated statistics for the entire bond universe.

**Response:**
```json
{
  "success": true,
  "stats": {
    "total": 26679,
    "active": 18234,
    "restructured": 412,
    "uniqueIssuers": 5425,
    "ratingDistribution": [ { "rating": "AAA", "count": 3200 }, ... ],
    "topIssuers": [ { "id": "reliance-industries-ltd", "name": "...", "count": 5 }, ... ]
  }
}
```

---

#### `GET /bonds/maturing-soon`
Bonds expiring within N months.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `months` | integer | 6 | Window (1–120) |
| `page` | integer | 1 | — |
| `limit` | integer | 50 | — |
| `ratingNorm` | string | — | Filter by normalized rating |

---

#### `GET /bonds/search`
Full-text search by ISIN or issuer name.

| Param | Type | Constraint | Description |
|-------|------|-----------|-------------|
| `q` | string | min 2 chars, max 100 | Search term |
| `limit` | integer | 1–50 | Max results |
| `status` | string | — | Filter by `activeStatus` |

---

#### `GET /bonds/:isin`
Single bond detail by ISIN + related bonds from same issuer.

**Path Param:** `isin` — must match ISIN format `^[A-Z]{2}[A-Z0-9]{9}[0-9]$`

---

### Issuer Endpoints

#### `GET /issuers`
List issuers (aggregated from bonds collection).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | integer | 1 | — |
| `limit` | integer | 50 | — |
| `sort` | string | `totalActiveBonds` | `name` or `totalActiveBonds` |
| `issuerType` | string | — | Filter by type |
| `ownershipType` | string | — | Filter by ownership |
| `sector` | string | — | Filter by sector |
| `q` | string | — | Search by name |

---

#### `GET /issuers/search`
Typeahead search for issuers.

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Min 2 chars |
| `limit` | integer | Default 5, max 50 |

---

#### `GET /issuers/:id`
Full issuer profile with stats.

**Response includes:** `ratingDistribution`, `maturityDistribution`, `couponRateRange`, `totalActiveBonds`, `avgCouponRate`

---

#### `GET /issuers/:id/bonds`
Paginated bonds for a specific issuer, with filtering.

---

### System Endpoints

#### `GET /api/health`
```json
{
  "status": "OK",
  "service": "bond-directory",
  "uptime": 3600,
  "timestamp": "2026-02-25T05:20:54.063Z",
  "requestId": "4edf4b18-9801-4293-97bb-7108eb7cd75b",
  "environment": "production",
  "db": { "status": "connected", "latencyMs": 46 },
  "memory": { "rss": "68.4MB", "heapUsed": "118.8MB" }
}
```

### Standardized Error Response
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [
      { "field": "page", "message": "Too small: expected number to be >=1" }
    ]
  },
  "requestId": "4edf4b18-9801-4293-97bb-7108eb7cd75b"
}
```

**Error codes:** `VALIDATION_ERROR` · `NOT_FOUND` · `RATE_LIMIT_EXCEEDED` · `INTERNAL_ERROR`

---

## Database Schema

### Collection: `bondsdirectory`

```json
{
  "_id": "INE002A07809",
  "isin": "INE002A07809",
  "issuer": {
    "id": "reliance-industries-ltd",
    "name": "RELIANCE INDUSTRIES LIMITED",
    "sector": "Diversified (IN120101001)",
    "ownershipType": "private",
    "issuerType": "Non PSU",
    "latestRating": "ICRAAAA/STABLE"
  },
  "couponRate": 8.65,
  "couponType": "fixed",
  "couponFrequency": "annual",
  "maturityDate": "2029-11-15T00:00:00.000Z",
  "issueDate": "2019-11-15T00:00:00.000Z",
  "faceValue": 1000000,
  "minInvestment": 1000000,
  "creditRating": "ICRAAAA/STABLE;CRISILAAA/STABLE",
  "normalizedRating": "AAA",
  "activeStatus": "Active",
  "isRestructured": false,
  "bondsType": "NCD",
  "dataSource": "IndiaBondInfo-NSDL",
  "lastSyncedAt": "2026-02-25T05:20:54.063Z"
}
```

### Indexes (11 total)

| Index Name | Fields | Type | Supports |
|-----------|--------|------|---------|
| `idx_isin_unique` | `isin: 1` | Unique | Bond detail lookup |
| `idx_activeStatus` | `activeStatus: 1` | Single | Status filter |
| `idx_issuer_id` | `issuer.id: 1` | Single | Issuer page |
| `idx_normalizedRating` | `normalizedRating: 1` | Single | Rating filter/sort |
| `idx_bondsType` | `bondsType: 1` | Single | Type filter |
| `idx_isRestructured` | `isRestructured: 1` | Single | Restructured filter |
| `idx_maturityDate` | `maturityDate: 1` | Single | Maturity range |
| `idx_couponRate` | `couponRate: 1` | Single | Rate filter/sort |
| `idx_status_rating` | `activeStatus, normalizedRating` | Compound | Combined filter |
| `idx_status_maturity` | `activeStatus, maturityDate` | Compound | Maturing-soon |
| `idx_issuer_status_maturity` | `issuer.id, activeStatus, maturityDate` | Compound | Issuer bonds page |
| `idx_text_search` | `isin:10, issuer.name:5` | Text | Full-text search |
| `idx_issuer_agg` | `issuer.id, issuer.name` | Compound | Issuer aggregation |

---

## Security

| Feature | Implementation | Status |
|---------|---------------|--------|
| Security headers | Helmet (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy) | ✅ |
| Rate limiting | 200 req/min per IP (`express-rate-limit`) | ✅ |
| CORS | Configurable via `CORS_ORIGINS` env | ✅ |
| Input validation | Zod schemas on all query params — type coercion, range limits, ISIN regex | ✅ |
| ReDoS protection | All user regex input escaped before use | ✅ |
| Request ID | UUID per request, propagated in `X-Request-ID` | ✅ |
| Error masking | Stack traces hidden in `NODE_ENV=production` | ✅ |
| Non-root Docker | Runs as `appuser:1001` in container | ✅ |
| No secrets in image | `.dockerignore` blocks `.env` | ✅ |
| Authentication | ❌ Not yet implemented — all endpoints public |
| RBAC | ❌ Not yet implemented |

---

## Observability & Logging

### Log Format (Structured JSON)
```json
{
  "timestamp": "2026-02-25T05:20:54.063Z",
  "level": "INFO",
  "service": "bond-directory",
  "requestId": "4edf4b18-9801-4293-97bb-7108eb7cd75b",
  "method": "GET",
  "path": "/api/bonds?page=1&limit=50",
  "status": 200,
  "durationMs": 45,
  "ip": "::1",
  "userAgent": "Mozilla/5.0..."
}
```

### Log Levels
| Level | Condition |
|-------|-----------|
| `INFO` | Request completed < 500ms |
| `WARN` | Request completed in 500–2000ms |
| `ERROR` | Request > 2000ms, 5xx response, or uncaught error |

### Health Check
`GET /api/health` — reports DB connection, latency, uptime, memory. Use for liveness + readiness probes.

---

## Performance Architecture

### Current (In-Memory Fallback)
- 26,679 bonds loaded into memory (~57MB RSS)
- O(n) array scans for filtering (no indexes)
- Stats/aggregations computed per request

### Target (MongoDB)
- **11 indexes** covering every query pattern
- **`$facet`** aggregation for single-query pagination + count
- **`normalizedRating`** pre-computed — eliminates per-request normalization
- **p95 target:** < 50ms for bond list, < 200ms for aggregations

### Future: Redis Cache Layer
```
GET /api/bonds/stats  → Redis (TTL: 5 min)  → MongoDB (miss)
GET /api/bonds/:isin  → Redis (TTL: 1 hour) → MongoDB (miss)
```
Planned cache keys: `bond:isin:{ISIN}`, `bonds:stats`, `issuers:list:{hash}`, `bonds:maturing:{months}`

---

## Deployment

### Docker (Recommended)
```bash
# Build
docker build -t gi-bond-directory-be .

# Run (inject secrets at runtime — never in image)
docker run -d \
  --name bond-directory \
  -p 5050:5050 \
  -e NODE_ENV=production \
  -e BOND_MONGO_URI="mongodb+srv://..." \
  -e CORS_ORIGINS="https://gripinvest.in" \
  gi-bond-directory-be

# Health check
curl http://localhost:5050/api/health
```

### Docker Compose (Local Dev)
```yaml
version: '3.8'
services:
  bond-directory:
    build: .
    ports:
      - "5050:5050"
    env_file: .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:5050/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `5050` | Server port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `BOND_MONGO_URI` | No* | — | MongoDB Atlas URI (`mongodb+srv://...`) |
| `BOND_COLLECTION_NAME` | No | `bondsdirectory` | Collection name |
| `CORS_ORIGINS` | No | `*` (all) | Comma-separated allowed origins |
| `NSDL_JSESSIONID` | No | — | NSDL session cookie (ETL only) |
| `NSDL_BIGipServerPool` | No | — | NSDL LB cookie (ETL only) |
| `BOND_SYNC_SCHEDULE` | No | `0 2 */12 * *` | Cron schedule for bond sync |

> *If `BOND_MONGO_URI` is not set, server falls back to in-memory JSON (`frontend_bonds_export.json`).

---

## Data Migration (Seed)

To populate MongoDB from the JSON export:

```bash
# Prerequisites: BOND_MONGO_URI set in .env, frontend_bonds_export.json present
node bond-directory/scripts/seedBonds.js
```

**What it does:**
1. Reads `frontend_bonds_export.json` (26,679 bonds)
2. Drops existing collection data
3. Pre-computes `normalizedRating` for every bond
4. Bulk-inserts in batches of 5,000
5. Creates all 13 indexes
6. Prints verification summary + top rating distribution

**Blocker:** MongoDB Atlas user (`gi-academy-qa`) requires `readWrite` role on the `bondsdirectory` database.

---

## Production Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Helmet security headers | ✅ |
| 2 | Gzip compression | ✅ |
| 3 | Rate limiting (200/min) | ✅ |
| 4 | CORS restriction | ✅ |
| 5 | Input validation (Zod) | ✅ |
| 6 | Centralized error handler | ✅ |
| 7 | Structured JSON logging | ✅ |
| 8 | Request ID correlation | ✅ |
| 9 | Environment validation at startup | ✅ |
| 10 | Graceful shutdown (SIGTERM/SIGINT) | ✅ |
| 11 | Health check endpoint | ✅ |
| 12 | Multi-stage Dockerfile | ✅ |
| 13 | Docker HEALTHCHECK | ✅ |
| 14 | Non-root container user | ✅ |
| 15 | `.dockerignore` (no secrets in image) | ✅ |
| 16 | ESLint + Prettier | ✅ |
| 17 | Rating normalizer (single source) | ✅ |
| 18 | MongoDB Atlas permissions | ⬜ Pending |
| 19 | Automated tests (Jest/Supertest) | ⬜ Pending |
| 20 | CI/CD pipeline (GitHub Actions) | ⬜ Pending |
| 21 | Redis cache layer | ⬜ Pending |
| 22 | OpenAPI/Swagger documentation | ⬜ Pending |
| 23 | Authentication (JWT) | ⬜ Pending |
| 24 | RBAC | ⬜ Pending |

---

## Known Limitations & Next Steps

### Limitations
1. **MongoDB Atlas permissions** — `gi-academy-qa` user currently lacks `readWrite` on `bondsdirectory` database. Server operates in in-memory fallback mode until fixed.
2. **No authentication** — all endpoints are public. JWT middleware must be added before exposing to production traffic.
3. **No Redis** — `/stats` and issuer aggregations query MongoDB on every request.
4. **No automated tests** — no regression safety net currently.
5. **In-memory fallback is not horizontally scalable** — 57MB of JSON per instance.

### Immediate Next Steps (Priority Order)
1. Grant `readWrite` on `bondsdirectory` in MongoDB Atlas → run `seedBonds.js`
2. Add JWT authentication middleware
3. Add Jest + Supertest test suite
4. Implement Redis cache layer
5. Set up GitHub Actions CI/CD
6. Generate OpenAPI/Swagger spec

---

*For questions, contact the GripInvest backend team.*
