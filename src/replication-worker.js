const { CRR, BACKENDS } = require('./config');
const { REPLICATION_STATUS } = require('./crr-store');
const { getOrCreateAdapter } = require('./backend-adapter');

class ReplicationWorker {
  constructor(rulesEngine, store, healthChecker) {
    this.rulesEngine = rulesEngine;
    this.store = store;
    this.healthChecker = healthChecker;
    this.intervalId = null;
    this.activeJobs = new Set();
    this.isRunning = false;
    this.listeners = [];
  }

  start() {
    if (!CRR.enabled || this.intervalId) return;
    this.isRunning = true;
    this._runLoop();
    this.intervalId = setInterval(() => this._runLoop(), CRR.workerIntervalMs);
    console.log('[CRR Worker] Started replication worker');
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[CRR Worker] Stopped replication worker');
  }

  onReplicationComplete(listener) {
    this.listeners.push(listener);
  }

  emitReplicationComplete(job) {
    for (const listener of this.listeners) {
      try {
        listener(job);
      } catch {}
    }
  }

  async _runLoop() {
    if (!this.isRunning) return;

    const concurrentLimit = CRR.maxConcurrent;
    const availableSlots = concurrentLimit - this.activeJobs.size;
    if (availableSlots <= 0) return;

    const pendingJobs = this.store.getPendingJobs(availableSlots * 2);
    const toProcess = pendingJobs.filter((j) => !this.activeJobs.has(j.id)).slice(0, availableSlots);

    for (const job of toProcess) {
      this._processJob(job);
    }
  }

  async _processJob(job) {
    if (!this.isRunning) return;

    this.activeJobs.add(job.id);

    try {
      this.store.updateJob(job.id, { status: REPLICATION_STATUS.IN_PROGRESS });

      const destBackend = BACKENDS[job.destinationBackend];
      if (!destBackend) {
        throw new Error(`Destination backend not found: ${job.destinationBackend}`);
      }

      if (this.healthChecker && !this.healthChecker.isHealthy(job.destinationBackend)) {
        throw new Error(`Destination backend unhealthy: ${job.destinationBackend}`);
      }

      const sourceAdapter = getOrCreateAdapter(BACKENDS[job.sourceBackend]);
      const destAdapter = getOrCreateAdapter(destBackend);

      const sourceResult = await sourceAdapter.execute('GET_OBJECT', {
        bucket: job.sourceBucket,
        key: job.sourceKey,
      });

      await destAdapter.execute('PUT_OBJECT', {
        bucket: job.destinationBucket,
        key: job.destinationKey,
        body: sourceResult.body,
        contentType: sourceResult.contentType,
        metadata: sourceResult.metadata,
      });

      const finalJob = this.store.updateJob(job.id, {
        status: REPLICATION_STATUS.COMPLETED,
        completedAt: new Date().toISOString(),
        etag: sourceResult.etag,
        size: sourceResult.contentLength,
      });

      this.emitReplicationComplete(finalJob);
      console.log(`[CRR Worker] Replication complete: ${job.sourceBucket}/${job.sourceKey} -> ${job.destinationBackend}:${job.destinationBucket}/${job.destinationKey}`);
    } catch (err) {
      const newRetryCount = (job.retryCount || 0) + 1;
      const maxRetries = CRR.maxRetries;

      if (newRetryCount >= maxRetries) {
        this.store.updateJob(job.id, {
          status: REPLICATION_STATUS.FAILED,
          retryCount: newRetryCount,
          error: err.message,
          failedAt: new Date().toISOString(),
        });
        console.error(`[CRR Worker] Replication failed (max retries): ${job.sourceBucket}/${job.sourceKey}: ${err.message}`);
      } else {
        this.store.updateJob(job.id, {
          status: REPLICATION_STATUS.PENDING,
          retryCount: newRetryCount,
          lastError: err.message,
        });
        console.warn(`[CRR Worker] Replication retry ${newRetryCount}/${maxRetries}: ${job.sourceBucket}/${job.sourceKey}: ${err.message}`);
      }
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  queueReplication(sourceBucket, sourceKey, sourceBackendName, etag) {
    if (!CRR.enabled) return [];

    const destinations = this.rulesEngine.getReplicationDestinations(sourceBucket, sourceKey);
    const jobs = [];

    for (const dest of destinations) {
      const job = this.store.createJob({
        ruleId: dest.ruleId,
        sourceBucket,
        sourceKey,
        sourceBackend: sourceBackendName,
        destinationBackend: dest.backend,
        destinationBucket: dest.bucket,
        destinationKey: dest.key,
        sourceEtag: etag,
        priority: dest.priority,
      });
      jobs.push(job);
      console.log(`[CRR Worker] Queued replication: ${sourceBucket}/${sourceKey} -> ${dest.backend}:${dest.bucket}/${dest.key} (job: ${job.id})`);
    }

    return jobs;
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      activeJobs: this.activeJobs.size,
      storeStats: this.store.getStats(),
      rulesStats: this.rulesEngine.getStats(),
    };
  }
}

module.exports = ReplicationWorker;
