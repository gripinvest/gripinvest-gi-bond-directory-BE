/**
 * Structured Request Logger Middleware
 *
 * Logs every request/response as structured JSON for production
 * observability. Includes: method, path, status, duration, request ID.
 *
 * Log levels:
 *   - INFO: normal requests (< 500ms)
 *   - WARN: slow requests (500ms–2000ms)
 *   - ERROR: very slow requests (> 2000ms) or 5xx responses
 */

'use strict';

function requestLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;

        let level = 'INFO';
        if (status >= 500) level = 'ERROR';
        else if (duration > 2000) level = 'ERROR';
        else if (duration > 500) level = 'WARN';

        const log = {
            timestamp: new Date().toISOString(),
            level,
            service: 'bond-directory',
            requestId: req.id || null,
            method: req.method,
            path: req.originalUrl,
            status,
            durationMs: duration,
            ip: req.ip,
            userAgent: req.get('user-agent')?.substring(0, 100),
        };

        if (level === 'ERROR') {
            console.error(JSON.stringify(log));
        } else if (level === 'WARN') {
            console.warn(JSON.stringify(log));
        } else {
            // Only log non-health requests at INFO to reduce noise
            if (!req.originalUrl.includes('/health')) {
                console.log(JSON.stringify(log));
            }
        }
    });

    next();
}

module.exports = { requestLogger };
