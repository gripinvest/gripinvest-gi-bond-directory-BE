/**
 * Centralized Error Handler Middleware
 *
 * Catches all unhandled errors from route handlers and sends a
 * standardized JSON response. Logs the full stack trace in
 * non-production environments.
 *
 * Usage (in index.js — must be the LAST app.use()):
 *   app.use(errorHandler);
 */

'use strict';

class AppError extends Error {
    /**
     * @param {string} message — user-facing message
     * @param {number} statusCode — HTTP status (400, 404, 500, …)
     * @param {string} [code] — machine-readable error code (e.g. 'BOND_NOT_FOUND')
     */
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true; // distinguish from programmer errors
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Express error-handling middleware (4-arg signature).
 */
function errorHandler(err, req, res, _next) {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = err.isOperational ? err.message : 'An unexpected error occurred';

    // Log full error in development
    if (process.env.NODE_ENV !== 'production') {
        console.error(`[ERROR] ${req.method} ${req.originalUrl}`, {
            statusCode,
            code,
            message: err.message,
            stack: err.stack,
            requestId: req.id,
        });
    } else {
        // In production, only log unexpected errors with stack
        if (!err.isOperational) {
            console.error('[FATAL] Unexpected error:', {
                statusCode,
                message: err.message,
                stack: err.stack,
                requestId: req.id,
                url: req.originalUrl,
            });
        }
    }

    res.status(statusCode).json({
        success: false,
        error: {
            code,
            message,
            ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        },
        requestId: req.id || null,
    });
}

/**
 * Wrap an async route handler to forward errors to errorHandler.
 * Usage:
 *   router.get('/bonds', asyncHandler(async (req, res) => { ... }));
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = { AppError, errorHandler, asyncHandler };
