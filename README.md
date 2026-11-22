# Upload Worker

Dùng access token IAM với `Authorization: Bearer <token>`. Worker lấy `app_id` và `sub` từ token đã xác thực và lưu file dưới prefix tương ứng. Token phải có `aud` bằng `app_id`. Mỗi app dùng token do IAM cấp cho app đó.

## Cấu hình

Đặt `IAM_ISSUER` khớp claim `iss` của IAM. Với IAM RS256, đặt `IAM_JWT_PUBLIC_KEY` thành PEM public key. Với IAM HS256, đặt `JWT_SECRET` bằng secret ký của IAM thông qua Wrangler secret. Mỗi môi trường dùng một chế độ xác thực. Khi dùng PEM có thể nhập giá trị nhiều dòng hoặc chuỗi chứa ký tự xuống dòng escaped. Đặt `PUBLIC_R2_DOMAIN` nếu bucket có domain public.

## Tích hợp Flutter và Web

Contract ở [openapi.json](openapi.json). SDK nhận access token từ callback của app, gửi binary trực tiếp với `X-Filename`, và chuyển sang multipart khi vượt 5 MiB. Khi dùng `FormData` với trình duyệt, đặt trường `file` và để trình duyệt tự tạo `Content-Type` có boundary.

| Hành động | API |
|---|---|
| File đến 5 MiB | `POST /upload/single` |
| Tạo upload đến 100 MiB | `POST /upload/multipart/create` với `filename`, `contentType`, `size` |
| Truyền part | `PUT /upload/multipart/upload-part?uploadId=…&key=…&partNumber=…` với body binary |
| Hoàn tất | `POST /upload/multipart/complete` với `uploadId`, `key`, `parts: [{partNumber, etag}]` |
| Hủy | `POST /upload/multipart/abort` với `uploadId`, `key` |
| Metadata / xóa | `GET /upload/info?key=…` / `DELETE /upload?key=…` |
| Health check | `GET /health` |

Đánh số part từ 1. Part có kích thước 5 MiB, riêng part cuối có thể nhỏ hơn. Giữ nguyên `etag` trong JSON trả về. Để resume, lưu `key`, `uploadId` và các part đã xác nhận cùng file gốc. Retry part với cùng số thứ tự và chỉ complete sau khi tất cả part thành công. Các multipart session tạo trước khi nâng cấp có thể cần upload lại nếu dùng part lớn hơn 5 MiB.

Rate limit tại mỗi Cloudflare location. Mốc khởi điểm mỗi phút là 600 request/app, thêm 30 create/single, 120 upload part và 120 quản lý cho mỗi user trong app. `429` trả `Retry-After` và Web có thể đọc header. `url` chỉ có khi cấu hình domain public. Nếu cần private download, cần thêm API riêng.

Dùng [client TypeScript cho Web](sdk/web/upload.ts) hoặc [package Dart cho Flutter](sdk/flutter). Cả hai nhận callback cấp access token, tự chọn single/multipart và hỗ trợ callback checkpoint để lưu phiên. Pass lại checkpoint cùng file gốc để resume hoặc gọi `abort` để hủy. Các client trả mã lỗi và `retryAfter` cho app quyết định lịch retry. Flutter hiện nhận `Uint8List` nên app cần nạp file vào bộ nhớ.
