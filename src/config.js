const GATEWAY_PORT = process.env.GATEWAY_PORT || 9000;

const BACKENDS = {
  aws: {
    type: 'aws',
    name: 'AWS S3',
    endpoint: process.env.AWS_ENDPOINT || 'https://s3.amazonaws.com',
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    priority: 1,
    weight: 50,
  },
  aliyun: {
    type: 'aliyun',
    name: 'Alibaba Cloud OSS',
    endpoint: process.env.ALIYUN_OSS_ENDPOINT || 'https://oss-cn-hangzhou.aliyuncs.com',
    region: process.env.ALIYUN_OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || '',
    bucket: process.env.ALIYUN_OSS_BUCKET || '',
    priority: 2,
    weight: 30,
  },
  minio: {
    type: 'minio',
    name: 'MinIO',
    endpoint: process.env.MINIO_ENDPOINT || 'http://127.0.0.1:9001',
    region: process.env.MINIO_REGION || 'us-east-1',
    accessKeyId: process.env.MINIO_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY || 'minioadmin',
    priority: 3,
    weight: 20,
  },
};

const BUCKET_POLICIES = {
  'prod-assets': {
    primary: 'aws',
    failover: ['aliyun', 'minio'],
    replication: false,
  },
  'user-uploads': {
    primary: 'aliyun',
    failover: ['minio', 'aws'],
    replication: false,
  },
  'dev-data': {
    primary: 'minio',
    failover: ['aws', 'aliyun'],
    replication: false,
  },
};

const DEFAULT_POLICY = {
  primary: 'aws',
  failover: ['aliyun', 'minio'],
  replication: false,
};

const HEALTH_CHECK = {
  enabled: true,
  intervalMs: 15000,
  timeoutMs: 5000,
  unhealthyThreshold: 3,
  healthyThreshold: 2,
};

const FAILOVER = {
  maxRetries: 2,
  retryDelayMs: 100,
  retryableStatusCodes: [503, 502, 504],
};

module.exports = {
  GATEWAY_PORT,
  BACKENDS,
  BUCKET_POLICIES,
  DEFAULT_POLICY,
  HEALTH_CHECK,
  FAILOVER,
};
