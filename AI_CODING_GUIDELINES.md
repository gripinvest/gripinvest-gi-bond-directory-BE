# AI Coding Guidelines

**For:** Product team developers using AI tools (Cursor, Antigravity, etc.)  
**Purpose:** Paste this document into your AI tool as context before writing any code. These rules apply to every new Node.js/Express backend project.

---

## How to use this document

1. **Cursor:** Add this file to `.cursor/rules/` in your project, or paste its contents at the start of any chat session.
2. **Antigravity / other AI tools:** Paste the full contents as a system prompt or context block before asking the AI to write code.
3. **New projects:** Copy this file into the root of every new repo so the rules are always available.

---

## 1. Code Quality

### Single responsibility
Every function does exactly one thing. If a function does more than one thing, split it into smaller named functions.

### Descriptive naming
- No one-letter or abbreviated variable names (`p`, `l`, `q`, `tmp`). Use `pageNum`, `pageSize`, `queryString`, `totalCount`.
- Function names must describe the action they perform: prefer `getUserById` over `getUser`, `formatCurrencyAmount` over `format`.
- Boolean variables and functions must read as questions: `isActive`, `hasPermission`, `canRetry`.

### No magic numbers or strings
All repeated numeric or string literals (limits, defaults, status codes, fixed keys, timeouts) must be defined as named constants in a dedicated `constants.js` (or `constants/index.js`) and imported from there. Never inline them in business logic.

```js
// Bad
const results = items.slice(0, 50);

// Good
const DEFAULT_PAGE_SIZE = 50;
const results = items.slice(0, DEFAULT_PAGE_SIZE);
```

### Central error handler
Every Express app must have one central error handler registered at the bottom of the middleware stack. Route handlers must call `next(err)` or throw using a custom `AppError` class — never send error responses inline with `res.status(500).json(...)` inside routes.

### Consistent response shapes
All API responses must follow the same shape — no exceptions, no mixing.

**Success:**
```json
{
  "success": true,
  "data": {},
  "meta": {},
  "requestId": "uuid"
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message"
  },
  "requestId": "uuid"
}
```

### Avoid global mutable state
Pass dependencies (DB clients, config, data sources) into routers and services as arguments or via dependency injection. Never rely on module-level variables that are mutated after startup.

### No dead code
Remove unused imports, variables, functions, and commented-out code before opening a PR. Dead code creates confusion about what is production.

### Never mutate shared data
When enriching or transforming an object from a shared source (DB result, in-memory cache), always clone it first before setting extra fields.

```js
// Bad — mutates the shared cache object
const user = cache.find(u => u.id === id);
user.extraField = 'value';

// Good — clone first
const user = { ...cache.find(u => u.id === id) };
user.extraField = 'value';
```

---

## 2. Linting and Formatting

### ESLint — mandatory baseline rules
Every project must have `.eslintrc.json` (or equivalent) with at minimum:

- `no-var` — use `const` or `let`
- `prefer-const` — use `const` when a variable is never reassigned
- `eqeqeq: ["error", "always"]` — always `===` / `!==`, never `==` / `!=`
- `quotes: ["error", "single"]` — single quotes for strings
- `indent: ["error", 4]` — 4-space indentation
- `comma-dangle: ["error", "always-multiline"]` — trailing commas on multi-line structures
- `max-len: ["warn", { "code": 140 }]` — max line length 140 (URLs and template literals excluded)
- `no-unused-vars: ["error", { "argsIgnorePattern": "^_" }]`
- `no-throw-literal` — always throw `Error` objects, never plain strings or objects
- `parserOptions.sourceType` — set to `"script"` for CommonJS (`require`) or `"module"` for ESM (`import`); must match the actual module system

### Prettier — mandatory formatting
Set up Prettier alongside ESLint. Add these scripts to `package.json`:

```json
"format": "prettier --write \"**/*.js\"",
"format:check": "prettier --check \"**/*.js\""
```

