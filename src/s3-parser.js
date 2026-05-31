const { parseStringPromise, Builder } = require('xml2js');

const S3_OPS = {
  LIST_BUCKETS: 'ListBuckets',
  CREATE_BUCKET: 'CreateBucket',
  DELETE_BUCKET: 'DeleteBucket',
  HEAD_BUCKET: 'HeadBucket',
  LIST_OBJECTS_V2: 'ListObjectsV2',
  PUT_OBJECT: 'PutObject',
  GET_OBJECT: 'GetObject',
  HEAD_OBJECT: 'HeadObject',
  DELETE_OBJECT: 'DeleteObject',
  COPY_OBJECT: 'CopyObject',
  MULTI_DELETE: 'MultiDelete',
  CREATE_MULTIPART_UPLOAD: 'CreateMultipartUpload',
  UPLOAD_PART: 'UploadPart',
  COMPLETE_MULTIPART_UPLOAD: 'CompleteMultipartUpload',
  ABORT_MULTIPART_UPLOAD: 'AbortMultipartUpload',
  LIST_PARTS: 'ListParts',
  UNKNOWN: 'Unknown',
};

function parseRequest(req) {
  const host = req.headers.host || '';
  const path = req.path || req.url;
  const method = req.method.toUpperCase();
  const segments = path.split('/').filter(Boolean);

  let bucket = null;
  let key = null;

  const virtualHostMatch = host.match(/^([a-z0-9][a-z0-9.-]*)\.s3/i);
  if (virtualHostMatch && segments.length === 0) {
    bucket = virtualHostMatch[1];
    key = '';
  } else if (virtualHostMatch && segments.length > 0) {
    bucket = virtualHostMatch[1];
    key = segments.join('/');
  } else if (segments.length >= 1) {
    bucket = segments[0];
    if (segments.length > 1) {
      key = segments.slice(1).join('/');
    }
  }

  const query = req.query || {};
  const operation = detectOperation(method, bucket, key, query, req.headers);

  return {
    operation,
    bucket,
    key: key || '',
    method,
    headers: req.headers,
    query,
    body: req.body,
    contentLength: parseInt(req.headers['content-length'] || '0', 10),
    contentType: req.headers['content-type'] || 'application/octet-stream',
    metadata: extractMetadata(req.headers),
    copySource: req.headers['x-amz-copy-source'] || null,
    uploadId: query.uploadId || null,
    partNumber: query.partNumber ? parseInt(query.partNumber, 10) : null,
  };
}

function detectOperation(method, bucket, key, query, headers) {
  if (!bucket) {
    if (method === 'GET') return S3_OPS.LIST_BUCKETS;
    return S3_OPS.UNKNOWN;
  }

  if (!key || key === '') {
    switch (method) {
      case 'PUT':
        return S3_OPS.CREATE_BUCKET;
      case 'DELETE':
        return S3_OPS.DELETE_BUCKET;
      case 'HEAD':
        return S3_OPS.HEAD_BUCKET;
      case 'GET':
        return S3_OPS.LIST_OBJECTS_V2;
      default:
        return S3_OPS.UNKNOWN;
    }
  }

  if (query.uploads !== undefined && method === 'POST') {
    return S3_OPS.CREATE_MULTIPART_UPLOAD;
  }

  if (query.uploadId !== undefined) {
    if (method === 'PUT' && query.partNumber !== undefined) {
      return S3_OPS.UPLOAD_PART;
    }
    if (method === 'POST') {
      return S3_OPS.COMPLETE_MULTIPART_UPLOAD;
    }
    if (method === 'DELETE') {
      return S3_OPS.ABORT_MULTIPART_UPLOAD;
    }
    if (method === 'GET') {
      return S3_OPS.LIST_PARTS;
    }
  }

  if (method === 'PUT' && headers['x-amz-copy-source']) {
    return S3_OPS.COPY_OBJECT;
  }

  if (method === 'POST' && query.delete !== undefined) {
    return S3_OPS.MULTI_DELETE;
  }

  switch (method) {
    case 'PUT':
      return S3_OPS.PUT_OBJECT;
    case 'GET':
      return S3_OPS.GET_OBJECT;
    case 'HEAD':
      return S3_OPS.HEAD_OBJECT;
    case 'DELETE':
      return S3_OPS.DELETE_OBJECT;
    default:
      return S3_OPS.UNKNOWN;
  }
}

