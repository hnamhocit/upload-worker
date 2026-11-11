# Upload Worker - Quick Start Guide

## Setup (5 minutes)

### 1. Environment Configuration
```bash
cd workers/upload
cp .env.example .env
```

Edit `.env`:
```env
JWT_SECRET=your-secret-key-min-32-chars-recommended
PUBLIC_R2_DOMAIN=https://r2.yourdomain.com
R2_BUCKET_NAME=vntez-bucket
```

### 2. Dependencies
```bash
npm install
# or
pnpm install
```

### 3. Type Check
```bash
npm run typecheck
```

### 4. Local Testing
```bash
wrangler dev
# Server runs on http://localhost:8787
```

### 5. Production Deploy
```bash
wrangler deploy --minify
```

---

## API Usage Examples

### Generate Test JWT
```javascript
// Using Node.js (for testing only)
import crypto from 'crypto';

const secret = 'your-jwt-secret';
const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = btoa(JSON.stringify({
  sub: 'user-123',
  app_id: 'app-456',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000)
}));

const message = `${header}.${payload}`;
const signature = crypto
  .createHmac('sha256', secret)
  .update(message)
  .digest('base64url');

const token = `${message}.${signature}`;
console.log(token);
```

### 1. Upload Single File (< 5MB)
```bash
# Using cURL
JWT="eyJhbGc..."

curl -X POST http://localhost:8787/upload/single \
  -H "Authorization: Bearer $JWT" \
  -H "X-Filename: document.pdf" \
  -H "Content-Type: application/pdf" \
  --data-binary @./document.pdf

# Response
{
  "success": true,
  "key": "app-456/user-123/1699564800000-1234567890-document.pdf",
  "url": "https://vntez-bucket.r2.dev/app-456/user-123/1699564800000-1234567890-document.pdf",
  "size": 1024000
}
```

### 2. Upload Large File (Multipart)

**Step 1: Create Session**
```bash
JWT="eyJhbGc..."

curl -X POST http://localhost:8787/upload/multipart/create \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "large-video.mp4",
    "contentType": "video/mp4",
    "size": 52428800
  }'

# Response
{
  "success": true,
  "uploadId": "abc123def456...",
  "key": "app-456/user-123/1699564800000-1234567890-large-video.mp4"
}
```

**Step 2: Upload Part 1**
```bash
UPLOAD_ID="abc123def456..."
KEY="app-456/user-123/1699564800000-1234567890-large-video.mp4"

curl -X PUT "http://localhost:8787/upload/multipart/upload-part?uploadId=$UPLOAD_ID&key=$KEY&partNumber=1" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @./part1.bin

# Response
{
  "success": true,
  "partNumber": 1,
  "etag": "abc123def456..."
}
```

**Step 3: Upload Part 2** (same as part 1, just change partNumber)

**Step 4: Complete Upload**
```bash
curl -X POST http://localhost:8787/upload/multipart/complete \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "abc123def456...",
    "key": "app-456/user-123/1699564800000-1234567890-large-video.mp4",
    "parts": [
      { "partNumber": 1, "etag": "etag-1" },
      { "partNumber": 2, "etag": "etag-2" }
    ]
  }'

# Response
{
  "success": true,
  "key": "app-456/user-123/1699564800000-1234567890-large-video.mp4",
  "url": "https://vntez-bucket.r2.dev/app-456/user-123/1699564800000-1234567890-large-video.mp4"
}
```

### 3. Get File Info
```bash
KEY="app-456/user-123/1699564800000-1234567890-large-video.mp4"

curl -X GET "http://localhost:8787/upload/info?key=$KEY" \
  -H "Authorization: Bearer $JWT"

# Response
{
  "success": true,
  "key": "app-456/user-123/1699564800000-1234567890-large-video.mp4",
  "size": 52428800,
  "contentType": "video/mp4",
  "etag": "abc123..."
}
```

### 4. Delete File
```bash
KEY="app-456/user-123/1699564800000-1234567890-large-video.mp4"

curl -X DELETE "http://localhost:8787/upload?key=$KEY" \
  -H "Authorization: Bearer $JWT"

# Response
{
  "success": true
}
```

### 5. Abort Upload (Cancel)
```bash
curl -X POST http://localhost:8787/upload/multipart/abort \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "abc123def456...",
    "key": "app-456/user-123/1699564800000-1234567890-large-video.mp4"
  }'

# Response
{
  "success": true
}
```

---

## Troubleshooting

### 401 Unauthorized
- Check JWT_SECRET matches between this worker and IAM worker
- Verify token is not expired
- Verify token has valid `sub` and `app_id` claims

### 403 Forbidden
- File key doesn't start with `${appId}/${userId}/`
- You're trying to delete/access another user's file
- Use admin token (role: 'admin') to override

### 429 Too Many Requests
- You've exceeded 15 requests/minute on `/upload/multipart/create`
- Wait 60 seconds before retrying

### 500 Server Error
- Check R2 bucket connectivity
- Verify `MY_BUCKET` binding is configured in wrangler.jsonc
- Check Cloudflare dashboard logs

---

## Performance Tips

1. **Parallel Uploads**: Use multipart for large files
2. **Chunk Size**: Recommended 5-10MB per part
3. **Retry Logic**: Implement exponential backoff on failures
4. **Caching**: File URLs are static, cache aggressively
5. **Bandwidth**: Use R2's automatic edge caching

---

## Security Checklist

✅ JWT_SECRET is > 32 characters
✅ JWT_SECRET is identical to IAM Worker
✅ Only your IAM Worker can issue tokens
✅ File ownership is always verified
✅ Admin role is not assigned casually
✅ Enable logging for audit trail
✅ Monitor rate limit violations

