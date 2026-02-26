# Code Feedback — Bond Directory Backend

**For:** Product team developer  
**Purpose:** Concise, actionable feedback to improve code quality and avoid production issues.

---

## Critical (fix before relying on these features)

### 1. Broken dependency — sync scheduler
**Issue:** `syncScheduler.js` requires `../lib/etl/bondSync`, but that file doesn't exist.  
**Impact:** Any code that calls `startScheduler()` will crash on startup.  
**Action:** Either implement `bond-directory/lib/etl/bondSync.js` (with a `syncBonds` export), or remove/comment out the scheduler until the ETL is ready. Don't leave a required dependency missing.

### 2. Fallback doesn't work in Docker
**Issue:** When MongoDB fails, the app tries to load `frontend_bonds_export.json` from the app root. In Docker, that file is never copied in (see Dockerfile and .dockerignore).  
**Impact:** In production, "Mongo unavailable" always leads to a crash, not a fallback.  
**Action:** Either (a) add a step to copy or mount the JSON into the container and document it, or (b) remove the fallback and fail clearly when DB is down so ops know to fix MongoDB.

### 3. Inconsistent error responses
**Issue:** Route handlers use `sendError(res, 500, e.message)`, which returns a plain string in `error`. The rest of the app uses a standard shape: `{ success: false, error: { code, message }, requestId }`.  
**Impact:** Frontend/clients have to handle two different error formats.  
**Action:** In route handlers, use `next(err)` or throw `AppError` so the central error handler always formats the response. Use the existing `AppError` and `errorHandler` for all errors.

---

## Important (improve maintainability and correctness)

### 4. Validate ISIN on bond detail route
**Issue:** `GET /bonds/:isin` doesn't validate the `isin` param. Invalid values (e.g. `"abc"`) go to the DB and return 404 or odd behavior.  
**Action:** Use the existing `validate(schemas.isinParamSchema, 'params')` (or equivalent) on this route so invalid ISINs get a 400 with the same error shape as other validation errors.

### 5. Misleading file/export names
**Issue:** File is named `mockLocalRoutes.js` and exports `mockBondRoutes` / `mockIssuerRoutes`, but this is the real API, not mocks.  
**Action:** Rename to something like `bondRoutes.js` and export `bondRoutes` / `issuerRoutes` so the codebase clearly reflects that these are production routes.

### 6. Duplicated logic in routes
**Issue:** Every bond/issuer route repeats the same pattern: "if Mongo available do X, else use in-memory fallback," plus repeated pagination and sort logic.  
**Action:** Extract shared helpers (e.g. `withBondSource(fn)`, `parsePagination(query)`, one place for sort-field mapping) so adding or changing behavior only happens in one place.

---

## Pagination, naming, rate limiting & linting

### Pagination
**Current state:**  
- **With pagination (page + limit):** `GET /bonds`, `GET /bonds/maturing-soon`, `GET /issuers`, `GET /issuers/:id/bonds` — all use `page`, `limit`, and return a `pagination` object. Good.  
- **Without page-based pagination:**  
  - `GET /bonds/search` — only has `limit` (max 50). No `page`; clients cannot fetch the next set of results.  
  - `GET /issuers/search` — only has `limit` (max 20). Same issue.

**Action:** Add optional `page` (and total count in the response) to both search endpoints so clients can paginate when there are many matches. Reuse `paginationSchema` or a similar pattern for consistency.

### File naming conventions
**Current state:**  
- Routes file is `mockLocalRoutes.js` with exports `mockBondRoutes` / `mockIssuerRoutes` — misleading for production code.  
- Rest of the codebase uses **camelCase** for JS files (`bondDirectoryDb.js`, `envValidation.js`, `requestLogger.js`, etc.) — that's fine.  
- Folder names use **kebab-case** (`bond-directory`) — also fine.

**Action:**  
- Rename `mockLocalRoutes.js` → e.g. `bondRoutes.js` (or `routes.js`) and export `bondRoutes` / `issuerRoutes`.  
- Avoid "mock" in any production file name so it's clear what is real vs test-only.

### Rate limiting
**Current state:**  
- `express-rate-limit` is applied in `index.js` to all `/api/` routes: 200 requests per minute per IP, with a proper JSON error body (`RATE_LIMIT_EXCEEDED`).  
- Health check and all bond/issuer APIs are covered.

**Action:** No code change needed. Optionally document the limit (200/min) and that it's per-IP in `ARCHITECTURE.md` or API docs so frontend/ops know what to expect.

