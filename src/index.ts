import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verify } from 'hono/jwt';

export type Bindings = {
  MY_BUCKET: R2Bucket;
  JWT_SECRET?: string;
  IAM_JWT_PUBLIC_KEY?: string;
  IAM_ISSUER: string;
  UPLOAD_APP_LIMIT: RateLimit;
  UPLOAD_CREATE_LIMIT: RateLimit;
  UPLOAD_PART_LIMIT: RateLimit;
  UPLOAD_MANAGE_LIMIT: RateLimit;
  PUBLIC_R2_DOMAIN?: string;
};

type Variables = { userId: string; appId: string };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MiB = 1024 * 1024;
const MAX_SINGLE = 5 * MiB;
const MAX_UPLOAD = 100 * MiB;
const MAX_PART = 5 * MiB;
const MAX_PARTS = MAX_UPLOAD / MAX_PART;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('Content-Length')) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function sanitizeFilename(name: string): string {
  return name.replace(/\0/g, '').replace(/[\/\\\\]/g, '_').replace(/\.\./g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').substring(0, 255);
}

function generateKey(filename: string, userId: string, appId: string): string {
  const sanitized = sanitizeFilename(filename);
  const ts = Date.now();
  const rand = crypto.getRandomValues(new Uint32Array(1))[0];
  return `${appId}/${userId}/${ts}-${rand}-${sanitized}`;
}

function getUrl(env: Bindings, key: string): string | undefined {
  if (env.PUBLIC_R2_DOMAIN) return `${env.PUBLIC_R2_DOMAIN.replace(/\/+$/, '')}/${key}`;
}

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range', 'X-Filename'],
  exposeHeaders: ['ETag', 'Content-Length', 'Retry-After'], maxAge: 86400 }));

app.use('/upload/*', async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return c.json({ success: false, error: 'UNAUTHORIZED' }, 401);

  const publicKey = c.env.IAM_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
  const key = publicKey || c.env.JWT_SECRET;
  if (!key || !c.env.IAM_ISSUER) {
    return c.json({ success: false, error: 'AUTH_UNAVAILABLE' }, 503);
  }

  try {
    const payload = await verify(token, key, {
      alg: publicKey ? 'RS256' : 'HS256',
      iss: c.env.IAM_ISSUER,
    });
    const { sub, app_id, aud, exp } = payload;
    if (!isId(sub) || !isId(app_id) || aud !== app_id || !Number.isSafeInteger(exp) ||
        Number(exp) <= Math.floor(Date.now() / 1000)) {
      return c.json({ success: false, error: 'INVALID_TOKEN' }, 401);
    }
    c.set('userId', sub);
    c.set('appId', app_id);
  } catch {
    return c.json({ success: false, error: 'INVALID_TOKEN' }, 401);
  }
  await next();
});

app.use('/upload/*', async (c, next) => {
  const path = c.req.path;
  const limiter = path === '/upload/multipart/upload-part' ? c.env.UPLOAD_PART_LIMIT
    : path === '/upload/multipart/create' || path === '/upload/single' ? c.env.UPLOAD_CREATE_LIMIT
    : c.env.UPLOAD_MANAGE_LIMIT;
  const appId = c.get('appId');
  const appQuota = await c.env.UPLOAD_APP_LIMIT.limit({ key: appId });
  if (!appQuota.success || !(await limiter.limit({ key: `${appId}:${c.get('userId')}` })).success) {
    c.header('Retry-After', '60');
    return c.json({ success: false, error: 'RATE_LIMITED' }, 429);
  }
  await next();
});

app.get('/', (c) => c.json({ status: 'ok', service: 'upload' }));
app.get('/health', (c) => c.json({ status: 'healthy' }));

