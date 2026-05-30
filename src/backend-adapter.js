const {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { S3_OPS } = require('./s3-parser');

const adapters = new Map();

function createS3LikeClient(cfg) {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || 'us-east-1',
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
    tls: cfg.endpoint.startsWith('https'),
  });
}

function createAliyunClient(cfg) {
  const OSS = require('ali-oss');
  const regionMatch = cfg.region || cfg.endpoint.match(/oss-([a-z]+-[a-z]+-\d+)/);
  const region = typeof regionMatch === 'string' ? regionMatch : (regionMatch ? regionMatch[1] : 'cn-hangzhou');
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    return null;
  }
  return new OSS({
    region,
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
  });
}

function getOrCreateAdapter(backendConfig) {
  const key = `${backendConfig.type}:${backendConfig.name}`;
  if (adapters.has(key)) {
    return adapters.get(key);
  }

  let adapter;
  switch (backendConfig.type) {
    case 'aws':
    case 'minio':
      adapter = new S3Adapter(backendConfig);
      break;
    case 'aliyun':
      adapter = new AliyunAdapter(backendConfig);
      break;
    default:
      throw new Error(`Unknown backend type: ${backendConfig.type}`);
  }

  adapters.set(key, adapter);
  return adapter;
}

class S3Adapter {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.type = config.type;
    this.client = createS3LikeClient(config);
  }

  async execute(operation, params) {
    switch (operation) {
      case S3_OPS.LIST_BUCKETS:
        return this.listBuckets();
      case S3_OPS.CREATE_BUCKET:
        return this.createBucket(params.bucket);
      case S3_OPS.DELETE_BUCKET:
        return this.deleteBucket(params.bucket);
      case S3_OPS.HEAD_BUCKET:
        return this.headBucket(params.bucket);
      case S3_OPS.LIST_OBJECTS_V2:
        return this.listObjectsV2(params.bucket, params.query);
      case S3_OPS.PUT_OBJECT:
        return this.putObject(params.bucket, params.key, params.body, params.contentType, params.metadata);
      case S3_OPS.GET_OBJECT:
        return this.getObject(params.bucket, params.key);
      case S3_OPS.HEAD_OBJECT:
        return this.headObject(params.bucket, params.key);
      case S3_OPS.DELETE_OBJECT:
        return this.deleteObject(params.bucket, params.key);
      case S3_OPS.COPY_OBJECT:
        return this.copyObject(params.bucket, params.key, params.copySource);
      case S3_OPS.MULTI_DELETE:
        return this.multiDelete(params.bucket, params.keys);
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  async listBuckets() {
    const result = await this.client.send(new ListBucketsCommand({}));
    return {
      statusCode: 200,
      buckets: (result.Buckets || []).map((b) => ({
        name: b.Name,
        created: b.CreationDate?.toISOString(),
      })),
    };
  }

  async createBucket(bucket) {
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    return { statusCode: 200, location: `/${bucket}` };
  }

  async deleteBucket(bucket) {
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    return { statusCode: 204 };
  }

  async headBucket(bucket) {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { statusCode: 200 };
  }

  async listObjectsV2(bucket, query) {
    const input = { Bucket: bucket, MaxKeys: 1000 };
    if (query && query['continuation-token']) {
      input.ContinuationToken = query['continuation-token'];
    }
    if (query && query.prefix) {
      input.Prefix = query.prefix;
    }
    if (query && query.delimiter) {
      input.Delimiter = query.delimiter;
    }
    const result = await this.client.send(new ListObjectsV2Command(input));
    return {
      statusCode: 200,
      objects: (result.Contents || []).map((o) => ({
        key: o.Key,
        lastModified: o.LastModified?.toISOString(),
        size: o.Size,
        etag: o.ETag,
        storageClass: o.StorageClass,
      })),
      isTruncated: result.IsTruncated || false,
      continuationToken: result.NextContinuationToken || null,
    };
  }

  async putObject(bucket, key, body, contentType, metadata) {
    const input = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    };
    if (metadata && Object.keys(metadata).length > 0) {
      input.Metadata = metadata;
    }
    const result = await this.client.send(new PutObjectCommand(input));
    return {
      statusCode: 200,
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async getObject(bucket, key) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bodyBytes = await streamToBuffer(result.Body);
    return {
      statusCode: 200,
      body: bodyBytes,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      etag: result.ETag,
      lastModified: result.LastModified?.toISOString(),
      metadata: result.Metadata || {},
    };
  }

  async headObject(bucket, key) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      statusCode: 200,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      etag: result.ETag,
      lastModified: result.LastModified?.toISOString(),
      metadata: result.Metadata || {},
    };
  }

  async deleteObject(bucket, key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { statusCode: 204 };
  }

  async copyObject(bucket, key, copySource) {
    const result = await this.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: copySource,
      })
    );
    return {
      statusCode: 200,
      etag: result.CopyObjectResult?.ETag,
      lastModified: result.CopyObjectResult?.LastModified?.toISOString(),
    };
  }

  async multiDelete(bucket, keys) {
    const input = {
      Bucket: bucket,
      Delete: {
        Objects: keys.map((k) => ({ Key: k })),
        Quiet: false,
      },
    };
    const result = await this.client.send(new DeleteObjectsCommand(input));
    const deleted = (result.Deleted || []).map((d) => d.Key);
    const errors = (result.Errors || []).map((e) => ({
      key: e.Key,
      code: e.Code,
      message: e.Message,
    }));
    return { statusCode: 200, deleted, errors };
  }

  async checkHealth() {
    try {
      await this.client.send(new ListBucketsCommand({}));
      return { healthy: true, latency: 0 };
    } catch (err) {
      return { healthy: false, latency: 0, error: err.message };
    }
  }
}

