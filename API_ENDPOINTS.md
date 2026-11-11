# Upload Worker API Endpoints

## Authentication
All `/upload/*` endpoints require JWT Bearer token in `Authorization` header:
```
Authorization: Bearer <JWT_TOKEN>
```

JWT payload must contain:
- `sub`: User ID
- `app_id`: Application ID
- `exp`: Token expiration timestamp
- `role`: (optional) User role (e.g., 'admin' for unrestricted delete)

---

## Endpoints

### 1. Health Checks (No Auth Required)
```
GET /
GET /health
```

---

### 2. Multipart Upload (Large Files)

#### Create Upload Session
```
POST /upload/multipart/create
Authorization: Bearer <token>
Content-Type: application/json

{
  "filename": "document.pdf",
  "contentType": "application/pdf",
  "size": 52428800
}
```

Response:
```json
{
  "success": true,
  "uploadId": "abc123...",
  "key": "app_id/user_id/1699564800000-12345-document.pdf"
}
```

#### Upload Part
```
PUT /upload/multipart/upload-part?uploadId=<uploadId>&key=<key>&partNumber=1
Authorization: Bearer <token>
Content-Type: application/octet-stream

[binary chunk data]
```

Response:
```json
{
  "success": true,
  "partNumber": 1,
  "etag": "abc123defg..."
}
```

#### Complete Upload
```
POST /upload/multipart/complete
Authorization: Bearer <token>
Content-Type: application/json

{
  "uploadId": "abc123...",
  "key": "app_id/user_id/1699564800000-12345-document.pdf",
  "parts": [
    { "partNumber": 1, "etag": "etag1" },
    { "partNumber": 2, "etag": "etag2" }
  ]
}
```

Response:
```json
{
  "success": true,
  "key": "app_id/user_id/1699564800000-12345-document.pdf",
  "url": "https://vntez-bucket.r2.dev/app_id/user_id/1699564800000-12345-document.pdf"
}
```

#### Abort Upload
```
POST /upload/multipart/abort
Authorization: Bearer <token>
Content-Type: application/json

{
  "uploadId": "abc123...",
  "key": "app_id/user_id/1699564800000-12345-document.pdf"
}
```

---

### 3. Single File Upload (< 5MB)

#### Option A: Multipart Form Data
```
POST /upload/single
Authorization: Bearer <token>
Content-Type: multipart/form-data

[form with 'file' field]
```

#### Option B: Raw Binary
```
POST /upload/single
Authorization: Bearer <token>
Content-Type: application/pdf
X-Filename: document.pdf

[binary file data]
```

Response:
```json
{
  "success": true,
  "key": "app_id/user_id/1699564800000-12345-document.pdf",
  "url": "https://vntez-bucket.r2.dev/app_id/user_id/1699564800000-12345-document.pdf",
  "size": 1024000
}
```

---

### 4. File Management

#### Get File Info
```
GET /upload/info?key=app_id/user_id/1699564800000-12345-document.pdf
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "key": "app_id/user_id/1699564800000-12345-document.pdf",
  "size": 1024000,
  "contentType": "application/pdf",
  "etag": "abc123..."
}
```

#### Delete File
```
DELETE /upload?key=app_id/user_id/1699564800000-12345-document.pdf
Authorization: Bearer <token>
```

Or with body:
```
DELETE /upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "key": "app_id/user_id/1699564800000-12345-document.pdf"
}
```

Response:
```json
{
  "success": true
}
```

---

## Security Features

✅ **JWT Stateless Authentication** - No database queries for auth
✅ **Rate Limiting** - 15 requests/minute per IP on `/upload/multipart/create`
✅ **User Isolation** - Users can only access their own files (`${appId}/${userId}/` prefix)
✅ **Admin Override** - Admin users (role: 'admin') can delete any file
✅ **File Size Validation**:
  - Multipart: Max 100MB
  - Single upload: Max 5MB
✅ **Filename Sanitization** - Prevents path traversal attacks
✅ **CORS Support** - All endpoints CORS-enabled

---

## Error Responses

| Code | Scenario |
|------|----------|
| 400 | Bad request (missing fields, invalid params) |
| 401 | Missing/invalid JWT token |
| 403 | Unauthorized (file not owned by user) |
| 404 | File not found |
| 429 | Rate limit exceeded |
| 500 | Server error |
