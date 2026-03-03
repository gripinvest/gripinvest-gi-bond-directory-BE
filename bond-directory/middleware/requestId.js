/**
 * Request ID Middleware
 *
 * Assigns a unique UUID to every request for log correlation.
 * Exposes it in response headers as `X-Request-ID`.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

function requestId(req, res, next) {
    const clientId = req.headers['x-request-id'];
    if (clientId) {
        // Strip control characters (U+0000–U+001F, U+007F) and cap at 64 chars to prevent log injection
        // eslint-disable-next-line no-control-regex -- intentional: sanitizing untrusted header input
        const sanitized = String(clientId).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
        req.id = sanitized || uuidv4();
    } else {
        req.id = uuidv4();
    }
    res.setHeader('X-Request-ID', req.id);
    next();
}

module.exports = { requestId };