Run `npm run format` before pushing. Run `format:check` in CI.

### CI enforcement
Both `npm run lint` and `npm run format:check` must run in CI and block merges on failure. No exceptions.

### Before every commit
1. Run `npm run lint` — fix all errors
2. Run `npm run format` — auto-fix formatting
3. If either fails, do not push until fixed

---

## 3. Git and Pull Requests

### One PR per small task
One PR = one logical change: one feature, one bug fix, or one refactor. Never bundle unrelated changes into a single PR.

### Keep PRs small
Aim for under 400 lines of diff. Large PRs are hard to review and hard to revert safely. If a task is large, break it into sequential smaller PRs.

### Conventional commit messages
Use the conventional commit format for every commit:

```
<type>: <short description>

Types: feat | fix | refactor | chore | docs | test | perf
```

Examples:
- `feat: add pagination to /users/search`
- `fix: escape user input in regex filter`
- `refactor: extract parsePagination helper`
- `chore: update eslint config for commonjs`

Never use `WIP`, `asdf`, `temp fix`, `done`, `final`, or `test` as commit messages.

### PR description
Every PR must have:
- **What:** one sentence describing what changed
- **Why:** one sentence describing why (link the ticket)
- **How to test:** what a reviewer should check

### Review and merge rules
- Never merge your own PR without at least one reviewer
- All CI checks (lint, format, tests) must pass before merge
- Resolve all review comments before merging

### Never commit secrets
`.env` must always be in `.gitignore`. Provide a `.env.example` with placeholder values. Never commit API keys, tokens, DB connection strings, or passwords — not even in comments.

---

## 4. Cognitive Complexity

### Rule: no function may have cognitive complexity above 10

Cognitive complexity measures how hard code is to understand — not just how many paths it has.

**What increases complexity:**
- `if` / `else` / `else if` blocks
- Loops (`for`, `while`, `forEach`)
- `switch` cases
- Nested callbacks or nested conditions
- Ternary operators inside conditions
- Logical operators (`&&`, `||`) used as control flow
- `try` / `catch` blocks
- Returns from deeply nested blocks

**How to keep it under 10:**

Use guard clauses (early returns) instead of nesting:
```js
// Bad — deeply nested
function process(user) {
    if (user) {
        if (user.isActive) {
            if (user.hasPermission) {
                // logic
            }
        }
    }
}

// Good — guard clauses
function process(user) {
    if (!user) return;
    if (!user.isActive) return;
    if (!user.hasPermission) return;
    // logic
}
```

Extract each meaningful branch into its own named function. Replace complex conditionals with named boolean variables.

### ESLint enforcement (recommended)
Install `eslint-plugin-sonarjs` and add:
```json
"sonarjs/cognitive-complexity": ["error", 10]
```

### AI instruction
Before finishing any function, check its cognitive complexity. If it exceeds 10, split it into smaller functions before submitting.

---

## 5. Avoid Duplicate Code (DRY)

### Rule: if the same logic appears in more than one place, extract it

**Common patterns to centralize:**

- **Pagination parsing** — one function `parsePagination(query)` that reads `page` and `limit`, applies defaults and caps, and returns validated integers
- **Pagination metadata** — one function `toPaginationMeta(total, page, limit)` that builds `{ page, limit, total, totalPages }`
- **Sort mapping** — one function that converts a sort query string (e.g. `"createdAt:desc"`) to a DB sort object or in-memory comparator
- **Data source switching** — if the app has primary/fallback sources, one wrapper handles the switching logic; routes should not each repeat it
- **Response helpers** — a single `sendSuccess(res, data, meta)` and `sendError(res, status, code, message)` that always produce the standard shapes

### AI instruction
Before writing a new helper function, search the codebase for an existing one that does the same (or similar) thing. Reuse or extend it. Never duplicate.

---

## 6. API Security

### Validate all inputs — no exceptions
Every route must validate query params, path params, and request body before use. Use a schema validation library (Zod, Joi, or equivalent).

