const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const REPLICATION_STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

class ReplicationStore {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.dataDir = path.dirname(config.storage.path);
    this.dbPath = config.storage.path;
    this._ensureDataDir();
    this._loadFromDisk();
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
        for (const job of data.jobs || []) {
          this.jobs.set(job.id, job);
        }
      }
    } catch (err) {
      console.warn('[CRR Store] Failed to load from disk, starting fresh:', err.message);
    }
  }

  _persistToDisk() {
    try {
      const data = {
        jobs: Array.from(this.jobs.values()),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[CRR Store] Failed to persist to disk:', err.message);
    }
  }

  createJob(jobData) {
    const job = {
      id: uuidv4(),
      status: REPLICATION_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCount: 0,
      ...jobData,
    };
    this.jobs.set(job.id, job);
    this._persistToDisk();
    return job;
  }

  updateJob(id, updates) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = {
      ...job,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, updated);
    this._persistToDisk();
    return updated;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  getJobsByStatus(status) {
    return Array.from(this.jobs.values()).filter((j) => j.status === status);
  }

  getPendingJobs(limit = 100) {
    return Array.from(this.jobs.values())
      .filter((j) => j.status === REPLICATION_STATUS.PENDING)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .slice(0, limit);
  }

  getJobsByObject(bucket, key) {
    return Array.from(this.jobs.values()).filter(
      (j) => j.sourceBucket === bucket && j.sourceKey === key
    );
  }

  listJobs(filters = {}, limit = 100, offset = 0) {
    let result = Array.from(this.jobs.values());

    if (filters.status) {
      result = result.filter((j) => j.status === filters.status);
    }
    if (filters.sourceBucket) {
      result = result.filter((j) => j.sourceBucket === filters.sourceBucket);
    }
    if (filters.ruleId) {
      result = result.filter((j) => j.ruleId === filters.ruleId);
    }

    return result
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + limit);
  }

  deleteJob(id) {
    const existed = this.jobs.has(id);
    if (existed) {
      this.jobs.delete(id);
      this._persistToDisk();
    }
    return existed;
  }

  getStats() {
    const stats = {
      total: this.jobs.size,
      [REPLICATION_STATUS.PENDING]: 0,
      [REPLICATION_STATUS.IN_PROGRESS]: 0,
      [REPLICATION_STATUS.COMPLETED]: 0,
      [REPLICATION_STATUS.FAILED]: 0,
    };
    for (const job of this.jobs.values()) {
      stats[job.status] = (stats[job.status] || 0) + 1;
    }
    return stats;
  }

  cleanOldJobs(olderThanDays = 7) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === REPLICATION_STATUS.COMPLETED || job.status === REPLICATION_STATUS.FAILED) &&
        new Date(job.updatedAt).getTime() < cutoff
      ) {
        this.jobs.delete(id);
        deleted++;
      }
    }
    if (deleted > 0) {
      this._persistToDisk();
    }
    return deleted;
  }
}

module.exports = {
  ReplicationStore,
  REPLICATION_STATUS,
};
