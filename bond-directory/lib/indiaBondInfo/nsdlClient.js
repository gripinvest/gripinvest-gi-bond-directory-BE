/**
 * NSDL IndiaBondInfo API Client
 *
 * Calls the 7 confirmed working NSDL public endpoints:
 *   1. /issuertypewise
 *   2. /creditratingwise
 *   3. /interestratewise
 *   4. /restructuredisins
 *   5. /listofsecurities?type=Active
 *   6. /listofsecurities?type=Matured
 *   7. /issuerwise
 *
 * Session cookies (NL01dfc552, NL1e619be7027) are read from env vars
 * and should be rotated every few weeks when they expire.
 *
 * Production-grade: rate limiting, exponential backoff, circuit breaker.
 */

const axios = require('axios');
const { CircuitBreaker } = require('./circuitBreaker');

const BASE_URL = 'https://www.indiabondinfo.nsdl.com/bds-service/v1/public/bdsinfo';

/**
 * Build the Cookie header string from environment variables.
 * Falls back to the sample values from the user-provided cURLs if env vars not set.
 */
function buildCookieHeader() {
    const nl01 = process.env.NSDL_COOKIE_NL01 || '';
    const nl1e = process.env.NSDL_COOKIE_NL1E || '';

    if (!nl01 || !nl1e) {
        console.warn('[NSDL Client] ⚠️  Session cookies not set in env (NSDL_COOKIE_NL01, NSDL_COOKIE_NL1E). Requests may fail with 403.');
        return '';
    }

    return `NL01dfc552=${nl01}; NL1e619be7027=${nl1e}`;
}

class NSDLBondClient {
    constructor(config = {}) {
        this.baseURL = BASE_URL;
        this.timeout = config.timeout || 45000;

        // Rate limiting
        this.requestDelay = config.requestDelay || 1200;  // 1.2s between requests
        this.jitterMax = config.jitterMax || 600;
        this.lastRequestTime = 0;

        // Retry config
        this.maxRetries = config.maxRetries || 3;
        this.baseBackoffMs = config.baseBackoffMs || 2500;

        // Circuit breaker
        this.circuitBreaker = new CircuitBreaker({
            failureThreshold: config.failureThreshold || 4,
            resetTimeout: config.resetTimeout || 90000,
            onStateChange: ({ from, to }) => {
                console.log(`[NSDL Client] Circuit breaker: ${from} → ${to}`);
            },
        });

        // Stats
        this.stats = { requests: 0, successes: 0, failures: 0, retries: 0 };
    }

