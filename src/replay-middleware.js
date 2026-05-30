const { FAILOVER } = require('./config');
const { S3_OPS } = require('./s3-parser');

const READ_OPS = new Set([
  S3_OPS.LIST_BUCKETS,
  S3_OPS.HEAD_BUCKET,
  S3_OPS.LIST_OBJECTS_V2,
  S3_OPS.GET_OBJECT,
  S3_OPS.HEAD_OBJECT,
]);

const WRITE_OPS = new Set([
  S3_OPS.CREATE_BUCKET,
  S3_OPS.DELETE_BUCKET,
  S3_OPS.PUT_OBJECT,
  S3_OPS.DELETE_OBJECT,
  S3_OPS.COPY_OBJECT,
  S3_OPS.MULTI_DELETE,
]);

class ReplayMiddleware {
  constructor(policyRouter, healthChecker) {
    this.policyRouter = policyRouter;
    this.healthChecker = healthChecker;
    this.stats = {
      totalRequests: 0,
      failoverRequests: 0,
      failedRequests: 0,
      backendStats: {},
    };
  }

  isRetryableError(error) {
    if (!error) return false;

    const statusCode = error.$metadata?.httpStatusCode || error.statusCode || error.status;
    if (statusCode && FAILOVER.retryableStatusCodes.includes(statusCode)) {
      return true;
    }

    const retryableMessages = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ServiceUnavailable',
      'InternalError',
      'SlowDown',
    ];

    const msg = error.message || error.Code || '';
    return retryableMessages.some((m) => msg.includes(m));
  }

  isIdempotent(operation) {
    if (READ_OPS.has(operation)) return true;
    if (operation === S3_OPS.DELETE_OBJECT) return true;
    if (operation === S3_OPS.MULTI_DELETE) return true;
    if (operation === S3_OPS.DELETE_BUCKET) return true;
    return false;
  }

  canRetry(operation) {
    return this.isIdempotent(operation) || READ_OPS.has(operation);
  }

  async executeWithFailover(parsedReq, executeFn) {
    const { operation, bucket } = parsedReq;
    this.stats.totalRequests++;

    const backendOrder = this.policyRouter.resolveBackendOrder(bucket);
    if (backendOrder.length === 0) {
      this.stats.failedRequests++;
      const err = new Error('No healthy backends available');
      err.statusCode = 503;
      throw err;
    }

    if (WRITE_OPS.has(operation) && !this.isIdempotent(operation)) {
      const backend = backendOrder[0];
      try {
        const result = await executeFn(backend);
        this.recordBackendSuccess(backend.name);
        return result;
      } catch (err) {
        this.recordBackendFailure(backend.name, err);
        if (this.isRetryableError(err)) {
          this.healthChecker.markUnhealthy(backend.name, err.message);
        }
        this.stats.failedRequests++;
        throw err;
      }
    }

    const maxAttempts = Math.min(FAILOVER.maxRetries + 1, backendOrder.length);
    const attempted = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backend = backendOrder[attempt];
      if (!backend) break;

      attempted.push(backend.name);

      try {
        const result = await executeFn(backend);

        if (attempt > 0) {
          this.stats.failoverRequests++;
          this.healthChecker.markHealthy(backend.name);
        }

        this.recordBackendSuccess(backend.name);
        return result;
      } catch (err) {
        this.recordBackendFailure(backend.name, err);

        if (this.isRetryableError(err)) {
          this.healthChecker.markUnhealthy(backend.name, err.message);

          if (attempt < maxAttempts - 1) {
            const delay = FAILOVER.retryDelayMs * (attempt + 1);
            await sleep(delay);
            continue;
          }
        }

        if (attempt < maxAttempts - 1 && backendOrder[attempt + 1]) {
          continue;
        }

        this.stats.failedRequests++;
        throw err;
      }
    }

    this.stats.failedRequests++;
    const err = new Error('All backends failed');
    err.statusCode = 502;
    err.attemptedBackends = attempted;
    throw err;
  }

  recordBackendSuccess(name) {
    if (!this.stats.backendStats[name]) {
      this.stats.backendStats[name] = { successes: 0, failures: 0 };
    }
    this.stats.backendStats[name].successes++;
  }

  recordBackendFailure(name, error) {
    if (!this.stats.backendStats[name]) {
      this.stats.backendStats[name] = { successes: 0, failures: 0 };
    }
    this.stats.backendStats[name].failures++;
  }

  getStats() {
    return {
      ...this.stats,
      healthStatus: this.healthChecker.getAllStatus(),
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = ReplayMiddleware;