class AliyunAdapter {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.type = config.type;
    this.client = createAliyunClient(config);
  }

  _ensureClient() {
    if (!this.client) {
      const err = new Error('Backend not configured: missing credentials');
      err.statusCode = 503;
      throw err;
    }
  }

  async execute(operation, params) {
    this._ensureClient();
    switch (operation) {
      case S3_OPS.LIST_BUCKETS:
        return this.listBuckets();
      case S3_OPS.CREATE_BUCKET:
        return this.createBucket(params.bucket);
      case S3_OPS.DELETE_BUCKET:
        return this.deleteBucket(params.bucket);
      case S3_OPS.HEAD_BUCKET:
        return this.headBucket(params.bucket);
      case S3_OPS.LIST_OBJECTS_V2:
        return this.listObjectsV2(params.bucket, params.query);
      case S3_OPS.PUT_OBJECT:
        return this.putObject(params.bucket, params.key, params.body, params.contentType, params.metadata);
      case S3_OPS.GET_OBJECT:
        return this.getObject(params.bucket, params.key);
      case S3_OPS.HEAD_OBJECT:
        return this.headObject(params.bucket, params.key);
      case S3_OPS.DELETE_OBJECT:
        return this.deleteObject(params.bucket, params.key);
      case S3_OPS.COPY_OBJECT:
        return this.copyObject(params.bucket, params.key, params.copySource);
      case S3_OPS.MULTI_DELETE:
        return this.multiDelete(params.bucket, params.keys);
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  async listBuckets() {
    const result = await this.client.listBuckets({});
    return {
      statusCode: 200,
      buckets: (result.buckets || []).map((b) => ({
        name: b.name,
        created: b.creationDate,
      })),
    };
  }

  async createBucket(bucket) {
    await this.client.useBucket(bucket);
    return { statusCode: 200, location: `/${bucket}` };
  }

  async deleteBucket(bucket) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    await this.client.deleteBucket(bucket);
    if (prev) this.client.useBucket(prev);
    return { statusCode: 204 };
  }

  async headBucket(bucket) {
    await this.client.getBucketInfo(bucket);
    return { statusCode: 200 };
  }

  async listObjectsV2(bucket, query) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const opts = { 'max-keys': 1000 };
      if (query && query.prefix) opts.prefix = query.prefix;
      if (query && query.delimiter) opts.delimiter = query.delimiter;
      if (query && query['continuation-token']) opts.marker = query['continuation-token'];
      const result = await this.client.listV2(opts);
      return {
        statusCode: 200,
        objects: (result.objects || []).map((o) => ({
          key: o.name,
          lastModified: o.lastModified,
          size: o.size,
          etag: o.etag,
          storageClass: o.storageClass,
        })),
        isTruncated: result.isTruncated || false,
        continuationToken: result.nextContinuationToken || result.nextMarker || null,
      };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async putObject(bucket, key, body, contentType, metadata) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const opts = {};
      if (contentType) opts.mime = contentType;
      if (metadata) opts.meta = metadata;
      const result = await this.client.put(key, body, opts);
      return { statusCode: 200, etag: result.etag };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async getObject(bucket, key) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const result = await this.client.get(key);
      return {
        statusCode: 200,
        body: Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content),
        contentType: result.res.headers['content-type'],
        contentLength: result.res.headers['content-length'],
        etag: result.etag,
        lastModified: result.res.headers['last-modified'],
        metadata: result.meta || {},
      };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async headObject(bucket, key) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const result = await this.client.head(key);
      return {
        statusCode: 200,
        contentType: result.res.headers['content-type'],
        contentLength: result.res.headers['content-length'],
        etag: result.etag,
        lastModified: result.res.headers['last-modified'],
        metadata: result.meta || {},
      };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async deleteObject(bucket, key) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      await this.client.delete(key);
      return { statusCode: 204 };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async copyObject(bucket, key, copySource) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const srcParsed = copySource.replace(/^\//, '').split('/');
      const srcBucket = srcParsed[0];
      const srcKey = srcParsed.slice(1).join('/');
      const result = await this.client.copy(key, `/${srcBucket}/${srcKey}`);
      return { statusCode: 200, etag: result.etag };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async multiDelete(bucket, keys) {
    const prev = this.client.options.bucket;
    this.client.useBucket(bucket);
    try {
      const result = await this.client.deleteMulti(keys, { quiet: false });
      const deleted = (result.deleted || []).map((d) => d.Key || d.name);
      const errors = [];
      return { statusCode: 200, deleted, errors };
    } finally {
      if (prev) this.client.useBucket(prev);
    }
  }

  async checkHealth() {
    if (!this.client) {
      return { healthy: false, latency: 0, error: 'Backend not configured: missing credentials' };
    }
    try {
      await this.client.listBuckets({ 'max-keys': 1 });
      return { healthy: true, latency: 0 };
    } catch (err) {
      return { healthy: false, latency: 0, error: err.message };
    }
  }
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === 'string') return Buffer.from(stream);
  if (!stream) return Buffer.alloc(0);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  getOrCreateAdapter,
  S3Adapter,
  AliyunAdapter,
  streamToBuffer,
};