    /**
     * Build fresh axios instance with current cookies on every call.
     * This allows cookie rotation without restarting the server.
     */
    _buildClient() {
        return axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                ...this._getHeaders(),
                'Cookie': buildCookieHeader(),
            },
        });
    }

    _getHeaders() {
        return {
            'Accept': '*/*',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Disposition': 'attachment; filename=SailBig.tiff',
            'Content-Type': 'application/json; charset=utf-8',
            'Pragma': 'no-cache',
            'Referer': 'https://www.indiabondinfo.nsdl.com/CBDServices/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
        };
    }

    async refreshCookies() {
        console.log('[NSDL Client] Fetching fresh cookies via Puppeteer directly...');
        try {
            const path = require('path');
            const scriptPath = path.join(__dirname, '../../scripts/nsdlAutoLogin.js');
            const { getNSDLCookies } = require(scriptPath);
            const freshCookies = await getNSDLCookies();
            process.env.NSDL_COOKIE_NL01 = freshCookies.NSDL_COOKIE_NL01;
            process.env.NSDL_COOKIE_NL1E = freshCookies.NSDL_COOKIE_NL1E;
            console.log('[NSDL Client] ✅ Cookies refreshed in memory.');
            return true;
        } catch (error) {
            console.error('[NSDL Client] ❌ Failed to auto-login via Puppeteer:', error.message);
            return false;
        }
    }

    // ─── Rate Limiting ───────────────────────────────────────────────────────

    async _waitForRateLimit() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        const jitter = Math.floor(Math.random() * this.jitterMax);
        const totalDelay = this.requestDelay + jitter;

        if (elapsed < totalDelay) {
            await new Promise(resolve => setTimeout(resolve, totalDelay - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    // ─── Request with Retry ──────────────────────────────────────────────────

    async _request(endpoint, params = {}) {
        this.stats.requests++;

        const execute = async () => {
            let lastError;

            // Check cookies before starting
            if (!process.env.NSDL_COOKIE_NL01 || !process.env.NSDL_COOKIE_NL1E) {
                console.log('[NSDL Client] No session cookies found in env. Running Puppeteer login...');
                await this.refreshCookies();
            }

            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    await this._waitForRateLimit();

                    // Always try to fetch
                    const client = this._buildClient();
                    const response = await client.get(endpoint, { params });

                    if (response.status !== 200) {
                        throw new Error(`Unexpected status ${response.status}`);
                    }

                    // Sometimes NSDL returns HTML error page with 200 OK (session expired secretly)
                    if (typeof response.data === 'string' && response.data.includes('<html')) {
                        throw Object.assign(new Error('HTML received instead of JSON. Session likely expired.'), { isHtmlSessionError: true });
                    }

                    this.stats.successes++;

                    // NSDL can return data as array or wrapped object
                    const data = response.data;
                    console.log(`[NSDL Client] DEBUG Response Type: ${typeof data}`);

                    if (typeof data === 'string') {
                        console.log(`[NSDL Client] DEBUG String content:\n${data.substring(0, 500)}...`);
                    }

                    if (data && typeof data === 'object' && !Array.isArray(data)) {
                        console.log(`[NSDL Client] DEBUG Response Keys: ${Object.keys(data).join(', ')}`);
                    }

                    if (Array.isArray(data)) return data;
                    if (data && Array.isArray(data.data)) return data.data;
                    if (data && Array.isArray(data.result)) return data.result;
                    if (data && Array.isArray(data.content)) return data.content; // Added for public api similarity

                    console.error('[NSDL Client] ERROR: Could not parse response into array format.');
                    return data || [];

                } catch (error) {
                    lastError = error;

                    // Hard stop on 403 — session expired OR hidden html session expire
                    if (error.response?.status === 403 || error.isHtmlSessionError) {
                        console.error(`[NSDL Client] ⛔ 403 on ${endpoint} — session cookies expired. Trying to fetch new cookies with Puppeteer.`);
                        const refreshed = await this.refreshCookies();

                        if (refreshed) {
                            console.log(`[NSDL Client] Retrying ${endpoint} after successful cookie refresh...`);
                            continue; // Try again immediately in the loop with the new cookies
                        } else {
                            this.stats.failures++;
                            throw new Error(`NSDL_SESSION_EXPIRED: ${endpoint}`);
                        }
                    }

                    if (error.response?.status === 404) return [];

                    if (attempt < this.maxRetries) {
                        const backoff = this.baseBackoffMs * Math.pow(2, attempt);
                        const delay = backoff + Math.floor(Math.random() * 1000);
                        console.warn(`[NSDL Client] Retry ${attempt + 1}/${this.maxRetries} for ${endpoint} in ${delay}ms — ${error.message}`);
                        this.stats.retries++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            this.stats.failures++;
            throw lastError;
        };

        return this.circuitBreaker.execute(execute);
    }

    // ─── Request with Retry (Excel) ──────────────────────────────────────────

    async _requestExcel(endpoint, params = {}) {
        this.stats.requests++;
        const xlsx = require('xlsx');

        const execute = async () => {
            let lastError;

            if (!process.env.NSDL_COOKIE_NL01 || !process.env.NSDL_COOKIE_NL1E) {
                console.log('[NSDL Client] No session cookies found in env. Running Puppeteer login...');
                await this.refreshCookies();
            }

            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    await this._waitForRateLimit();

                    const client = this._buildClient();
                    // Crucial: Set responseType to arraybuffer for binary Excel files
                    const response = await client.get(endpoint, { params, responseType: 'arraybuffer' });

                    if (response.status !== 200) {
                        throw new Error(`Unexpected status ${response.status}`);
                    }

                    // Check if the response is actually an HTML error page despite the 200 OK
                    const dataStr = response.data.toString('utf8');
                    if (dataStr.includes('<html')) {
                        throw Object.assign(new Error('HTML received instead of Excel. Session likely expired.'), { isHtmlSessionError: true });
                    }

                    this.stats.successes++;

                    // Parse the Excel buffer into JSON
                    const workbook = xlsx.read(response.data, { type: 'buffer' });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    const json = xlsx.utils.sheet_to_json(sheet);

                    return json;

                } catch (error) {
                    lastError = error;

                    if (error.response?.status === 403 || error.isHtmlSessionError) {
                        console.error(`[NSDL Client] ⛔ 403 or HTML on ${endpoint} (Excel) — session cookies expired. Fetching fresh cookies...`);
                        const refreshed = await this.refreshCookies();

                        if (refreshed) {
                            console.log(`[NSDL Client] Retrying Excel ${endpoint} after successful cookie refresh...`);
                            continue;
                        } else {
                            this.stats.failures++;
                            throw new Error(`NSDL_SESSION_EXPIRED (Excel): ${endpoint}`);
                        }
                    }

                    if (error.response?.status === 404) return [];

                    if (attempt < this.maxRetries) {
                        const backoff = this.baseBackoffMs * Math.pow(2, attempt);
                        const delay = backoff + Math.floor(Math.random() * 1000);
                        console.warn(`[NSDL Client] Retry Excel ${attempt + 1}/${this.maxRetries} for ${endpoint} in ${delay}ms — ${error.message}`);
                        this.stats.retries++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            this.stats.failures++;
            throw lastError;
        };

        return this.circuitBreaker.execute(execute);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Public API Methods (7 confirmed working endpoints)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 1. Issuer Type-Wise data
     * Returns breakdown of bonds grouped by issuer category (Corporate, PSU, Govt etc.)
     */
    async getIssuerTypeWise() {
        const data = await this._requestExcel('/issuertypewise');
        console.log(`[NSDL Client] /issuertypewise (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} records`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 2. Credit Rating-Wise data
     * Returns ISINs grouped by credit rating (AAA, AA+, AA, A, BBB etc.)
     */
    async getCreditRatingWise() {
        const data = await this._requestExcel('/creditratingwise');
        console.log(`[NSDL Client] /creditratingwise (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} records`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 3. Interest Rate-Wise data
     * Returns bonds grouped by interest rate range buckets
     */
    async getInterestRateWise() {
        const data = await this._requestExcel('/interestratewise');
        console.log(`[NSDL Client] /interestratewise (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} records`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 4. Restructured ISINs
     * Returns ISINs flagged as restructured bonds
     */
    async getRestructuredIsins() {
        const data = await this._requestExcel('/restructuredisins');
        console.log(`[NSDL Client] /restructuredisins (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} records`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 5. List of Securities — Active
     * Primary source of all currently active bonds (Downloads as Excel binary)
     */
    async getActiveBonds() {
        const data = await this._requestExcel('/listofsecurities', { type: 'Active' });
        console.log(`[NSDL Client] /listofsecurities?type=Active (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} rows parsed`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 6. List of Securities — Matured
     * Returns all bonds that have reached maturity (Downloads as Excel binary)
     */
    async getMaturedBonds() {
        const data = await this._requestExcel('/listofsecurities', { type: 'Matured' });
        console.log(`[NSDL Client] /listofsecurities?type=Matured (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} rows parsed`);
        return Array.isArray(data) ? data : [];
    }

    /**
     * 7. Issuer-Wise data
     * Returns issuer-level bond breakdowns
     */
    async getIssuerWise() {
        const data = await this._requestExcel('/issuerwise');
        console.log(`[NSDL Client] /issuerwise (Excel) → ${Array.isArray(data) ? data.length : 'N/A'} records`);
        return Array.isArray(data) ? data : [];
    }

    // ─── Utils ───────────────────────────────────────────────────────────────

    getStats() {
        return {
            ...this.stats,
            circuitBreaker: this.circuitBreaker.getStatus(),
        };
    }

    resetStats() {
        this.stats = { requests: 0, successes: 0, failures: 0, retries: 0 };
        this.circuitBreaker.reset();
    }

    /**
     * Health check — pings /issuertypewise and returns connectivity status
     */
    async testConnection() {
        try {
            const data = await this.getIssuerTypeWise();
            return { ok: true, recordCount: data.length };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }
}

// Singleton
const nsdlClient = new NSDLBondClient({
    requestDelay: 1200,
    jitterMax: 600,
    maxRetries: 3,
    baseBackoffMs: 2500,
    failureThreshold: 4,
    resetTimeout: 90000,
});

module.exports = { NSDLBondClient, nsdlClient };
