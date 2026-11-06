# Upload Worker (Cloudflare Workers + R2)

Microservice chạy trên Cloudflare Workers sử dụng **Hono** và **AWS S3 SDK** để sinh S3 Presigned URLs và điều phối upload file trực tiếp lên Cloudflare R2 (cả Single PUT lẫn Multipart Upload cho file lớn).

- **Production Worker URL**: `https://upload.hnamhocit.workers.dev`
- **Target R2 Bucket**: `vntez-bucket`

---

## 🚀 Tính năng chính & Điểm chuẩn hóa

1. **Chuẩn hóa cấu hình & Bí mật (Secrets)**:
   - Tự động fallback linh hoạt giữa các quy ước đặt tên: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` và `R2_ACCESS_KEY` / `R2_ACCESS_SECRET`.
   - Lưu trữ bí mật bảo mật trên Cloudflare qua `wrangler secret bulk`, không lộ credentials trong `wrangler.jsonc` hay source code.
2. **Khắc phục tương thích workerd runtime (`DOMParser / Node`)**:
   - Tích hợp `@xmldom/xmldom` polyfill để giải quyết triệt để lỗi `DOMParser is not defined` và `Node is not defined` khi AWS S3 SDK giải mã XML response (như `InitiateMultipartUploadResult`, `CompleteMultipartUploadResult`) trong môi trường Cloudflare Workers.
3. **Bảo mật đường dẫn lưu trữ**:
   - Tự động làm sạch tên file (`sanitizedFilename`), loại bỏ ký tự lạ và path traversal (`../`, `\`...).
   - Hỗ trợ phân quyền folder theo user ID an toàn: `uploads/{userId}/{uuid}-{filename}`.
4. **CORS toàn diện**:
   - Hỗ trợ Uppy, browser fetch, Axios từ mọi domain với expose headers (`ETag`, `Content-Length`) cần thiết cho S3 Multipart Upload.
5. **Cấp Presigned GET URL**:
   - Bổ sung endpoint `/api/upload/signed-download-url` cho phép tạo signed URL tải/xem trước dữ liệu bảo mật khi R2 bucket không bật public dev-url.

---

## 📡 API Reference

### 1. Healthcheck
- **`GET /`** hoặc **`GET /health`**
- Response:
```json
{
  "status": "ok",
  "service": "edge-upload-worker",
  "timestamp": "2026-10-29T04:09:02.402Z"
}
```

---

### 2. File nhỏ: Cấp Presigned PUT URL (< 10MB)
- **Endpoint**: `POST /api/upload/single`
- **Body**:
```json
{
  "filename": "avatar.png",
  "type": "image/png",
  "userId": "user_123",
  "folder": "uploads"
}
```
- **Response**:
```json
{
  "url": "https://vntez-bucket.<account_id>.r2.cloudflarestorage.com/uploads/user_123/uuid-avatar.png?X-Amz-...",
  "method": "PUT",
  "key": "uploads/user_123/uuid-avatar.png",
  "location": "https://vntez-bucket.r2.dev/uploads/user_123/uuid-avatar.png"
}
```

Client upload trực tiếp:
```bash
curl -X PUT --data-binary @avatar.png -H "Content-Type: image/png" "<url>"
```

---

### 3. File lớn: Khởi tạo Multipart Upload (>= 10MB)
- **Endpoint**: `POST /api/upload/multipart`
- **Body**:
```json
{
  "filename": "large-video.mp4",
  "type": "video/mp4",
  "userId": "user_123"
}
```
- **Response**:
```json
{
  "uploadId": "string",
  "key": "uploads/user_123/uuid-large-video.mp4"
}
```

---

### 4. Ký URL danh sách Part
- **Endpoint**: `POST /api/upload/multipart/batch-sign-parts`
- **Body**:
```json
{
  "key": "uploads/user_123/uuid-large-video.mp4",
  "uploadId": "string",
  "partNumbers": [1, 2, 3]
}
```
- **Response**:
```json
{
  "presignedUrls": {
    "1": "https://...",
    "2": "https://...",
    "3": "https://..."
  }
}
```

---

### 5. Hoàn tất Multipart Upload
- **Endpoint**: `POST /api/upload/multipart/complete`
- **Body**:
```json
{
  "key": "uploads/user_123/uuid-large-video.mp4",
  "uploadId": "string",
  "parts": [
    { "PartNumber": 1, "ETag": "5f363e0e58a95f06cbe9bbc662c5dfb6" },
    { "PartNumber": 2, "ETag": "e1a903260c679a6136d80ff44e112461" }
  ]
}
```
- **Response**:
```json
{
  "success": true,
  "key": "uploads/user_123/uuid-large-video.mp4",
  "location": "https://vntez-bucket.r2.dev/uploads/user_123/uuid-large-video.mp4"
}
```

---

### 6. Hủy Multipart Upload dở dang
- **Endpoint**: `POST /api/upload/multipart/abort`
- **Body**:
```json
{
  "key": "uploads/user_123/uuid-large-video.mp4",
  "uploadId": "string"
}
```
- **Response**:
```json
{
  "aborted": true
}
```

---

### 7. Tạo Presigned GET URL (Tải / Xem file bảo mật)
- **Endpoint**: `POST /api/upload/signed-download-url`
- **Body**:
```json
{
  "key": "uploads/user_123/uuid-avatar.png",
  "expiresIn": 3600
}
```
- **Response**:
```json
{
  "success": true,
  "downloadUrl": "https://vntez-bucket.<account_id>.r2.cloudflarestorage.com/uploads/...",
  "key": "uploads/user_123/uuid-avatar.png",
  "expiresIn": 3600
}
```

---

## 🛠 Hướng dẫn phát triển & Triển khai

### Cài đặt dependencies:
```bash
bun install
# hoặc npm install
```

### Chạy local development:
```bash
bun run dev
# hoặc npm run dev
```

### Kiểm tra kiểu TypeScript:
```bash
bun run typecheck
```

### Đồng bộ Cloudflare types:
```bash
bun run cf-typegen
```

### Deploy lên Cloudflare Workers:
```bash
bun run deploy
# hoặc npm run deploy
```

### Cấu hình Secrets cho Worker (chỉ cần chạy khi đổi key):
Tạo file json tạm chứa secret:
```bash
cat << 'EOF' > /tmp/secrets.json
{
  "R2_ACCESS_KEY_ID": "your_access_key",
  "R2_SECRET_ACCESS_KEY": "your_secret_key"
}
EOF
npx wrangler secret bulk /tmp/secrets.json
rm -f /tmp/secrets.json
```
