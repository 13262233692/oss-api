const { BACKENDS, HEALTH_CHECK } = require('./config');
const { getOrCreateAdapter } = require('./backend-adapter');

class HealthChecker {
  constructor() {
    this.status = {};
    this.intervalId = null;
    this.listeners = [];

    for (const name of Object.keys(BACKENDS)) {
      this.status[name] = {
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastCheck: null,
        lastError: null,
        latencyMs: 0,
      };
    }
  }

  start() {
    if (!HEALTH_CHECK.enabled) return;
    this.runCheck();
    this.intervalId = setInterval(() => this.runCheck(), HEALTH_CHECK.intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onStatusChange(listener) {
    this.listeners.push(listener);
  }

  emitStatusChange(name, wasHealthy, isHealthy) {
    for (const listener of this.listeners) {
      try {
        listener(name, wasHealthy, isHealthy);
      } catch {}
    }
  }

  async runCheck() {
    const checks = Object.entries(BACKENDS).map(async ([name, config]) => {
      const adapter = getOrCreateAdapter(config);
      const start = Date.now();
      try {
        const result = await Promise.race([
          adapter.checkHealth(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK.timeoutMs)
          ),
        ]);
        const latency = Date.now() - start;
        this.updateStatus(name, result.healthy, latency, null);
      } catch (err) {
        const latency = Date.now() - start;
        this.updateStatus(name, false, latency, err.message);
      }
    });

    await Promise.allSettled(checks);
  }

  updateStatus(name, isHealthy, latencyMs, error) {
    const prev = this.status[name];
    if (!prev) return;

    const wasHealthy = prev.healthy;

    prev.lastCheck = new Date().toISOString();
    prev.latencyMs = latencyMs;
    prev.lastError = error || null;

    if (isHealthy) {
      prev.consecutiveSuccesses++;
      prev.consecutiveFailures = 0;
      if (prev.consecutiveSuccesses >= HEALTH_CHECK.healthyThreshold) {
        prev.healthy = true;
      }
    } else {
      prev.consecutiveFailures++;
      prev.consecutiveSuccesses = 0;
      if (prev.consecutiveFailures >= HEALTH_CHECK.unhealthyThreshold) {
        prev.healthy = false;
      }
    }

    if (wasHealthy !== prev.healthy) {
      this.emitStatusChange(name, wasHealthy, prev.healthy);
    }
  }

  isHealthy(name) {
    const status = this.status[name];
    if (!status) return false;
    return status.healthy;
  }

  getStatus(name) {
    return this.status[name] || null;
  }

  getAllStatus() {
    return { ...this.status };
  }

  markUnhealthy(name, error) {
    const prev = this.status[name];
    if (!prev) return;
    const wasHealthy = prev.healthy;
    prev.healthy = false;
    prev.lastError = error || 'marked unhealthy by request failure';
    prev.lastCheck = new Date().toISOString();
    prev.consecutiveFailures = HEALTH_CHECK.unhealthyThreshold;
    prev.consecutiveSuccesses = 0;
    if (wasHealthy) {
      this.emitStatusChange(name, true, false);
    }
  }

  markHealthy(name) {
    const prev = this.status[name];
    if (!prev) return;
    const wasHealthy = prev.healthy;
    prev.healthy = true;
    prev.lastError = null;
    prev.consecutiveSuccesses = HEALTH_CHECK.healthyThreshold;
    prev.consecutiveFailures = 0;
    if (!wasHealthy) {
      this.emitStatusChange(name, false, true);
    }
  }
}

module.exports = HealthChecker;
