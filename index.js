/**
 * Bond Directory — Standalone Backend Server
 *
 * A self-contained Express.js service for the GripInvest Bond Directory.
 * Data source: NSDL IndiaBondInfo public API (bondsdirectory MongoDB collection).
 *
 * Middleware stack (in order):
 *   1. Request ID (X-Request-ID correlation)
 *   2. Helmet security headers
 *   3. Gzip compression
 *   4. CORS
 *   5. Rate limiting (200 req/min)
 *   6. Structured JSON request logging
 *   7. Bond + Issuer routes (with Zod validation)
 *   8. Centralized error handler
 *
 * Graceful shutdown: SIGTERM / SIGINT
 * Health check: GET /api/health
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { validateEnv } = require('./bond-directory/config/envValidation');
const { connectBondDb, getBondCollection, closeBondDb, healthCheck: bondDbHealth } = require('./bond-directory/config/bondDirectoryDb');
const { requestId } = require('./bond-directory/middleware/requestId');
const { requestLogger } = require('./bond-directory/middleware/requestLogger');
const { errorHandler } = require('./bond-directory/middleware/errorHandler');
const { mockBondRoutes: bondRoutes, mockIssuerRoutes: issuerRoutes, setBondCollection, setFallbackData } = require('./bond-directory/routes/mockLocalRoutes');

// ─── Startup: Validate Environment ────────────────────────────────────────────
const env = validateEnv();

const app = express();
const PORT = env.PORT;

// ─── Middleware Stack ─────────────────────────────────────────────────────────

app.use(requestId);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

app.use(compression());

app.use(cors({
    origin: env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map(s => s.trim())
        : '*',
    methods: ['GET', 'OPTIONS'],
    maxAge: 86400,
}));

app.use(express.json({ limit: '1mb' }));

app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' } },
}));

app.use(requestLogger);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
    const bondHealth = await bondDbHealth();
    res.json({
        status: 'OK',
        service: 'bond-directory',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        requestId: req.id,
        environment: env.NODE_ENV,
        db: {
            status: bondHealth.connected ? 'connected' : 'fallback-inmemory',
            latencyMs: bondHealth.latencyMs || null,
        },
        memory: {
            rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`,
            heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
        },
    });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/bonds', bondRoutes);
app.use('/api/issuers', issuerRoutes);

// ─── Centralized Error Handler (must be LAST) ─────────────────────────────────

app.use(errorHandler);

// ─── Initialize & Start ───────────────────────────────────────────────────────

let server;

(async () => {
    // 1. Connect Bond Directory MongoDB
    try {
        await connectBondDb();
        const col = getBondCollection();
        setBondCollection(col);
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', service: 'bond-directory', message: 'MongoDB connected' }));
    } catch (err) {
        console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARN', service: 'bond-directory', message: 'MongoDB unavailable — loading in-memory fallback', error: err.message }));
        try {
            const fs = require('fs');
            const path = require('path');
            const dataPath = path.join(__dirname, 'frontend_bonds_export.json');
            const raw = fs.readFileSync(dataPath, 'utf8');
            const data = JSON.parse(raw);
            setFallbackData(data);
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', service: 'bond-directory', message: `Fallback loaded: ${data.bonds.length} bonds, ${data.issuers.length} issuers` }));
        } catch (jsonErr) {
            console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', service: 'bond-directory', message: 'Fallback JSON load failed', error: jsonErr.message }));
        }
    }

    // 2. Start server
    server = app.listen(PORT, () => {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', service: 'server', message: `Bond Directory running on port ${PORT}`, environment: env.NODE_ENV }));
    });

    // 3. Graceful shutdown
    const shutdown = async signal => {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', service: 'server', message: `${signal} — shutting down` }));
        server.close(async () => {
            await closeBondDb();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
})();