- Return `400` with a clear, structured error for invalid inputs
- Never access `req.query`, `req.params`, or `req.body` without running through validation middleware first
- Validate path params too (IDs, slugs) — not just query strings

### Safe regex
Never embed raw user input inside a regex or DB `$regex` operator. Always either:
- Escape special characters: `input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`
- Restrict the field to an allowlist and use exact match instead of regex

### Sanitize client-supplied headers
Values like `X-Request-ID` sent by clients must be capped in length (e.g. 64 characters max) and stripped of control characters before logging or forwarding. Always generate server-side UUIDs as the primary correlation ID.

### Never leak internals in error responses
- Never send stack traces, DB error messages, query strings, or internal file paths to the client
- Log the full error server-side (with `requestId`)
- Send only a safe `{ code, message }` to the client

### Never trust the client
Do not use client-supplied values to construct file paths, shell commands, DB field names, or dynamic object keys without strict validation and allowlisting.

### Security middleware baseline — set up on every project
```
helmet          — sets secure HTTP headers
cors            — restrict Origin to known domains; never use * in production
express-rate-limit  — apply to all API routes; return 429 with a JSON body (not HTML)
express.json({ limit: '10kb' })  — cap request body size
```

Document the rate limit (e.g. 200 req/min per IP) in the project's README or architecture doc.

### Secret and credential management
- Never hardcode secrets, tokens, API keys, or DB URIs in source code
- All secrets come from environment variables only
- `.env` must be in `.gitignore`; provide `.env.example` with placeholder values

---

## 7. Pagination

### All list endpoints must support pagination
No endpoint returning more than one item may return an unbounded result set.

### Standard query parameters
- `page` — integer, minimum 1, default 1
- `limit` — integer, minimum 1, maximum 200, default 50

### Standard paginated response envelope
```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 340,
    "totalPages": 7
  }
}
```

### Search endpoints are not exempt
`GET /search?q=...` must also support `page` + `limit` and return the real `total` count so clients can render accurate pagination UI.

### Return the real total count
Never use a "has more" boolean or `limit + 1` trick. Clients need the real total to show "Page 2 of 7".

### Use shared constants and schemas
- Defaults and max limits must be named constants, not inline numbers
- Validate pagination params with a shared schema and reuse it across all list/search routes

---

## 8. HTTP Semantics

### Use correct HTTP methods
- `GET` — read only; must never change server state
- `POST` — create a new resource
- `PUT` — replace a resource entirely
- `PATCH` — update specific fields of a resource
- `DELETE` — remove a resource

### Use correct HTTP status codes

| Status | When to use |
|--------|-------------|
| `200 OK` | Successful read or update |
| `201 Created` | Resource successfully created |
| `400 Bad Request` | Invalid input from client (validation error) |
| `401 Unauthorized` | Not authenticated (no valid token) |
| `403 Forbidden` | Authenticated but not allowed |
| `404 Not Found` | Resource does not exist |
| `409 Conflict` | Resource already exists or state conflict |
| `422 Unprocessable Entity` | Input is valid format but semantically wrong |
| `429 Too Many Requests` | Rate limit exceeded |
| `500 Internal Server Error` | Unexpected server-side failure |

Never send `200` for an error. Never send `500` for a client mistake.

### API versioning
Prefix all routes with a version from day one: `/api/v1/resource`. Never make breaking changes to an existing version — create `/v2/` instead.

---

## 9. File Naming Conventions

Consistent, predictable file names make the codebase easy to navigate and make AI-generated code easier to place correctly.

