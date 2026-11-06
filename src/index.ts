import { DOMParser, Node as DOMNode, XMLSerializer } from '@xmldom/xmldom';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Polyfill DOM globals for AWS SDK XML response deserialization in Cloudflare Workers (workerd)
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.DOMParser === 'undefined') {
  g.DOMParser = DOMParser;
}
if (typeof g.Node === 'undefined') {
  g.Node = DOMNode;
}
if (typeof g.XMLSerializer === 'undefined') {
  g.XMLSerializer = XMLSerializer;
}
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type Bindings = {
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Fallbacks for alternative naming conventions
  R2_ACCESS_KEY?: string;
  R2_ACCESS_SECRET?: string;
  R2_PUBLIC_DOMAIN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. CORS Middleware hỗ trợ Web Client & Uppy
app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
    exposeHeaders: ['ETag', 'Content-Length'],
    maxAge: 86400,
    credentials: true,
  })
);

// Global Error Handlers
app.notFound((c) => {
  return c.json({ success: false, error: 'Endpoint not found' }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled Worker error:', err);
  return c.json(
    {
      success: false,
      error: err.message || 'Internal Server Error',
    },
    500
  );
});

// Helper: Khởi tạo kết nối S3 Client đến Cloudflare R2
const getR2Client = (env: Bindings): S3Client => {
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME;
  const accessKeyId = env.R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || env.R2_ACCESS_SECRET;

  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
    const missing: string[] = [];
    if (!accountId) missing.push('R2_ACCOUNT_ID');
    if (!bucketName) missing.push('R2_BUCKET_NAME');
    if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID (or R2_ACCESS_KEY)');
    if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY (or R2_ACCESS_SECRET)');
    throw new Error(`Missing required R2 configuration: ${missing.join(', ')}`);
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
};

// Helper: Tạo key lưu trữ an toàn, chống path traversal và collision
const generateStorageKey = (filename: string, userId?: string, folder = 'uploads'): string => {
  const fileId = crypto.randomUUID();
  const baseFilename = filename.split(/[/\\]/).pop() || 'file';
  const sanitizedFilename = baseFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const userFolder = userId ? userId.trim().replace(/[^a-zA-Z0-9._-]/g, '_') : 'common';
  const cleanFolder = folder.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${cleanFolder}/${userFolder}/${fileId}-${sanitizedFilename}`;
};

// Helper: Format public CDN URL nếu có cấu hình public domain hoặc r2.dev
const getFileLocation = (env: Bindings, key: string): string => {
  if (env.R2_PUBLIC_DOMAIN) {
    const domain = env.R2_PUBLIC_DOMAIN.trim().replace(/\/+$/, '');
    return domain.startsWith('http://') || domain.startsWith('https://')
      ? `${domain}/${key}`
      : `https://${domain}/${key}`;
  }
  return `https://${env.R2_BUCKET_NAME}.r2.dev/${key}`;
};

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Healthcheck & Service info
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'upload',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

// 1. File nhỏ: Cấp Presigned PUT URL trực tiếp (< 10MB)
app.post('/api/upload/single', async (c) => {
  const body = await c.req.json<{
    filename?: string;
    type?: string;
    userId?: string;
    folder?: string;
  }>().catch(() => null);

  if (!body || !body.filename || !body.type) {
    return c.json({ error: 'Missing required fields: filename and type' }, 400);
  }

  const { filename, type, userId, folder } = body;
  const s3 = getR2Client(c.env);
  const key = generateStorageKey(filename, userId, folder);

  const command = new PutObjectCommand({
    Bucket: c.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: type,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 300 });

  return c.json({
    url,
    method: 'PUT',
    key,
    location: getFileLocation(c.env, key),
  });
});