function extractMetadata(headers) {
  const meta = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-amz-meta-')) {
      meta[k.slice('x-amz-meta-'.length)] = v;
    }
  }
  return meta;
}

async function parseXmlBody(xml) {
  try {
    const result = await parseStringPromise(xml, { explicitArray: false });
    return result;
  } catch {
    return null;
  }
}

function buildXml(rootName, obj) {
  const builder = new Builder({ rootName });
  return builder.buildObject(obj);
}

function formatListBucketsResult(buckets) {
  const owner = { ID: 'gateway', DisplayName: 'oss-gateway' };
  const entries = buckets.map((b) => ({
    Bucket: {
      Name: b.name,
      CreationDate: b.created || new Date().toISOString(),
    },
  }));
  return buildXml('ListAllMyBucketsResult', {
    Owner: owner,
    Buckets: entries.length > 0 ? entries : '',
  });
}

function formatListObjectsResult(bucket, objects, isTruncated, continuationToken) {
  const result = {
    Name: bucket,
    IsTruncated: isTruncated ? 'true' : 'false',
    MaxKeys: '1000',
    Contents: objects.map((o) => ({
      Key: o.key,
      LastModified: o.lastModified || new Date().toISOString(),
      Size: String(o.size || 0),
      ETag: o.etag || '""',
      StorageClass: o.storageClass || 'STANDARD',
    })),
  };
  if (continuationToken) {
    result.NextContinuationToken = continuationToken;
  }
  return buildXml('ListBucketResult', result);
}

function formatCopyObjectResult(etag, lastModified) {
  return buildXml('CopyObjectResult', {
    ETag: etag,
    LastModified: lastModified || new Date().toISOString(),
  });
}

function formatMultiDeleteResult(deleted, errors) {
  const result = {};
  if (deleted && deleted.length > 0) {
    result.Deleted = deleted.map((d) => ({ Key: d }));
  }
  if (errors && errors.length > 0) {
    result.Error = errors.map((e) => ({
      Key: e.key,
      Code: e.code,
      Message: e.message,
    }));
  }
  return buildXml('DeleteResult', result);
}

function formatInitiateMultipartUploadResult(bucket, key, uploadId) {
  return buildXml('InitiateMultipartUploadResult', {
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });
}

function formatCompleteMultipartUploadResult(bucket, key, etag, location) {
  return buildXml('CompleteMultipartUploadResult', {
    Location: location || `/${bucket}/${key}`,
    Bucket: bucket,
    Key: key,
    ETag: etag,
  });
}

function formatListPartsResult(bucket, key, uploadId, parts, isTruncated) {
  const result = {
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    IsTruncated: isTruncated ? 'true' : 'false',
  };
  if (parts && parts.length > 0) {
    result.Part = parts.map((p) => ({
      PartNumber: p.partNumber,
      LastModified: p.lastModified || new Date().toISOString(),
      ETag: p.etag,
      Size: String(p.size || 0),
    }));
  }
  return buildXml('ListPartsResult', result);
}

async function parseCompleteMultipartUploadBody(xml) {
  const parsed = await parseXmlBody(xml, { explicitArray: false });
  if (!parsed || !parsed.CompleteMultipartUpload || !parsed.CompleteMultipartUpload.Part) {
    return { parts: [] };
  }
  let parts = parsed.CompleteMultipartUpload.Part;
  if (!Array.isArray(parts)) {
    parts = [parts];
  }
  return {
    parts: parts.map((p) => ({
      partNumber: parseInt(p.PartNumber, 10),
      etag: p.ETag,
    })),
  };
}

module.exports = {
  S3_OPS,
  parseRequest,
  detectOperation,
  extractMetadata,
  parseXmlBody,
  buildXml,
  formatListBucketsResult,
  formatListObjectsResult,
  formatCopyObjectResult,
  formatMultiDeleteResult,
  formatInitiateMultipartUploadResult,
  formatCompleteMultipartUploadResult,
  formatListPartsResult,
  parseCompleteMultipartUploadBody,
};
