import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'hono/jwt';
import app from '../src/index';

const issuer = 'https://iam.example.test';
const privateSecret = 'test-only-upload-signing-key';
const allow = { limit: async () => ({ success: true }) };
const claims = { sub: 'user-1', app_id: 'app-a', aud: 'app-a', iss: issuer, exp: Math.floor(Date.now() / 1000) + 60 };
const bindings = {
  IAM_ISSUER: issuer,
  JWT_SECRET: privateSecret,
  UPLOAD_APP_LIMIT: allow,
  UPLOAD_CREATE_LIMIT: allow,
  UPLOAD_PART_LIMIT: allow,
  UPLOAD_MANAGE_LIMIT: allow,
};

test('RS256 IAM token controls storage prefix and multipart-form MIME', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const token = await sign(claims, privateKey, 'RS256');
  const body = new FormData();
  body.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
  let stored;
  const response = await app.request('/upload/single', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
  }, {
    ...bindings,
    IAM_JWT_PUBLIC_KEY: publicKey,
    MY_BUCKET: { async put(key, data, { httpMetadata }) {
      stored = { key, size: data.byteLength, contentType: httpMetadata.contentType };
    } },
  });
  expect(response.status).toBe(201);
  expect(stored).toEqual({ key: expect.stringMatching(/^app-a\/user-1\//), size: 5, contentType: expect.stringMatching(/^text\/plain(?:;|$)/) });
});

test('create quota separates app IDs on the same IP and returns a retry hint', async () => {
  const seen = new Set();
  const env = {
    ...bindings,
    UPLOAD_CREATE_LIMIT: { async limit({ key }) {
      const success = !seen.has(key);
      seen.add(key);
      return { success };
    } },
    MY_BUCKET: { async createMultipartUpload() { return { uploadId: 'session' }; } },
  };
  async function create(appId) {
    const token = await sign({ ...claims, app_id: appId, aud: appId }, privateSecret);
    return app.request('/upload/multipart/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '192.0.2.1' },
      body: JSON.stringify({ filename: 'file.bin', contentType: 'application/octet-stream', size: 6291456 }),
    }, env);
  }
  expect((await create('app-a')).status).toBe(201);
  const limited = await create('app-a');
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect((await create('app-b')).status).toBe(201);
  expect([...seen]).toEqual(['app-a:user-1', 'app-b:user-1']);
});

test('cannot read an object in a different app namespace', async () => {
  const token = await sign(claims, privateSecret);
  const response = await app.request('/upload/info?key=app-b/user-1/file', {
    headers: { Authorization: `Bearer ${token}` },
  }, bindings);
  expect(response.status).toBe(403);
});
