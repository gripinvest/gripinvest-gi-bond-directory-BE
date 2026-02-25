/**
 * Circuit Breaker Pattern
 * 
 * Protects upstream API from cascading failures.
 * States: CLOSED (normal) → OPEN (failing, reject all) → HALF_OPEN (testing recovery)
 * 
 * Usage:
 *   const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 60000 });
 *   const result = await breaker.execute(() => apiClient.getData());
 */

const STATES = {
    CLOSED: 'CLOSED',       // Normal operation
    OPEN: 'OPEN',           // Rejecting requests (upstream is down)
    HALF_OPEN: 'HALF_OPEN'  // Testing if upstream recovered
};

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeout = options.resetTimeout || 60000; // 1 minute
        this.monitorWindow = options.monitorWindow || 300000; // 5 minutes

        this.state = STATES.CLOSED;
        this.failures = 0;
        this.lastFailureTime = null;
        this.nextRetryTime = null;
        this.successCount = 0;
        this.totalRequests = 0;

        // Listeners
        this.onStateChange = options.onStateChange || (() => { });
    }

    /**
     * Execute a function through the circuit breaker
     * @param {Function} fn - Async function to execute
     * @param {Function} fallback - Optional fallback if circuit is open
     */
    async execute(fn, fallback) {
        this.totalRequests++;

        if (this.state === STATES.OPEN) {
            // Check if we should transition to HALF_OPEN
            if (Date.now() >= this.nextRetryTime) {
                this._transition(STATES.HALF_OPEN);
            } else {
                console.log(`[CircuitBreaker] OPEN — rejecting request (retry in ${Math.ceil((this.nextRetryTime - Date.now()) / 1000)}s)`);
                if (fallback) return fallback();
                throw new CircuitBreakerError('Circuit breaker is OPEN — upstream API unavailable');
            }
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure(error);
            if (fallback && this.state === STATES.OPEN) {
                return fallback();
            }
            throw error;
        }
    }

    _onSuccess() {
        this.successCount++;

        if (this.state === STATES.HALF_OPEN) {
            // Successful test request — close the circuit
            this._transition(STATES.CLOSED);
            this.failures = 0;
        }
    }

    _onFailure(error) {
        this.failures++;
        this.lastFailureTime = Date.now();

        console.warn(`[CircuitBreaker] Failure #${this.failures}: ${error.message}`);

        if (this.state === STATES.HALF_OPEN) {
            // Test request failed — re-open
            this._transition(STATES.OPEN);
            this.nextRetryTime = Date.now() + this.resetTimeout;
        } else if (this.state === STATES.CLOSED && this.failures >= this.failureThreshold) {
            // Threshold exceeded — trip the breaker
            this._transition(STATES.OPEN);
            this.nextRetryTime = Date.now() + this.resetTimeout;
        }
    }

    _transition(newState) {
        if (this.state !== newState) {
            const oldState = this.state;
            this.state = newState;
            console.log(`[CircuitBreaker] State: ${oldState} → ${newState}`);
            this.onStateChange({ from: oldState, to: newState, failures: this.failures });
        }
    }

    getStatus() {
        return {
            state: this.state,
            failures: this.failures,
            totalRequests: this.totalRequests,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            nextRetryTime: this.nextRetryTime
        };
    }

    reset() {
        this.state = STATES.CLOSED;
        this.failures = 0;
        this.lastFailureTime = null;
        this.nextRetryTime = null;
    }
}

class CircuitBreakerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CircuitBreakerError';
        this.isCircuitBreakerError = true;
    }
}

module.exports = { CircuitBreaker, CircuitBreakerError, STATES };
