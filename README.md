# POS Admin — bản gộp (single Express app)

Bản gộp của `pos-admin` (backend Fastify + frontend React + packages/shared) thành
**một ứng dụng Express duy nhất**, server-rendered EJS, SQLite tự chứa — giống cách
`sales_web` hoạt động. Chạy `npm start` là lên, không cần Postgres.

> Đây là **phương án B** đã chốt với Sếp: gộp FE+BE về một process, **giữ nguyên**
> Sync API contract + logic tài chính + auth để app POS Android (`../sunmi-pos-tester`)
> vẫn ghép vào được sau này.

---

## 1. Chạy nhanh

```bash
cd "pos-admin-web"
npm install


npx prisma generate
npx prisma db push          # tạo data/pos.db (SQLite, 9 bảng)
npm run seed                # tạo Quản lý "Quản lý"/PIN 1234 + data demo
npm start                   # http://localhost:3100
```

Đăng nhập tại `/login` bằng **Quản lý / PIN 1234**.


---

## 2. Kiến trúc bản gộp

```
pos-admin-web/
├── src/
│   ├── server.ts            1 Express app: /api/sync/* (POS) + trang admin (EJS)
│   ├── config.ts            cấu hình (mặc định local-friendly)
│   ├── db.ts                PrismaClient, default DATABASE_URL = file:./data/pos.db
│   ├── shared/              GIỮ NGUYÊN từ packages/shared (khớp Android)
│   │   ├── money.ts             quy tắc VND HALF_UP (1:1 với Money.kt)
│   │   ├── discount.ts          1:1 với DiscountCalculator.kt
│   │   ├── types.ts             hợp đồng sync
│   │   └── money-vectors.json   test vector CHUNG với Kotlin
│   ├── lib/                 GIỮ NGUYÊN (chỉ đổi Fastify req/res -> Express)
│   │   ├── order-validator.ts   kiểm lại mọi con số tiền, từ chối nếu sai
│   │   ├── pin-hasher.ts        PBKDF2-HMAC-SHA256 120k (khớp Android)
│   │   └── device-auth.ts       token thiết bị (SHA-256, do quản lý tự đặt)
│   ├── sync/routes.ts       Sync API — CONTRACT GIỮ NGUYÊN (push/pull)
│   └── admin/
│       ├── routes.ts        trang quản trị (server-rendered, form POST)
│       └── session.ts       session Quản lý (express-session, re-check mỗi request)
├── views/*.ejs              login, reports, orders, shifts, products, campaigns,
│                            staff, devices, audit + partials
├── prisma/schema.prisma     SQLite (enum -> String, còn lại giữ nguyên)
├── test/*.test.mjs          59 test (money/validator/pin) — 59/59 PASS
```

---

## 3. Những gì GIỮ NGUYÊN (financial-grade — không đổi hành vi)

| Thành phần | Vì sao không được đổi |
|---|---|
| **Sync API** `/api/sync/push`, `/api/sync/pull` | App POS Android gọi đúng path/header/JSON này. Đã verify pull trả đúng `SyncPullResponse`. |
| **Auth thiết bị** (Bearer token do quản lý tự đặt, hash SHA-256) | Contract xác thực với máy POS. **Đã đơn giản hoá**: bỏ `X-Device-Id`, token là định danh duy nhất; xem mục 4. |
| **PIN PBKDF2** 120k iterations, SHA-256, salt 16B | PIN đặt trên web phải verify được offline trên Android. |
| **order-validator** | Tính lại mọi con số tiền, từ chối nếu lệch — không tự sửa. |
| **money.ts / discount.ts** | Single source of truth, khớp Kotlin qua `money-vectors.json`. |

## 4. Những gì ĐÃ ĐỔI (chỉ là "gộp", không đổi nghiệp vụ)

| Từ (`pos-admin`) | Thành (bản gộp) |
|---|---|
| 2 project (Fastify backend + React frontend) | 1 app Express |
| React SPA + JSON API | EJS render server-side + form POST |
| Postgres + Prisma | **SQLite** + Prisma (`file:./data/pos.db`) |
| enum Prisma | `String` (giá trị y hệt: 'MANAGER', 'CASH'...) — SQLite không có enum |
| session in-memory Map (Fastify) | express-session cookie (vẫn re-check row staff mỗi request) |

### 4.1. Auth thiết bị — ĐÃ ĐƠN GIẢN HOÁ (chốt với Sếp)

> Yêu cầu: "không cần token phức tạp; trên web cho phép nhập token do người dùng đặt,
> máy POS dùng token đó để nói chuyện với server."

| | Trước | Sau |
|---|---|---|
| Nguồn token | Server sinh 32-byte ngẫu nhiên, hiện 1 lần | **Quản lý tự nhập** ở form `/devices` (tối thiểu 12 ký tự) |
| Định danh máy | `deviceId` (UUID) + header `X-Device-Id` | **Bỏ hẳn** — token là định danh duy nhất |
| Lưu token | Argon2id hash | **SHA-256 hash** (`tokenHash` UNIQUE) — tra cứu trực tiếp, không lưu token gốc |
| Máy POS gửi | `Bearer <token>` + `X-Device-Id` | Chỉ `Authorization: Bearer <token>` |

- `requireDevice` (trong `src/lib/device-auth.ts`) đọc Bearer token → SHA-256 → lookup `Device` theo `tokenHash`. Mọi lỗi trả 401 giống nhau.
- ⚠️ **Đánh đổi bảo mật (Sếp chấp nhận "vừa phải"):** SHA-256 của token người dùng đặt yếu hơn Argon2id-của-token-ngẫu-nhiên — brute-force được nếu DB lộ và token yếu. Chạy qua internet công cộng nên dùng **HTTPS** + cân nhắc token dài/ngẫu nhiên và review bảo mật độc lập.
- Tạo mã giảm giá (`/campaigns`) giờ chọn máy theo tên (id nội bộ), không còn deviceId.

## 5. Trạng thái verify (đã chạy thật)

- ✅ `npm install` (92 packages, argon2 native build OK trên Node 22.14)
- ✅ `prisma generate` + `db push` → `data/pos.db`
- ✅ **59/59 test PASS** (money 17 · order-validator 33 · pin-hasher 9)
- ✅ `npm run seed` → 1 Quản lý + 4 món + 1 máy POS + 1 ca đóng + 2 đơn
- ✅ HTTP: `/health` 200 · `/login` 200 · `/reports` chưa auth → 302 · sync pull chưa auth → 401
- ✅ **Sync pull với device token thật → 200**, response đúng `SyncPullResponse`
- ✅ Login flow: đúng PIN → 302 + cookie → `/reports` 200; sai PIN → 401

## 6. Giới hạn còn lại (không đổi so với bản gốc)

- Thanh toán ở máy POS vẫn MOCK; tích hợp thật cần tuân PCI-DSS/SBV + review riêng.
- Chưa có VAT (quy tắc làm tròn thuế là vấn đề pháp lý).
- Session lưu RAM → restart là đăng xuất. Chạy nhiều process phải chuyển store sang SQLite/Redis.
- ⚠️ App POS Android (`../sunmi-pos-tester`) **đã được bổ sung sync client** (pull/push, auth token, discount code, Money/DiscountCalculator khớp `money-vectors.json`) nhưng **chưa compile lần nào** (máy dev không có Android SDK). Sync đã verify ở phía server bằng token thật (`quay1-demo-token-123456` sau khi seed); luồng đầy đủ với thiết bị thật vẫn cần build APK và kiểm trên máy.
```
```
"# pos-admin" 
