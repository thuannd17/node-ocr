// MinIO (S3) object store: the media service's storage in production.
//   MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET
// ETag of a single-part upload = MD5 of the bytes (objects here are at most a few MB), so callers can
// compare content without downloading it.
import { Client } from 'minio';

const notFound = (key) => Object.assign(new Error(`Not found: ${key}`), { code: 'NotFound' });
const isMissing = (e) => e && (e.code === 'NotFound' || e.code === 'NoSuchKey');

export function createMinioStore(env = process.env) {
  const cfg = {
    endPoint: env.MINIO_ENDPOINT || 'localhost',
    port: Number(env.MINIO_PORT) || 9000,
    useSSL: env.MINIO_USE_SSL === 'true' || env.MINIO_USE_SSL === '1',
    bucket: env.MINIO_BUCKET || 'roster-ocr',
  };
  const client = new Client({ endPoint: cfg.endPoint, port: cfg.port, useSSL: cfg.useSSL, accessKey: env.MINIO_ACCESS_KEY || '', secretKey: env.MINIO_SECRET_KEY || '' });
  let bucketReady = null;
  const ready = () => (bucketReady ||= (async () => {
    if (!(await client.bucketExists(cfg.bucket))) await client.makeBucket(cfg.bucket);
  })().catch((e) => { bucketReady = null; throw e; }));
  const etagOf = (s) => String(s || '').replace(/"/g, '');

  return {
    describe: () => ({ backend: 'minio', endpoint: `${cfg.useSSL ? 'https' : 'http'}://${cfg.endPoint}:${cfg.port}`, bucket: cfg.bucket }),
    check: ready,
    async list(prefix) {
      await ready();
      const out = [];
      await new Promise((resolve, reject) => {
        const s = client.listObjectsV2(cfg.bucket, prefix, true);
        s.on('data', (o) => { if (o.name) out.push({ key: o.name, size: o.size, etag: etagOf(o.etag), lastModified: o.lastModified }); });
        s.on('error', reject);
        s.on('end', resolve);
      });
      return out;
    },
    async stat(key) {
      await ready();
      try {
        const s = await client.statObject(cfg.bucket, key);
        return { key, size: s.size, etag: etagOf(s.etag), lastModified: s.lastModified };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async get(key) {
      await ready();
      let stream;
      try { stream = await client.getObject(cfg.bucket, key); } catch (e) { throw isMissing(e) ? notFound(key) : e; }
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async put(key, buf, contentType = 'application/octet-stream') {
      await ready();
      await client.putObject(cfg.bucket, key, buf, buf.length, { 'Content-Type': contentType });
    },
    async remove(key) {
      await ready();
      await client.removeObject(cfg.bucket, key);
    },
  };
}
