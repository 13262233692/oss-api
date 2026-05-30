const express = require('express');
const morgan = require('morgan');
const { GATEWAY_PORT } = require('./config');
const { S3_OPS, parseRequest, formatListBucketsResult, formatListObjectsResult, formatCopyObjectResult, formatMultiDeleteResult, parseXmlBody } = require('./s3-parser');
const { getOrCreateAdapter } = require('./backend-adapter');
const PolicyRouter = require('./policy-router');
const HealthChecker = require('./health-check');
const ReplayMiddleware = require('./replay-middleware');

const app = express();
const healthChecker = new HealthChecker();
const policyRouter = new PolicyRouter(healthChecker);
const replayMiddleware = new ReplayMiddleware(policyRouter, healthChecker);

express.response.xml = function (xml) {
  this.set('Content-Type', 'application/xml');
  return this.send(xml);
};

app.use(morgan('combined'));
app.use(express.raw({ type: '*/*', limit: '100mb' }));

healthChecker.onStatusChange((name, wasHealthy, isHealthy) => {
  const ts = new Date().toISOString();
  if (!isHealthy) {
    console.warn(`[${ts}] Backend "${name}" is now UNHEALTHY`);
  } else {
    console.log(`[${ts}] Backend "${name}" recovered to HEALTHY`);
  }
});

app.get('/_/health', (req, res) => {
  const status = healthChecker.getAllStatus();
  const allHealthy = Object.values(status).every((s) => s.healthy);
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    backends: status,
  });
});

app.get('/_/stats', (req, res) => {
  res.json(replayMiddleware.getStats());
});

app.get('/_/policies', (req, res) => {
  res.json(policyRouter.listPolicies());
});

app.put('/_/policies/:bucket', express.json(), (req, res) => {
  const { bucket } = req.params;
  const { primary, failover } = req.body;
  if (!primary) {
    return res.status(400).json({ error: 'primary backend is required' });
  }
  policyRouter.setPolicy(bucket, { primary, failover: failover || [], replication: false });
  res.json({ bucket, primary, failover: failover || [] });
});

app.delete('/_/policies/:bucket', (req, res) => {
  const { bucket } = req.params;
  policyRouter.removePolicy(bucket);
  res.status(204).send();
});

function buildExecuteParams(parsed) {
  const params = {
    bucket: parsed.bucket,
    key: parsed.key,
    query: parsed.query,
    contentType: parsed.contentType,
    metadata: parsed.metadata,
    copySource: parsed.copySource,
  };

  if (parsed.operation === S3_OPS.PUT_OBJECT) {
    params.body = parsed.body;
  }

  return params;
}

app.all('/*', async (req, res) => {
  const parsed = parseRequest(req);

  if (parsed.operation === S3_OPS.UNKNOWN) {
    return res.status(400).xml(buildErrorXml('InvalidRequest', 'Unsupported S3 operation'));
  }

  try {
    const result = await replayMiddleware.executeWithFailover(parsed, async (backend) => {
      const params = buildExecuteParams(parsed);
      if (parsed.operation === S3_OPS.MULTI_DELETE && !params.keys) {
        const xmlBody = await parseXmlBody(parsed.body?.toString() || '');
        if (xmlBody?.Delete?.Object) {
          const objects = Array.isArray(xmlBody.Delete.Object) ? xmlBody.Delete.Object : [xmlBody.Delete.Object];
          params.keys = objects.map((o) => o.Key);
        } else {
          params.keys = [];
        }
      }
      return backend.adapter.execute(parsed.operation, params);
    });

    sendResult(res, parsed, result);
  } catch (err) {
    const statusCode = err.statusCode || err.$metadata?.httpStatusCode || 500;
    const code = err.Code || err.name || 'InternalError';
    const message = err.message || 'Unknown error';
    console.error(`[ERROR] ${parsed.operation} bucket=${parsed.bucket} key=${parsed.key}: ${statusCode} ${message}`);
    res.status(statusCode).xml(buildErrorXml(code, message));
  }
});

function sendResult(res, parsed, result) {
  switch (parsed.operation) {
    case S3_OPS.LIST_BUCKETS:
      res.set('Content-Type', 'application/xml');
      res.send(formatListBucketsResult(result.buckets || []));
      break;

    case S3_OPS.CREATE_BUCKET:
      res.set('Location', result.location || '');
      res.status(200).send();
      break;

    case S3_OPS.DELETE_BUCKET:
      res.status(204).send();
      break;

    case S3_OPS.HEAD_BUCKET:
      res.status(200).send();
      break;

    case S3_OPS.LIST_OBJECTS_V2:
      res.set('Content-Type', 'application/xml');
      res.send(formatListObjectsResult(parsed.bucket, result.objects || [], result.isTruncated, result.continuationToken));
      break;

    case S3_OPS.PUT_OBJECT:
      res.set('ETag', result.etag || '""');
      res.status(200).json({ etag: result.etag, versionId: result.versionId });
      break;

    case S3_OPS.GET_OBJECT:
      res.set('Content-Type', result.contentType || 'application/octet-stream');
      if (result.contentLength) res.set('Content-Length', result.contentLength);
      if (result.etag) res.set('ETag', result.etag);
      if (result.lastModified) res.set('Last-Modified', result.lastModified);
      for (const [k, v] of Object.entries(result.metadata || {})) {
        res.set(`x-amz-meta-${k}`, v);
      }
      res.status(200).send(result.body);
      break;

    case S3_OPS.HEAD_OBJECT:
      res.set('Content-Type', result.contentType || 'application/octet-stream');
      if (result.contentLength) res.set('Content-Length', result.contentLength);
      if (result.etag) res.set('ETag', result.etag);
      if (result.lastModified) res.set('Last-Modified', result.lastModified);
      for (const [k, v] of Object.entries(result.metadata || {})) {
        res.set(`x-amz-meta-${k}`, v);
      }
      res.status(200).send();
      break;

    case S3_OPS.DELETE_OBJECT:
      res.status(204).send();
      break;

    case S3_OPS.COPY_OBJECT:
      res.set('Content-Type', 'application/xml');
      res.send(formatCopyObjectResult(result.etag || '""', result.lastModified));
      break;

    case S3_OPS.MULTI_DELETE:
      res.set('Content-Type', 'application/xml');
      res.send(formatMultiDeleteResult(result.deleted || [], result.errors || []));
      break;

    default:
      res.status(400).xml(buildErrorXml('InvalidRequest', 'Unknown operation'));
  }
}

function buildErrorXml(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message><Resource></Resource><RequestId>${Date.now()}</RequestId></Error>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function start() {
  healthChecker.start();

  const server = app.listen(GATEWAY_PORT, () => {
    console.log(`OSS Gateway listening on port ${GATEWAY_PORT}`);
    console.log(`Health check: http://localhost:${GATEWAY_PORT}/_/health`);
    console.log(`Stats:        http://localhost:${GATEWAY_PORT}/_/stats`);
    console.log(`Policies:     http://localhost:${GATEWAY_PORT}/_/policies`);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    healthChecker.stop();
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    healthChecker.stop();
    server.close(() => process.exit(0));
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, healthChecker, policyRouter, replayMiddleware };
