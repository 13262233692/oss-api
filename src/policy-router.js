const { BUCKET_POLICIES, DEFAULT_POLICY, BACKENDS } = require('./config');
const { getOrCreateAdapter } = require('./backend-adapter');
const CRRRulesEngine = require('./crr-rules');

class PolicyRouter {
  constructor(healthChecker) {
    this.healthChecker = healthChecker;
    this.policies = { ...BUCKET_POLICIES };
    this.crrRules = new CRRRulesEngine();
  }

  setPolicy(bucket, policy) {
    this.policies[bucket] = policy;
  }

  removePolicy(bucket) {
    delete this.policies[bucket];
  }

  getPolicy(bucket) {
    return this.policies[bucket] || DEFAULT_POLICY;
  }

  resolveBackendOrder(bucket) {
    const policy = this.getPolicy(bucket);
    const order = [policy.primary, ...policy.failover];
    return order
      .filter((name) => {
        const backend = BACKENDS[name];
        if (!backend) return false;
        if (this.healthChecker && !this.healthChecker.isHealthy(name)) return false;
        return true;
      })
      .map((name) => ({
        name,
        adapter: getOrCreateAdapter(BACKENDS[name]),
        config: BACKENDS[name],
      }));
  }

  resolveAllBackends(bucket) {
    const policy = this.getPolicy(bucket);
    const order = [policy.primary, ...policy.failover];
    return order
      .filter((name) => BACKENDS[name])
      .map((name) => ({
        name,
        adapter: getOrCreateAdapter(BACKENDS[name]),
        config: BACKENDS[name],
      }));
  }

  getPrimaryBackend(bucket) {
    const policy = this.getPolicy(bucket);
    const backend = BACKENDS[policy.primary];
    if (!backend) return null;
    return {
      name: policy.primary,
      adapter: getOrCreateAdapter(backend),
      config: backend,
    };
  }

  getNextFailoverBackend(bucket, excludedNames) {
    const policy = this.getPolicy(bucket);
    const candidates = policy.failover.filter((name) => {
      if (excludedNames && excludedNames.includes(name)) return false;
      if (!BACKENDS[name]) return false;
      if (this.healthChecker && !this.healthChecker.isHealthy(name)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    const name = candidates[0];
    const backend = BACKENDS[name];
    return {
      name,
      adapter: getOrCreateAdapter(backend),
      config: backend,
    };
  }

  listPolicies() {
    return Object.entries(this.policies).map(([bucket, policy]) => ({
      bucket,
      primary: policy.primary,
      failover: policy.failover,
      replication: policy.replication,
    }));
  }

  getCRRRules() {
    return this.crrRules;
  }

  matchReplicationRules(bucket, key) {
    return this.crrRules.matchRules(bucket, key);
  }

  hasReplication(bucket, key) {
    return this.crrRules.shouldReplicate(bucket, key);
  }

  getReplicationDestinations(bucket, key) {
    return this.crrRules.getReplicationDestinations(bucket, key);
  }

  createCRRRule(ruleData) {
    return this.crrRules.createRule(ruleData);
  }

  updateCRRRule(id, updates) {
    return this.crrRules.updateRule(id, updates);
  }

  deleteCRRRule(id) {
    return this.crrRules.deleteRule(id);
  }

  getCRRRule(id) {
    return this.crrRules.getRule(id);
  }

  listCRRRules(filters) {
    return this.crrRules.listRules(filters);
  }
}

module.exports = PolicyRouter;
