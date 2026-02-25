const axios = require('axios');

/**
 * IndiaBondInfo Public API Client
 * 
 * Uses public endpoints (no authentication required)
 * Base URL: https://www.indiabondinfo.nsdl.com/bds-service/v1/public
 * 
 * NOTE: This is a scraping approach and may be rate-limited or blocked.
 * Use responsibly with delays between requests.
 */

const BASE_URL = 'https://www.indiabondinfo.nsdl.com/bds-service/v1/public';

class IndiaBondInfoPublicClient {
    constructor(config = {}) {
        this.client = axios.create({
            baseURL: BASE_URL,
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        this.requestDelay = config.requestDelay || 1000; // 1 second between requests
        this.lastRequestTime = 0;
    }

    /**
     * Rate limiting: ensure minimum delay between requests
     */
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.requestDelay) {
            const waitTime = this.requestDelay - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Fetch bond list with pagination
     * @param {number} page - Page number (1-indexed)
     * @param {number} limit - Records per page
     * @returns {Promise<Object>} Bond list response
     */
    async getBonds(page = 1, limit = 100) {
        await this.waitForRateLimit();

        try {
            const response = await this.client.get('/bond-list', {
                params: {
                    page: page - 1, // API might be 0-indexed
                    size: limit,
                    sort: 'isin,asc'
                }
            });

            console.log(`[IndiaBondInfo] Fetched page ${page}, ${response.data.content?.length || 0} bonds`);
            return response.data;
        } catch (error) {
            console.error(`[IndiaBondInfo] Error fetching bonds:`, error.message);
            throw error;
        }
    }

    /**
     * Fetch single bond by ISIN
     * @param {string} isin - Bond ISIN
     * @returns {Promise<Object>} Bond details
     */
    async getBondByISIN(isin) {
        await this.waitForRateLimit();

        try {
            const response = await this.client.get(`/bond/${isin}`);
            console.log(`[IndiaBondInfo] Fetched bond ${isin}`);
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                console.log(`[IndiaBondInfo] Bond ${isin} not found`);
                return null;
            }
            console.error(`[IndiaBondInfo] Error fetching bond ${isin}:`, error.message);
            throw error;
        }
    }

    /**
     * Search bonds by issuer name or ISIN
     * @param {string} query - Search query
     * @returns {Promise<Object>} Search results
     */
    async searchBonds(query) {
        await this.waitForRateLimit();

        try {
            const response = await this.client.get('/search', {
                params: { q: query }
            });
            console.log(`[IndiaBondInfo] Search "${query}" returned ${response.data.length || 0} results`);
            return response.data;
        } catch (error) {
            console.error(`[IndiaBondInfo] Error searching bonds:`, error.message);
            throw error;
        }
    }

    /**
     * Test API connectivity
     * @returns {Promise<boolean>} True if API is accessible
     */
    async testConnection() {
        try {
            console.log('[IndiaBondInfo] Testing connection to public API...');
            const result = await this.getBonds(1, 10);
            console.log('[IndiaBondInfo] ✅ Connection successful');
            return true;
        } catch (error) {
            console.error('[IndiaBondInfo] ❌ Connection failed:', error.message);
            return false;
        }
    }
}

// Export singleton instance
const indiaBondInfoClient = new IndiaBondInfoPublicClient({
    requestDelay: 1000 // 1 second between requests (be respectful)
});

module.exports = {
    IndiaBondInfoPublicClient,
    indiaBondInfoClient
};