### Linting
**Current state:**  
- **ESLint:** `.eslintrc.json` exists with sensible rules (no-var, prefer-const, eqeqeq, quotes, etc.). `npm run lint` and `lint:fix` are in `package.json`.  
- **Prettier:** `.prettierrc` exists (singleQuote, semi, tabWidth 4, etc.) but there is **no** `format` or `prettier` script in `package.json`, so formatting is not run (or enforced in CI).  
- **ESLint config:** `parserOptions.sourceType` is `"module"` while the codebase uses `require()` (CommonJS). For pure CommonJS, use `"script"` or omit so the default applies; otherwise ESLint's parsing may not match how Node runs the code.

**Action:**  
- Add a script, e.g. `"format": "prettier --write \"**/*.js\""` and optionally `"format:check": "prettier --check \"**/*.js\""`, and run format (or format:check) in CI.  
- Set `parserOptions.sourceType` to `"script"` (or remove it) in `.eslintrc.json` so it matches CommonJS.  
- Optionally run `npm run lint` in CI so lint failures block merges.

---

## Code quality (detailed)

### 1. Duplication and DRY
- **Mongo vs fallback:** Every route repeats the same pattern: `if (isMongoAvailable()) { ... return sendSuccess(...) }` then `if (!fallbackDb) return sendError(...)` then in-memory logic. This is duplicated across 9+ handlers. Extract a small abstraction (e.g. a function that takes `mongoFn` and `fallbackFn`) so the pattern lives in one place.
- **Pagination:** `const p = Math.max(1, parseInt(page) || 1); const l = Math.min(200, Math.max(1, parseInt(limit) || 50));` appears in almost every list route. Same for building the `pagination` object. Move to a shared helper (e.g. `parsePagination(req.query)` and `toPaginationMeta(total, page, limit)`).
- **Sort mapping:** The mapping from `sort` query param (e.g. `rating:desc`) to MongoDB sort object and to in-memory sort comparator is duplicated between the bonds list and issuer bonds. Centralize in one place (e.g. `getSortForBonds(sortParam)` and use for both Mongo and fallback).

### 2. Error handling consistency
- **Two error shapes:** `sendError(res, status, message)` sends `{ success: false, error: message }` where `message` is a string. The central `errorHandler` sends `{ success: false, error: { code, message }, requestId }`. Clients cannot rely on a single shape. Either make `sendError` accept an object `{ code, message }` and match the standard, or stop using `sendError` and use `next(new AppError(...))` everywhere.
- **Redundant try/catch:** Handlers are wrapped in `asyncHandler` (which already forwards errors to `next`), but each handler also has `try { ... } catch (e) { sendError(res, 500, e.message) }`. So errors are caught and sent with the non-standard shape instead of reaching the central handler. Prefer: remove the inner try/catch and let errors bubble to `errorHandler`, or catch only to wrap in `AppError` and then `next(err)`.

### 3. Validation and request data
- **Double parsing:** After Zod validation, `req.query` is already coerced (e.g. `page` and `limit` are numbers). Re-doing `parseInt(page)` and `parseInt(limit)` in every route is redundant. Use `req.query.page` and `req.query.limit` as-is once validation runs.
- **Missing validation on some routes:** `GET /issuers/search` has no `validate()` middleware; `q` and `limit` are only checked inline. Add a small Zod schema (e.g. `issuerSearchSchema`) so all search/list endpoints validate the same way.
- **ISIN route:** `GET /bonds/:isin` does not use `validate(schemas.isinParamSchema, 'params')`, so invalid ISINs are not rejected with 400 and a consistent error body.