| File type | Convention | Examples |
|-----------|------------|---------|
| JS/TS source files | `camelCase` | `userService.js`, `authMiddleware.js`, `parsePagination.js` |
| Folders / directories | `kebab-case` | `user-management/`, `api-routes/`, `bond-directory/` |
| Test files | Same name as source + `.test.js` or `.spec.js` | `userService.test.js`, `parsePagination.spec.js` |
| Config files | Conventional name or `kebab-case` | `.eslintrc.json`, `jest.config.js`, `docker-compose.yml` |
| CLI / one-off scripts | `kebab-case` verb-noun | `seed-database.js`, `migrate-schema.js`, `generate-report.js` |
| Root-level documentation | `SCREAMING_SNAKE_CASE` | `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` |
| Nested documentation | `kebab-case` | `docs/api-reference.md`, `docs/deployment-guide.md` |

### Rules that apply to all file names
- Never use spaces in file names
- Never use `mock`, `temp`, `old`, `v2`, `copy`, `new`, or `final` in production file names — clean up or branch properly instead
- File name must describe what the file contains or does, not when it was created or where it came from (not `routesMarch.js`, not `newRoutes.js`)
- One primary export per file; the file name must match the primary export name (e.g. `userService.js` exports `userService` or `UserService`)

---

## 10. Database Query Discipline

### Never run unbounded queries
Always apply a limit. `collection.find({})` with no limit is forbidden in production code.

### Use projections / field selection
Select only the fields you need. Never fetch entire documents when only a few fields are used.

```js
// Bad
const user = await db.collection('users').findOne({ _id: id });

// Good
const user = await db.collection('users').findOne({ _id: id }, { projection: { name: 1, email: 1 } });
```

### Always add indexes for filtered and sorted fields
Any field used in a `find()` filter or sort must have an index. Document indexes in the project's architecture doc or schema file.

### Set query timeouts
Never let a slow query hang a request indefinitely. Set `maxTimeMS` on DB queries or use a request-level timeout.

### Use transactions for multi-step writes
If a single operation involves writing to more than one collection or document, wrap it in a transaction so partial failures do not leave data in an inconsistent state.

### Avoid N+1 queries
Never query inside a loop. Fetch related data in bulk and join/map in memory.

```js
// Bad — N+1
const orders = await getOrders();
for (const order of orders) {
    order.user = await getUserById(order.userId); // one query per order
}

// Good — bulk fetch
const orders = await getOrders();
const userIds = orders.map(o => o.userId);
const users = await getUsersByIds(userIds);
const userMap = Object.fromEntries(users.map(u => [u.id, u]));
orders.forEach(o => { o.user = userMap[o.userId]; });
```

---

## 11. Comment Quality

### Comments explain why, not what
The code already shows what it does. Comments should only explain things the code cannot express: intent, trade-offs, constraints, or non-obvious decisions.

```js
// Bad — restates the code
// Increment the counter
count++;

// Bad — describes the obvious
// Return the result
return result;

// Good — explains a non-obvious constraint
// Limit to 50 here because the downstream PDF renderer crashes above this count.
const MAX_EXPORT_ROWS = 50;
```

### Remove commented-out code before opening a PR
Commented-out code is dead code with extra confusion. Delete it. If you might need it later, it is in git history.

### No TODO comments in PRs
Resolve or ticket every TODO before merging. A merged TODO is a forgotten TODO.

---

## 12. Performance Basics

### Never block the event loop
Node.js is single-threaded. Never run CPU-heavy synchronous operations (large loops, complex computations, synchronous file reads) inside a request handler. Offload to a worker, background job, or async I/O.

### Use async/await everywhere
Never use raw Promise chains or nested callbacks in new code. Use `async/await` for all asynchronous operations.

### Wrap route handlers in asyncHandler
Wrap every async route handler in a utility like:

```js
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
```

This ensures any unhandled rejection automatically reaches the central error handler without needing `try/catch` in every handler.

---

## 13. Environment Config

### Validate env vars at startup — fail fast
Read and validate all environment variables in one place at startup (e.g. a `validateEnv()` function using Zod or a similar schema). If a required variable is missing or invalid, crash immediately with a clear error message. Never let the app start in a broken state.

### Never read process.env in business logic
`process.env.SOMETHING` must only be accessed in the config/env layer. Pass the validated config object into services and routes as a dependency.

