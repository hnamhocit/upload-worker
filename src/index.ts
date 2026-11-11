import { Hono } from 'hono';
import { cors } from 'hono/cors';

export type Bindings = {
  MY_BUCKET: R2Bucket;
  JWT_SECRET: string;
  PUBLIC_R2_DOMAIN?: string;
};

type Variables = { userId?: string; appId?: string; role?: string };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function verifyJWT(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(atob(parts[0]));
    if (header.alg !== 'HS256') return false;
    const encoder = new TextEncoder();
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = decodeBase64Url(parts[2]);
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
    if (!isValid) return false;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch { return false; }
}

function decodeBase64Url(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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

function getUrl(env: Bindings, key: string): string {
  if (env.PUBLIC_R2_DOMAIN) return `${env.PUBLIC_R2_DOMAIN.replace(/\/+$/, '')}/${key}`;
  return `https://vntez-bucket.r2.dev/${key}`;
}

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range', 'X-Filename'],
  exposeHeaders: ['ETag', 'Content-Length'], maxAge: 86400 }));

app.use('/upload/*', async (c, next) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ success: false, error: 'No auth' }, 401);
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!await verifyJWT(token, c.env.JWT_SECRET)) return c.json({ success: false, error: 'Invalid' }, 401);
    const payload = JSON.parse(atob(token.split('.')[1]));
    c.set('userId', payload.sub);
    c.set('appId', payload.app_id);
    c.set('role', payload.role);
    await next();
  } catch { return c.json({ success: false, error: 'Auth failed' }, 401); }
});

const limitMap = new Map<string, { count: number; reset: number }>();
app.use('/upload/multipart/create', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || '127.0.0.1';
  const now = Date.now();
  let lim = limitMap.get(ip);
  if (!lim || now > lim.reset) { lim = { count: 0, reset: now + 60000 }; limitMap.set(ip, lim); }
  if (lim.count >= 15) return c.json({ success: false, error: 'Rate limited' }, 429);
  lim.count++;
  await next();
});

app.get('/', (c) => c.json({ status: 'ok', service: 'upload' }));
app.get('/health', (c) => c.json({ status: 'healthy' }));

app.post('/upload/multipart/create', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (!body?.filename || !body?.contentType) return c.json({ success: false }, 400);
    if (body.size > 100 * 1024 * 1024) return c.json({ success: false }, 400);
    const key = generateKey(body.filename, userId, appId);
    const mp = await c.env.MY_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType } });
    return c.json({ success: true, uploadId: mp.uploadId, key }, 201);
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.put('/upload/multipart/upload-part', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const uploadId = c.req.query('uploadId')!;
    const key = c.req.query('key')!;
    const partNumber = c.req.query('partNumber')!;
    if (!uploadId || !key || !partNumber) return c.json({ success: false }, 400);
    if (!key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false }, 403);
    const body = await c.req.arrayBuffer();
    if (!body.byteLength) return c.json({ success: false }, 400);
    const part = await c.env.MY_BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(Number(partNumber), body);
    return c.json({ success: true, partNumber: Number(partNumber), etag: part.etag });
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.post('/upload/multipart/complete', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (!body?.uploadId || !body?.key || !Array.isArray(body?.parts)) return c.json({ success: false }, 400);
    if (!body.key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false }, 403);
    const parts = body.parts.map((p: any) => ({ partNumber: Number(p.partNumber), etag: p.etag.replace(/['\"]/g, '') }))
      .sort((a: any, b: any) => a.partNumber - b.partNumber);
    await c.env.MY_BUCKET.resumeMultipartUpload(body.key, body.uploadId).complete(parts);
    return c.json({ success: true, key: body.key, url: getUrl(c.env, body.key) });
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.post('/upload/multipart/abort', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const body = await c.req.json().catch(() => null) as any;
    if (!body?.uploadId || !body?.key) return c.json({ success: false }, 400);
    if (!body.key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false }, 403);
    await c.env.MY_BUCKET.resumeMultipartUpload(body.key, body.uploadId).abort();
    return c.json({ success: true });
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.post('/upload/single', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const ct = c.req.header('content-type') || 'application/octet-stream';
    let filename: string, data: ArrayBuffer;
    if (ct.includes('multipart/form-data')) {
      const fd = await c.req.formData().catch(() => null);
      if (!fd) return c.json({ success: false }, 400);
      const file = fd.get('file') as File | null;
      if (!file) return c.json({ success: false }, 400);
      filename = file.name;
      data = await file.arrayBuffer();
    } else {
      const xfn = c.req.header('x-filename');
      if (!xfn) return c.json({ success: false }, 400);
      filename = xfn;
      data = await c.req.arrayBuffer();
    }
    if (!data.byteLength) return c.json({ success: false }, 400);
    if (data.byteLength > 5 * 1024 * 1024) return c.json({ success: false }, 400);
    const key = generateKey(filename, userId, appId);
    await c.env.MY_BUCKET.put(key, data, { httpMetadata: { contentType: ct } });
    return c.json({ success: true, key, url: getUrl(c.env, key), size: data.byteLength }, 201);
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.delete('/upload', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const role = c.get('role');
    let key = c.req.query('key');
    if (!key) { const body = await c.req.json().catch(() => null) as any; key = body?.key; }
    if (!key) return c.json({ success: false }, 400);
    if (!key.startsWith(`${appId}/${userId}/`) && role !== 'admin') return c.json({ success: false }, 403);
    await c.env.MY_BUCKET.delete(key);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ success: false }, 500); }
});

app.get('/upload/info', async (c) => {
  try {
    const userId = c.get('userId')!;
    const appId = c.get('appId')!;
    const key = c.req.query('key')!;
    if (!key) return c.json({ success: false }, 400);
    if (!key.startsWith(`${appId}/${userId}/`)) return c.json({ success: false }, 403);
    const obj = await c.env.MY_BUCKET.head(key);
    if (!obj) return c.json({ success: false }, 404);
    return c.json({ success: true, key, size: obj.size, contentType: obj.httpMetadata?.contentType, etag: obj.etag });
  } catch (e: any) { if (e.code === 'NoSuchKey') return c.json({ success: false }, 404); return c.json({ success: false }, 500); }
});

app.notFound((c) => c.json({ success: false }, 404));
app.onError((err, c) => { console.error(err); return c.json({ success: false }, 500); });

export default app;
