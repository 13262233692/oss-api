const { v4: uuidv4 } = require('uuid');
const { CRR } = require('./config');

class CRRRulesEngine {
  constructor() {
    this.rules = new Map();
    this._loadDefaultRules();
  }

  _loadDefaultRules() {
    if (CRR.defaultRules && Array.isArray(CRR.defaultRules)) {
      for (const rule of CRR.defaultRules) {
        this.rules.set(rule.id, { ...rule });
      }
    }
  }

  createRule(ruleData) {
    if (!ruleData.sourceBucket) {
      throw new Error('sourceBucket is required');
    }
    if (!ruleData.destinationBackend) {
      throw new Error('destinationBackend is required');
    }
    if (!ruleData.destinationBucket) {
      throw new Error('destinationBucket is required');
    }

    const rule = {
      id: ruleData.id || `crr-${uuidv4().slice(0, 8)}`,
      sourceBucket: ruleData.sourceBucket,
      sourcePrefix: ruleData.sourcePrefix || '',
      destinationBackend: ruleData.destinationBackend,
      destinationBucket: ruleData.destinationBucket,
      destinationPrefix: ruleData.destinationPrefix || '',
      enabled: ruleData.enabled !== false,
      priority: ruleData.priority || 10,
      createdAt: new Date().toISOString(),
      description: ruleData.description || '',
    };

    this.rules.set(rule.id, rule);
    return rule;
  }

  updateRule(id, updates) {
    const existing = this.rules.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };

    this.rules.set(id, updated);
    return updated;
  }

  deleteRule(id) {
    return this.rules.delete(id);
  }

  getRule(id) {
    return this.rules.get(id) || null;
  }

  listRules(filters = {}) {
    let result = Array.from(this.rules.values());

    if (filters.sourceBucket) {
      result = result.filter((r) => r.sourceBucket === filters.sourceBucket);
    }
    if (filters.destinationBackend) {
      result = result.filter((r) => r.destinationBackend === filters.destinationBackend);
    }
    if (filters.enabled !== undefined) {
      result = result.filter((r) => r.enabled === filters.enabled);
    }

    return result.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  }

  matchRules(bucket, key) {
    return Array.from(this.rules.values())
      .filter((rule) => {
        if (!rule.enabled) return false;
        if (rule.sourceBucket !== bucket) return false;
        if (rule.sourcePrefix && !key.startsWith(rule.sourcePrefix)) return false;
        return true;
      })
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  }

  shouldReplicate(bucket, key) {
    return this.matchRules(bucket, key).length > 0;
  }

  getReplicationDestinations(bucket, key) {
    return this.matchRules(bucket, key).map((rule) => ({
      ruleId: rule.id,
      backend: rule.destinationBackend,
      bucket: rule.destinationBucket,
      key: (rule.destinationPrefix || '') + key,
      priority: rule.priority,
    }));
  }

  enableRule(id) {
    return this.updateRule(id, { enabled: true });
  }

  disableRule(id) {
    return this.updateRule(id, { enabled: false });
  }

  getStats() {
    const total = this.rules.size;
    const enabled = Array.from(this.rules.values()).filter((r) => r.enabled).length;
    const bySourceBucket = {};
    const byDestBackend = {};

    for (const rule of this.rules.values()) {
      bySourceBucket[rule.sourceBucket] = (bySourceBucket[rule.sourceBucket] || 0) + 1;
      byDestBackend[rule.destinationBackend] = (byDestBackend[rule.destinationBackend] || 0) + 1;
    }

    return {
      total,
      enabled,
      disabled: total - enabled,
      bySourceBucket,
      byDestBackend,
    };
  }
}

module.exports = CRRRulesEngine;