```js
// Bad — reading env directly inside a route
app.get('/data', async (req, res) => {
    const db = await connect(process.env.DB_URI);
});

// Good — validated config passed in
const config = validateEnv();
app.get('/data', async (req, res) => {
    const db = await connect(config.dbUri);
});
```

---

## 14. Logging

### Use structured JSON logging
Never use plain `console.log('something happened')`. Use a JSON logger (e.g. `pino`, `winston`) so logs can be queried and aggregated by tools like Datadog, CloudWatch, or Loki.

### Attach requestId to every log entry
Every request gets a server-generated `requestId` (UUID). Attach it to all log entries for that request and include it in all API responses so production issues can be traced end-to-end.

### Never log secrets or PII
Never log passwords, tokens, API keys, credit card numbers, or any personally identifiable information. Redact or omit sensitive fields before logging.

### Log levels
Use the correct log level:
- `error` — something failed and needs attention
- `warn` — something unexpected happened but the request continued
- `info` — normal operational events (server start, route registered)
- `debug` — detailed info useful only during development; must be off in production

---

## 15. Testability

### Write business logic in pure functions
Keep logic that does not depend on `req`, `res`, or the DB in pure utility/service functions. This makes unit testing possible without starting the server or connecting to a DB.

### Use dependency injection
Pass DB clients, config, and external service clients into functions/classes as arguments rather than importing them directly. Tests can then pass in mocks without monkey-patching.

### Structure for testability
```
controllers/   — thin, only reads req and calls service
services/      — business logic; pure functions or classes with injected deps
utils/         — stateless helpers (formatting, parsing, math)
middleware/    — validation, auth, logging
```

---

## 16. Documentation

### Document every new endpoint before merging
Every new API route must have at minimum, in the README or a docs file:
- HTTP method and full path
- Query / path / body parameters with types and constraints
- Success response shape
- Possible error codes and when they occur

### Keep the architecture doc updated
When you add a new service, data source, external API, or major component, update `ARCHITECTURE.md` (or equivalent) so the next developer (or AI) can understand the system without reading all the code.

### Provide `.env.example`
Every repo must have a `.env.example` listing every environment variable the app needs, with a brief comment for each and a placeholder (never a real value).

---

## 17. Graceful Shutdown

Every production service must handle `SIGTERM` and `SIGINT`:

1. Stop accepting new incoming requests
2. Wait for in-flight requests to finish (with a timeout)
3. Close all database connections cleanly
4. Exit with code `0`

This prevents data corruption and dropped requests during deployments.

---

## 18. Dependency Hygiene

- Add a new package only when genuinely needed. Do not add a library to solve something native Node.js or a one-liner can handle.
- Keep `devDependencies` separate from `dependencies`. Anything only needed for linting, testing, or building belongs in `devDependencies`.
- Pin major versions in `package.json` (e.g. `"^4.18.0"`, not `"*"`).
- Never commit `node_modules/`. It must be in `.gitignore`.
- Run `npm audit` regularly. Fix high/critical vulnerabilities before merging.

---

## Quick Reference Checklist

Use this before opening every PR:

- [ ] All functions have cognitive complexity ≤ 10
- [ ] No duplicate logic — shared helpers used or created
- [ ] All route inputs validated (query, params, body)
- [ ] No raw user input in regex or DB operators
- [ ] No secrets or `.env` committed
- [ ] Correct HTTP method and status codes used
- [ ] All list endpoints have pagination with `page`, `limit`, `total`, `totalPages`
- [ ] `npm run lint` passes with zero errors
- [ ] `npm run format:check` passes
- [ ] No `console.log` — structured logging used
- [ ] No magic numbers — named constants used
- [ ] No dead code or commented-out code
- [ ] File names follow the naming convention
- [ ] Conventional commit message format used
- [ ] PR is one logical change, under 400 lines
- [ ] New endpoints documented in README or docs

---

*Copy this file into every new project. Feed it to Cursor or Antigravity as context before writing any code.*