app.post('/upload/multipart/create', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (typeof body?.filename !== "string" || !body.filename || typeof body.contentType !== "string" || !body.contentType) return c.json({ success: false, error: "INVALID_FILE" }, 400);
    if (!Number.isSafeInteger(body.size) || body.size <= 0) return c.json({ success: false, error: "INVALID_SIZE" }, 400);
    if (body.size > MAX_UPLOAD) return c.json({ success: false, error: "FILE_TOO_LARGE" }, 413);
    const key = generateKey(body.filename, userId, appId);
    const mp = await c.env.MY_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType } });
    return c.json({ success: true, uploadId: mp.uploadId, key }, 201);
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.put('/upload/multipart/upload-part', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const uploadId = c.req.query('uploadId')!;
    const key = c.req.query('key')!;
    const partNumber = Number(c.req.query('partNumber'));
    if (!uploadId || !key || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (!key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false, error: 'FORBIDDEN' }, 403);
    const body = await readBody(c.req.raw, MAX_PART);
    if (!body) return c.json({ success: false, error: 'PART_TOO_LARGE' }, 413);
    if (!body.byteLength) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    const part = await c.env.MY_BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(Number(partNumber), body);
    return c.json({ success: true, partNumber: Number(partNumber), etag: part.etag });
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.post('/upload/multipart/complete', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (typeof body?.uploadId !== "string" || typeof body.key !== "string" || !Array.isArray(body.parts) || !body.parts.length || body.parts.length > MAX_PARTS) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (!body.key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false, error: 'FORBIDDEN' }, 403);
    const parts = body.parts.map((part: { partNumber: number; etag: string }) => ({
      partNumber: part?.partNumber,
      etag: typeof part?.etag === 'string' ? part.etag.replace(/^"(.*)"$/, '$1') : '',
    })).sort((a: R2UploadedPart, b: R2UploadedPart) => a.partNumber - b.partNumber);
    if (parts.some((part: R2UploadedPart, index: number) => part.partNumber !== index + 1 || !part.etag)) {
      return c.json({ success: false, error: 'INVALID_PARTS' }, 400);
    }
    await c.env.MY_BUCKET.resumeMultipartUpload(body.key, body.uploadId).complete(parts);
    return c.json({ success: true, key: body.key, url: getUrl(c.env, body.key) });
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.post('/upload/multipart/abort', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (typeof body?.uploadId !== "string" || typeof body.key !== "string") return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (!body.key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false, error: 'FORBIDDEN' }, 403);
    await c.env.MY_BUCKET.resumeMultipartUpload(body.key, body.uploadId).abort();
    return c.json({ success: true });
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.post('/upload/single', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const ct = c.req.header('content-type') || 'application/octet-stream';
    let filename: string, data: ArrayBuffer | Uint8Array<ArrayBuffer>;
    let contentType = ct;
    if (ct.includes('multipart/form-data')) {
      const body = await readBody(c.req.raw, MAX_SINGLE + 64 * 1024);
      if (!body) return c.json({ success: false, error: 'FILE_TOO_LARGE' }, 413);
      const fd = await new Response(body, { headers: { 'Content-Type': ct } }).formData().catch(() => null);
      if (!fd) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
      const file = fd.get('file');
      if (!(file instanceof File)) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
      if (file.size > MAX_SINGLE) return c.json({ success: false, error: "FILE_TOO_LARGE" }, 413);
      filename = file.name;
      contentType = file.type || "application/octet-stream";
      data = await file.arrayBuffer();
    } else {
      const xfn = c.req.header('x-filename');
      if (!xfn) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
      filename = xfn;
      const body = await readBody(c.req.raw, MAX_SINGLE);
      if (!body) return c.json({ success: false, error: 'FILE_TOO_LARGE' }, 413);
      data = body;
    }
    if (!data.byteLength) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (data.byteLength > MAX_SINGLE) return c.json({ success: false, error: "FILE_TOO_LARGE" }, 413);
    const key = generateKey(filename, userId, appId);
    await c.env.MY_BUCKET.put(key, data, { httpMetadata: { contentType } });
    return c.json({ success: true, key, url: getUrl(c.env, key), size: data.byteLength }, 201);
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.delete('/upload', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    let key = c.req.query('key');
    if (!key) { const body = await c.req.json().catch(() => null) as any; key = body?.key; }
    if (typeof key !== "string" || !key) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (!key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false, error: 'FORBIDDEN' }, 403);
    await c.env.MY_BUCKET.delete(key);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.get('/upload/info', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const key = c.req.query('key')!;
    if (typeof key !== "string" || !key) return c.json({ success: false, error: 'INVALID_REQUEST' }, 400);
    if (!key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false, error: 'FORBIDDEN' }, 403);
    const obj = await c.env.MY_BUCKET.head(key);
    if (!obj) return c.json({ success: false, error: 'NOT_FOUND' }, 404);
    return c.json({ success: true, key, size: obj.size, contentType: obj.httpMetadata?.contentType, etag: obj.etag });
  } catch (e: any) { if (e.code === 'NoSuchKey') return c.json({ success: false, error: 'NOT_FOUND' }, 404); return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); }
});

app.notFound((c) => c.json({ success: false, error: 'NOT_FOUND' }, 404));
app.onError((err, c) => { console.error(err); return c.json({ success: false, error: 'INTERNAL_ERROR' }, 500); });

export default app;
