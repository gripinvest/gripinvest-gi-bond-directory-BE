/**
 * Request ID Middleware
 *
 * Assigns a unique UUID to every request for log correlation.
 * Exposes it in response headers as `X-Request-ID`.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

function requestId(req, res, next) {
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    next();
}

module.exports = { requestId };
