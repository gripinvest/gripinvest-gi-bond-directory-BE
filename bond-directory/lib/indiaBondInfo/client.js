/**
 * IndiaBondInfo Public API Client (NSDL)
 * 
 * Production-grade client with:
 * - Rate limiting (1 req/sec with jitter)
 * - Exponential backoff on failures
 * - Circuit breaker integration
 * - Response validation
 * 
 * Base URL: https://www.indiabondinfo.nsdl.com/bds-service/v1/public/bdsinfo
 * Public endpoints only — no authentication bypass
 */

const axios = require('axios');
const { CircuitBreaker } = require('./circuitBreaker');

const BASE_URL = 'https://www.indiabondinfo.nsdl.com/bds-service/v1/public/bdsinfo';

class IndiaBondInfoClient {
    constructor(config = {}) {
        this.client = axios.create({
            baseURL: BASE_URL,
            timeout: config.timeout || 30000,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://www.indiabondinfo.nsdl.com/CBDServices/',
            },
        });

        // Rate limiting
        this.requestDelay = config.requestDelay || 1000;
        this.jitterMax = config.jitterMax || 500;
        this.lastRequestTime = 0;

        // Retry config
        this.maxRetries = config.maxRetries || 3;
        this.baseBackoffMs = config.baseBackoffMs || 2000;

        // Circuit breaker
        this.circuitBreaker = new CircuitBreaker({
            failureThreshold: config.failureThreshold || 5,
            resetTimeout: config.resetTimeout || 60000,
            onStateChange: ({ from, to }) => {
                console.log(`[IndiaBondInfo] Circuit breaker: ${from} → ${to}`);
            },
        });