### 4. Regex and filter safety
- **Inconsistent escaping:** In `GET /bonds/search`, user input is escaped before use in `$regex`: `const escaped = safeQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. In list endpoints, filter values are interpolated into regex without escaping: e.g. `filter.activeStatus = { $regex: \`^${activeStatus}$\`, $options: 'i' }`, and similarly for `bondType`, `rating`, `creditRating`, `issuerType`, `sector`. A value like `activeStatus=.*` or `rating=A.` could change the meaning of the regex (match everything or unintended patterns). Escape all user-derived strings that are used in `$regex`, or use exact match (e.g. `filter.activeStatus = activeStatus` if the value is from a fixed set).

### 5. Magic numbers and constants
- Pagination limits (50, 200), search limits (10, 20, 50), and fixed sizes (8 related bonds, 5 same-rating, 12 top issuers) are hard-coded in multiple places. Define named constants (e.g. `DEFAULT_PAGE_SIZE = 50`, `MAX_PAGE_SIZE = 200`, `RELATED_BONDS_LIMIT = 8`) in one file and reuse so changing behavior is done in one place.

### 6. Response shape and helpers
- **sendSuccess:** Used correctly; spreading `data` and `meta` is fine. The attribution string is repeated in every success response; it could live on a single constant or be added in a response middleware.
- **Pagination keys:** Some responses use `pages`, others use both `pages` and `totalPages` (same value). Prefer one consistent key (e.g. always `totalPages`) to avoid confusion.

### 7. State and testability
- **Module-level state:** `collection` and `fallbackDb` are set by `setBondCollection` and `setFallbackData` from `index.js`. This makes the routes depend on global mutable state and harder to unit test (you have to mutate module state). Consider passing the data source (Mongo collection or fallback) into the router or a small service so tests can inject a mock without touching globals.

### 8. Naming and readability
- **Short variables:** `p` and `l` for page and limit are used everywhere. More descriptive names (`pageNum`, `pageSize`) would make the code easier to read.
- **sendError signature:** `sendError(res, status, message)` — the order is clear, but the fact that `message` is a string (not an object) is not obvious from the name. Consider `sendError(res, status, { code, message })` to align with the standard error shape.

### 9. Validate middleware and req mutation
- The validate middleware mutates `req.query` by clearing keys and assigning the Zod result. The comment mentions "Express 5+ makes req.query a getter" — if you are on Express 4, this mutation is fine; if you move to Express 5, ensure this pattern is still supported or use a different approach (e.g. put parsed data on `req.validated`).

### 10. Config and env
- **bondDirectoryDb.js** reads `process.env.BOND_MONGO_URI` and `BOND_COLLECTION_NAME` at load time. The rest of the app uses `validateEnv()` at startup. If the DB module is ever required before env validation, or if env changes, you could have a mismatch. Prefer passing validated config (e.g. from `validateEnv()`) into the DB layer so there is a single source of truth.

---

## Deeper / additional issues

### Correctness & API contract

**11. Bonds list sort by rating (MongoDB) is wrong**  
- Default sort is "best rating first" but MongoDB uses `{ normalizedRating: 1 }` (ascending). String sort gives "A", "AA", "AAA" → worst first.  
- In-memory fallback correctly uses `getRatingRank()` (AAA=1, so ascending = best first).  
- **Action:** Store a numeric `ratingRank` on each document (from `getRatingRank(normalizedRating)`) at seed time and sort by that, or use an aggregation that maps rating → rank and sort by rank. Otherwise "rating:desc" does not mean "best first" when using MongoDB.

**12. Stats fallback response missing `topIssuers`**  
- When MongoDB is used, stats include `topIssuers`. When fallback is used, the response has no `topIssuers`.  
- **Action:** In the stats fallback branch, compute top issuers from `fallbackDb.bonds` (e.g. group by `issuer.id`, sort by count, take top 12) and add `topIssuers` so the response shape is the same.

**13. Mutating shared fallback data (GET /issuers/:id)**  
- Fallback branch does `issuer.maturityDistribution = []; issuer.couponRateRange = ...` on the object from `fallbackDb.issuers.find()`. That mutates the in-memory cache.  
- **Action:** Clone the issuer before mutating (e.g. `const issuer = { ...fallbackDb.issuers.find(...) }` or a deep clone), then set the extra fields on the clone.

**14. `isRestructured=false` not applied in filter**  
- When user sends `isRestructured=true` you set `filter.isRestructured = true`. When `isRestructured=false` you do nothing, so the result includes all bonds.  
- **Action:** When `isRestructured === 'false'`, set `filter.isRestructured = false` so clients can filter for "only non-restructured".

**15. No validation for `minRate` ≤ `maxRate`**  
- If both `minRate` and `maxRate` are sent with minRate > maxRate, the filter becomes e.g. `couponRate: { $gte: 10, $lte: 5 }`, which matches nothing.  
- **Action:** In Zod, add a `.refine()` (or check in the handler) that when both are present, `minRate <= maxRate`, and return 400 with a clear message.

### Health, security & robustness

**16. Request ID from client is trusted**  
- `req.id = req.headers['x-request-id'] || uuidv4()`. A client can send any string (e.g. with newlines or very long). That value is logged and sent in headers; could be used for log injection or bloat.  
- **Action:** Sanitize or cap length (e.g. take first 64 chars, strip non-printable characters), or ignore client-provided value and always use a server-generated UUID.

**17. Body parsing for GET-only API**  
- `express.json({ limit: '1mb' })` runs for all routes. The API is read-only GET; accepting large bodies is unnecessary and could be used for a small DoS.  
- **Action:** Optional: only apply `express.json()` to routes that need it, or remove it until you have POST/PUT. Low priority.

### Scheduler, models & dead code

**18. Scheduler uses Mongoose but app never connects**  
- `syncScheduler` requires `IngestionLog` (Mongoose). The app only uses the native MongoDB driver for `bondsdirectory` and never calls `mongoose.connect()`. If `startScheduler()` were ever called, `IngestionLog.findOne()` would fail.  
- **Action:** Either connect Mongoose to the same (or another) DB before starting the scheduler, or remove/comment out the scheduler until the full ETL + Mongoose setup exists.

**19. Mongoose models are unused by the API**  
- `Bond`, `BondHistory`, `Issuer`, `IngestionLog` use Mongoose and collections like `academy_bonds`, `academy_ingestion_logs`. The running API uses the native driver and collection `bondsdirectory`. These models are dead code for the current app.  
- **Action:** Document that they are for a different flow (e.g. ETL or another service), or remove them if not needed, to avoid confusion.

**20. Circuit breaker `monitorWindow` is never used**  
- Constructor sets `this.monitorWindow = options.monitorWindow || 300000` but it is never read.  
- **Action:** Remove the option or implement a sliding-window failure count (e.g. only count failures in the last `monitorWindow` ms) so the breaker can recover under burst failures.

### Data & scripts

**21. Seed script doesn't check for partial insert failure**  
- `insertMany(batch, { ordered: false })` can partially succeed. You only use `result.insertedCount`; you don't check for `writeErrors` or that `insertedCount === batch.length`.  
- **Action:** After each batch, if `result.insertedCount < batch.length` (or if `result.hasWriteErrors()`), log the errors or fail the script so you notice duplicate keys or other write failures.

**22. Fallback JSON expected shape is undocumented**  
- Fallback expects `data` to have `bonds`, `issuers`, and (for stats) `stats: { totalActive, uniqueIssuers }`. The seed script reads `bonds` and `issuers` from an export but doesn't produce `stats`. So the file used for fallback must be a different export that includes `stats`.  
- **Action:** Document in README or ARCHITECTURE the exact shape of `frontend_bonds_export.json` (or the fallback file), including `stats`, so anyone generating the file knows what to include.

**23. `issuerIdParamSchema` is never used**  
- `validate.js` exports `issuerIdParamSchema` but no route uses `validate(schemas.issuerIdParamSchema, 'params')` for `GET /issuers/:id` or `GET /issuers/:id/bonds`.  
- **Action:** Add the same validation to those routes so invalid or missing `id` returns 400 with a consistent error shape.

### Edge cases

**24. Empty `CORS_ORIGINS`**  
- If `CORS_ORIGINS=""` in env, you get `origin: ['']`. That may allow `Origin: ""` (rare).  
- **Action:** When parsing CORS_ORIGINS, treat empty string as "no restriction" (e.g. use `*`) or validate that each origin is non-empty after trim.

---

## Good practices to keep

- **Architecture doc** (`ARCHITECTURE.md`) — Clear and useful; keep it updated.
- **Zod validation** — Using schemas for query params is the right approach.
- **Security** — Helmet, CORS, rate limit, ReDoS-safe regex; good baseline.
- **Rating normalizer** — Single source of truth for ratings; used in seed and API.
- **Structured logging** — JSON logs with request ID help debugging.
- **Graceful shutdown** — SIGTERM/SIGINT handling is correct.

---

## Quick checklist

| Item | Status |
|------|--------|
| Fix or remove sync scheduler dependency | ⬜ |
| Fix or remove MongoDB fallback in Docker | ⬜ |
| Use central error handler for all route errors | ⬜ |
| Add ISIN validation to `GET /bonds/:isin` | ⬜ |
| Rename mockLocalRoutes → bondRoutes | ⬜ |
| Reduce duplication (Mongo vs fallback, pagination) | ⬜ |
| Add page-based pagination to `GET /bonds/search` and `GET /issuers/search` | ⬜ |
| Document rate limit (200/min per IP) in ARCHITECTURE or API docs | ⬜ |
| Add Prettier script and fix ESLint sourceType for CommonJS | ⬜ |
| Run lint (and optionally format check) in CI | ⬜ |
| Escape user input in all `$regex` filters (or use exact match) | ⬜ |
| Use central error handler (remove inner try/catch + sendError in routes) | ⬜ |
| Add validation for `GET /issuers/search` (Zod schema) | ⬜ |
| Extract pagination/sort helpers and Mongo vs fallback abstraction | ⬜ |
| Replace magic numbers with named constants | ⬜ |
| Fix bonds list sort by rating in MongoDB (use rating rank, not string sort) | ⬜ |
| Add topIssuers to stats fallback response | ⬜ |
| Clone issuer in GET /issuers/:id fallback before mutating | ⬜ |
| Apply isRestructured=false filter when user sends false | ⬜ |
| Validate minRate ≤ maxRate when both present | ⬜ |
| Sanitize or cap X-Request-ID from client | ⬜ |
| Use issuerIdParamSchema on GET /issuers/:id and /:id/bonds | ⬜ |
| Seed: check insertMany errors / partial failure | ⬜ |
| Document fallback JSON expected shape (bonds, issuers, stats) | ⬜ |

---

*Keep this doc next to the code and tick off items as you address them. If anything is unclear, pair with a backend engineer for a quick pass.*
