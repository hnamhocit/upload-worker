const partSize = 5 * 1024 * 1024;
const maxSize = 20 * partSize;

export type UploadPart = { partNumber: number; etag: string };
export type UploadSession = { uploadId: string; key: string; parts: UploadPart[] };
export type UploadResult = { success: true; key: string; size?: number; url?: string };
type UploadOptions = { session?: UploadSession; onCheckpoint?: (session: UploadSession) => void };

export class UploadError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: string) {
    super(code);
  }
}

export class UploadClient {
  constructor(private baseUrl: string, private accessToken: () => Promise<string>) {}

  private async request<T>(
    method: string, path: string, body?: BodyInit, headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method, body, headers: { ...headers, Authorization: `Bearer ${await this.accessToken()}` },
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
      throw new UploadError(response.status, typeof code === 'string' ? code : 'UPLOAD_FAILED',
        response.headers.get('Retry-After') ?? undefined);
    }
    return data as T;
  }

  async upload(file: File, { session, onCheckpoint }: UploadOptions = {}): Promise<UploadResult> {
    if (!file.size || file.size > maxSize) throw new RangeError('File must be between 1 byte and 100 MiB');
    const contentType = file.type || 'application/octet-stream';
    if (file.size <= partSize && !session) {
      const form = new FormData();
      form.set('file', file);
      return this.request('POST', '/upload/single', form);
    }
    const json = { 'Content-Type': 'application/json' };
    const ticket = session ?? { ...await this.request<Omit<UploadSession, 'parts'>>(
      'POST', '/upload/multipart/create', JSON.stringify({ filename: file.name, contentType, size: file.size }), json,
    ), parts: [] };
    const { uploadId, key } = ticket;
    const parts = [...ticket.parts];
    onCheckpoint?.({ uploadId, key, parts: [...parts] });
    for (let offset = 0; offset < file.size; offset += partSize) {
      const partNumber = Math.floor(offset / partSize) + 1;
      if (parts.some(part => part.partNumber === partNumber)) continue;
      const query = new URLSearchParams({ uploadId, key, partNumber: String(partNumber) });
      const { etag } = await this.request<UploadPart>(
        'PUT', `/upload/multipart/upload-part?${query}`, file.slice(offset, offset + partSize),
        { 'Content-Type': 'application/octet-stream' },
      );
      parts.push({ partNumber, etag });
      onCheckpoint?.({ uploadId, key, parts: [...parts] });
    }
    return this.request('POST', '/upload/multipart/complete', JSON.stringify({ uploadId, key, parts }), json);
  }

  async abort({ uploadId, key }: UploadSession): Promise<void> {
    await this.request('POST', '/upload/multipart/abort', JSON.stringify({ uploadId, key }),
      { 'Content-Type': 'application/json' });
  }
}