        // Stats
        this.stats = { requests: 0, successes: 0, failures: 0, retries: 0 };
    }

    /**
     * Rate limiting with random jitter to avoid thundering herd
     */
    async _waitForRateLimit() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        const jitter = Math.floor(Math.random() * this.jitterMax);
        const totalDelay = this.requestDelay + jitter;

        if (elapsed < totalDelay) {
            const waitTime = totalDelay - elapsed;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Execute a request with retry + exponential backoff
     */
    async _requestWithRetry(endpoint, options = {}) {
        this.stats.requests++;

        const execute = async () => {
            let lastError;

            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    await this._waitForRateLimit();

                    const response = await this.client.get(endpoint, options);

                    // Validate response
                    if (response.status !== 200) {
                        throw new Error(`Unexpected status ${response.status}`);
                    }

                    this.stats.successes++;
                    return response.data;

                } catch (error) {
                    lastError = error;

                    // Don't retry on 404 — it's a valid "not found"
                    if (error.response?.status === 404) {
                        return null;
                    }

                    // Stop immediately on 403 (blocked)
                    if (error.response?.status === 403) {
                        console.error(`[IndiaBondInfo] ⛔ 403 Forbidden on ${endpoint} — stopping`);
                        this.stats.failures++;
                        throw error;
                    }

                    if (attempt < this.maxRetries) {
                        const backoff = this.baseBackoffMs * Math.pow(2, attempt);
                        const jitter = Math.floor(Math.random() * 1000);
                        const delay = backoff + jitter;

                        console.warn(`[IndiaBondInfo] Retry ${attempt + 1}/${this.maxRetries} for ${endpoint} in ${delay}ms — ${error.message}`);
                        this.stats.retries++;

                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            this.stats.failures++;
            throw lastError;
        };

        // Wrap in circuit breaker
        return this.circuitBreaker.execute(execute);
    }

    // ============ Public API Methods ============

    /**
     * 1. Issuance Dashboard — quarterly issuance data (array of quarter summaries)
     */
    async getIssuanceDashboard() {
        const data = await this._requestWithRetry('/issuancedashboard');
        console.log(`[IndiaBondInfo] Issuance dashboard: ${Array.isArray(data) ? data.length : 0} records`);
        return data || [];
    }

    /**
     * 2. Bonds Due for Redemption — bonds maturing today/soon
     * Returns: [{ isin, companyName, issueSize, allotmentDate, maturityDate }]
     */
    async getDueForRedemption() {
        const data = await this._requestWithRetry('/dueforredemption');
        console.log(`[IndiaBondInfo] Due for redemption: ${Array.isArray(data) ? data.length : 0} records`);
        return data || [];
    }

    /**
     * 3. New Bond Issues — recently allotted bonds
     * Returns: [{ isin, companyName, issueSize, allotmentDate, maturityDate }]
     */
    async getNewBondIssues() {
        const data = await this._requestWithRetry('/newbondissues');
        console.log(`[IndiaBondInfo] New bond issues: ${Array.isArray(data) ? data.length : 0} records`);
        return data || [];
    }

    /**
     * 4. Listed Securities — paginated list of all listed bonds
     * This is the key endpoint for comprehensive bond data.
     * Returns: [{ isin, companyName, issueSize, allotmentDate, maturityDate }]
     * @param {number} pageNo - Page number (1-based)
     * @param {number} pageSize - Records per page (max ~100)
     * @param {string} status - Filter: '' (all), 'Active', 'Matured'
     */
    async getListedSecurities(pageNo = 1, pageSize = 100, status = '') {
        const data = await this._requestWithRetry('/listedsecurities', {
            params: { pgno: pageNo, pgsize: pageSize, status },
        });
        console.log(`[IndiaBondInfo] Listed securities (pg ${pageNo}): ${Array.isArray(data) ? data.length : 0} records`);
        return data || [];
    }

    /**
     * 4a. Paginate through ALL listed securities
     * Automatically fetches all pages until empty response
     * @param {string} status - Filter: '' (all), 'Active', 'Matured'
     * @param {number} pageSize - Records per page
     */
    async getAllListedSecurities(status = '', pageSize = 100) {
        const allRecords = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const batch = await this.getListedSecurities(page, pageSize, status);

            if (!Array.isArray(batch) || batch.length === 0) {
                hasMore = false;
            } else {
                allRecords.push(...batch);
                console.log(`[IndiaBondInfo] Listed securities cumulative: ${allRecords.length} bonds (page ${page})`);

                if (batch.length < pageSize) {
                    hasMore = false; // Last page
                } else {
                    page++;
                }
            }
        }

        console.log(`[IndiaBondInfo] Total listed securities fetched: ${allRecords.length}`);
        return allRecords;
    }

    /**
     * 5. Outstanding Bonds Dashboard — aggregate stats
     * Returns: { currentQuarter, noOfIssues, issueAmount, noOfRedemptions,
     *           redemptionAmount, noOfTotalOutstandingBonds, totalOutstandingAmount,
     *           noOfListedSecurities, listedTotalIssueSize, noOfUnListedSecurities, unlistedTotalIssueSize }
     */
    async getOutstandingBondsDashboard() {
        const data = await this._requestWithRetry('/outstandingbondsinfo');
        console.log(`[IndiaBondInfo] Outstanding bonds dashboard: ${data ? 'received' : 'empty'}`);
        return data;
    }

    /**
     * 6. Current Year Issuance — year-to-date summary
     * Returns: { issueSize, quarter, noOfIsin, dataForYear }
     */
    async getCurrentIssuance() {
        const data = await this._requestWithRetry('/currentissuance');
        console.log(`[IndiaBondInfo] Current issuance: ${data ? data.noOfIsin + ' ISINs' : 'empty'}`);
        return data;
    }

    /**
     * 7. Previous Year Issuance — last year's summary  
     * Returns: { issueSize, quarter, noOfIsin, dataForYear }
     */
    async getPreviousIssuance() {
        const data = await this._requestWithRetry('/previousissuance');
        console.log(`[IndiaBondInfo] Previous issuance: ${data ? data.noOfIsin + ' ISINs' : 'empty'}`);
        return data;
    }

    /**
     * 8. Dropdown Metadata — filter options for advance search
     * @param {string} attrKey - Attribute key, e.g. 'INSTRTYP', 'OWNERTYP', etc.
     * Returns: [{ label, value }]
     */
    async getDropdownMetadata(attrKey) {
        const data = await this._requestWithRetry('/dropdown', {
            params: { attrkey: attrKey },
        });
        console.log(`[IndiaBondInfo] Dropdown (${attrKey}): ${Array.isArray(data) ? data.length : 0} options`);
        return data || [];
    }

    /**
     * @deprecated couponpayment endpoint returns 404 as of Feb 2026
     */
    async getCouponPayments() {
        console.warn('[IndiaBondInfo] ⚠️ couponpayment endpoint is deprecated (returns 404)');
        return [];
    }

    /**
     * @deprecated isindetails endpoint returns 404 as of Feb 2026
     */
    async getISINDetails(isin) {
        console.warn(`[IndiaBondInfo] ⚠️ isindetails endpoint is deprecated (returns 404) for ${isin}`);
        return null;
    }

    /**
     * Issuer Information
     */
    async getIssuers() {
        const data = await this._requestWithRetry('/issuer');
        console.log('[IndiaBondInfo] Fetched issuer data');
        return data || [];
    }

    /**
     * Rating Metadata
     */
    async getRatingMetadata() {
        const data = await this._requestWithRetry('/rating');
        console.log('[IndiaBondInfo] Fetched rating metadata');
        return data || [];
    }

    // ============ Utility ============

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
     * Test all endpoints — useful for health checks
     */
    async testAllEndpoints() {
        console.log('[IndiaBondInfo] Testing all public endpoints...\n');

        const tests = [
            { name: 'Issuance Dashboard', fn: () => this.getIssuanceDashboard() },
            { name: 'Due for Redemption', fn: () => this.getDueForRedemption() },
            { name: 'New Bond Issues', fn: () => this.getNewBondIssues() },
            { name: 'Listed Securities (pg1)', fn: () => this.getListedSecurities(1, 5) },
            { name: 'Outstanding Bonds Dashboard', fn: () => this.getOutstandingBondsDashboard() },
            { name: 'Current Issuance', fn: () => this.getCurrentIssuance() },
            { name: 'Previous Issuance', fn: () => this.getPreviousIssuance() },
            { name: 'Dropdown (INSTRTYP)', fn: () => this.getDropdownMetadata('INSTRTYP') },
            { name: 'Issuers', fn: () => this.getIssuers() },
            { name: 'Rating Metadata', fn: () => this.getRatingMetadata() },
        ];

        const results = {};

        for (const test of tests) {
            try {
                console.log(`Testing: ${test.name}...`);
                const data = await test.fn();
                results[test.name] = {
                    success: true,
                    count: Array.isArray(data) ? data.length : (data ? 1 : 0),
                    sample: Array.isArray(data) ? data[0] : data,
                };
                console.log(`✅ ${test.name}: ${results[test.name].count} records\n`);
            } catch (error) {
                results[test.name] = {
                    success: false,
                    error: error.message,
                };
                console.log(`❌ ${test.name}: ${error.message}\n`);
            }
        }

        return results;
    }
}

// Export singleton instance
const indiaBondInfoClient = new IndiaBondInfoClient({
    requestDelay: 1000,
    jitterMax: 500,
    maxRetries: 3,
    baseBackoffMs: 2000,
    failureThreshold: 5,
    resetTimeout: 60000,
});

module.exports = {
    IndiaBondInfoClient,
    indiaBondInfoClient,
};