// 2. File lớn: Khởi tạo phiên Multipart Upload (>= 10MB)
app.post('/api/upload/multipart', async (c) => {
  const body = await c.req.json<{
    filename?: string;
    type?: string;
    userId?: string;
    folder?: string;
  }>().catch(() => null);

  if (!body || !body.filename || !body.type) {
    return c.json({ error: 'Missing required fields: filename and type' }, 400);
  }

  const { filename, type, userId, folder } = body;
  const s3 = getR2Client(c.env);
  const key = generateStorageKey(filename, userId, folder);

  const command = new CreateMultipartUploadCommand({
    Bucket: c.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: type,
  });

  const res = await s3.send(command);

  return c.json({
    uploadId: res.UploadId,
    key,
  });
});

// 3. Ký URL cho từng mảnh (Part) hoặc danh sách mảnh
app.post('/api/upload/multipart/batch-sign-parts', async (c) => {
  const body = await c.req.json<{
    key?: string;
    uploadId?: string;
    partNumbers?: number[];
  }>().catch(() => null);

  if (!body || !body.key || !body.uploadId || !Array.isArray(body.partNumbers) || body.partNumbers.length === 0) {
    return c.json({ error: 'Invalid payload: key, uploadId, and partNumbers are required' }, 400);
  }

  const { key, uploadId, partNumbers } = body;
  const s3 = getR2Client(c.env);
  const presignedUrls: Record<number, string> = {};

  await Promise.all(
    partNumbers.map(async (partNumber) => {
      const command = new UploadPartCommand({
        Bucket: c.env.R2_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        PartNumber: Number(partNumber),
      });

      presignedUrls[partNumber] = await getSignedUrl(s3, command, { expiresIn: 300 });
    })
  );

  return c.json({ presignedUrls });
});

// 4. Ghép toàn bộ các mảnh lại thành file hoàn chỉnh
app.post('/api/upload/multipart/complete', async (c) => {
  const body = await c.req.json<{
    key?: string;
    uploadId?: string;
    parts?: { PartNumber: number; ETag: string }[];
  }>().catch(() => null);

  if (!body || !body.key || !body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
    return c.json({ error: 'Missing required fields: key, uploadId, or parts list' }, 400);
  }

  const { key, uploadId, parts } = body;
  const s3 = getR2Client(c.env);

  // R2 bắt buộc mảng Parts phải sắp xếp tăng dần theo PartNumber
  const sortedParts = parts
    .map((p) => ({
      PartNumber: Number(p.PartNumber),
      ETag: p.ETag.replace(/['"]+/g, ''), // Xóa dấu ngoặc kép thừa quanh ETag
    }))
    .sort((a, b) => a.PartNumber - b.PartNumber);

  const command = new CompleteMultipartUploadCommand({
    Bucket: c.env.R2_BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: sortedParts },
  });

  await s3.send(command);

  return c.json({
    success: true,
    key,
    location: getFileLocation(c.env, key),
  });
});

// 5. Hủy tiến trình upload và giải phóng tài nguyên dở dang
app.post('/api/upload/multipart/abort', async (c) => {
  const body = await c.req.json<{ key?: string; uploadId?: string }>().catch(() => null);

  if (!body || !body.key || !body.uploadId) {
    return c.json({ error: 'Missing key or uploadId' }, 400);
  }

  const { key, uploadId } = body;
  const s3 = getR2Client(c.env);

  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: c.env.R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
    })
  );

  return c.json({ aborted: true });
});

// 6. Cấp Presigned GET URL để tải hoặc xem trước file (khi bucket private)
app.post('/api/upload/signed-download-url', async (c) => {
  const body = await c.req.json<{ key?: string; expiresIn?: number }>().catch(() => null);

  if (!body || !body.key) {
    return c.json({ error: 'Missing key parameter' }, 400);
  }

  const { key, expiresIn = 3600 } = body;
  const s3 = getR2Client(c.env);

  const command = new GetObjectCommand({
    Bucket: c.env.R2_BUCKET_NAME,
    Key: key,
  });

  const downloadUrl = await getSignedUrl(s3, command, {
    expiresIn: Math.min(Number(expiresIn) || 3600, 86400),
  });

  return c.json({
    success: true,
    downloadUrl,
    key,
    expiresIn: Math.min(Number(expiresIn) || 3600, 86400),
  });
});

export default app;
