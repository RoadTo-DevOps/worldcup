# Tài Liệu Yêu Cầu Phát Triển Website Dự Đoán Bóng Đá Vui Với Bạn Bè

## 1. Mục tiêu dự án
Xây dựng website dự đoán kết quả bóng đá dùng nội bộ cho bạn bè giải trí.

Lưu ý:
- Không sử dụng tiền thật.
- Không tích hợp thanh toán online.
- Hệ thống sử dụng điểm ảo (virtual points) để giải trí.
- Điểm chỉ dùng trong website.
- Không quy đổi điểm thành tiền thật.
- Admin sẽ tự cộng/trừ điểm thủ công cho user.
- Có leaderboard để tạo tính cạnh tranh vui vẻ giữa bạn bè.

API dữ liệu sử dụng:
- ESPN Public API
- Repo tham khảo: https://github.com/pseudo-r/Public-ESPN-API

---

# 2. Chức năng chính

## 2.1 Authentication

### Đăng ký
- Username
- Email
- Password
- Avatar optional

### Đăng nhập
- JWT Authentication
- Remember login

### Profile User
- Avatar
- Tổng điểm
- Lịch sử dự đoán
- Rank hiện tại

---

# 3. Trang chủ

## Hiển thị:
- Các trận đấu sắp diễn ra
- Tỷ số trực tiếp
- Trận hot
- BXH người chơi
- Top dự đoán đúng

Có filter:
- Theo giải đấu
- Theo ngày
- Theo trạng thái

---

# 4. Hệ thống Ví Điểm (Wallet System)

## Mỗi user có:
- Ví điểm cá nhân
- Lịch sử cộng/trừ điểm
- Tổng điểm hiện tại

## Admin có thể:
- Add điểm thủ công
- Trừ điểm thủ công
- Reset ví
- Xem lịch sử giao dịch

## Không có:
- Thanh toán online
- Nạp tiền thật
- Rút tiền thật
- Chuyển đổi tiền mặt

---

# 5. Dự đoán trận đấu

## User có thể:
- Đặt cược bằng điểm ảo
- Nhập số điểm muốn cược
- Chọn đội thắng
- Dự đoán tỷ số
- Dự đoán cầu thủ ghi bàn đầu tiên (optional)
- Dự đoán trước giờ kickoff

## Sau khi trận kết thúc:
### Hệ thống tính thưởng:

Ví dụ:
- User cược: 100 điểm
- Đúng đội thắng: nhận x1.5
- Đúng tỷ số chính xác: nhận x2
- Sai hoàn toàn: mất điểm cược
- Hòa đúng: nhận x1.8

Có thể config point trong admin.

---

# 6. Leaderboard

## Bảng xếp hạng:
- Theo tuần
- Theo tháng
- All time

Hiển thị:
- Rank
- Username
- Total points
- Accuracy %
- Số trận dự đoán

---

# 7. Match Data

## Lấy dữ liệu từ ESPN API

Cần lấy:
- Danh sách trận đấu
- Đội bóng
- Giải đấu
- Tỷ số realtime
- Trạng thái trận đấu
- Thời gian kickoff

## Các giải đấu hỗ trợ:
- Premier League
- Champions League
- La Liga
- Serie A
- Bundesliga
- Euro
- World Cup

---

# 8. Admin Panel

## Admin có thể:
- Quản lý user
- Add/trừ điểm user
- Xem lịch sử cược
- Ban user
- Reset điểm
- Config point system
- Chọn giải đấu hiển thị
- Force sync dữ liệu API
- Quản lý banner/trang chủ

---

# 8. Notification

## Thông báo:
- Trận sắp bắt đầu
- Kết quả dự đoán
- Rank thay đổi
- Có trận mới

Có thể:
- Web notification
- Email optional

---

# 9. Realtime

## Dùng websocket/socket.io

Realtime update:
- Tỷ số trận đấu
- Bảng xếp hạng
- Người đang online
- Chat room

---

# 10. Chat Room

## Có room chat theo trận:
- Spam protection
- Emoji support
- Reply message
- Delete message admin

---

# 11. Công nghệ đề xuất

## Frontend
- ReactJS hoặc NextJS
- TailwindCSS
- Axios
- Socket.IO Client

## Backend
- NodeJS + Express
HOẶC
- NestJS

## Database
- MongoDB

## Cache
- Redis

## Realtime
- Socket.IO

## Deploy
- Frontend: Vercel / CloudFront + S3
- Backend: EC2 / Railway / Render
- Database: Neon / Supabase / RDS / MongoDB atlas

---

# 12. Database Design

## users

```sql
id
username
email
password_hash
avatar
role
points
wallet_balance
created_at
```

## matches

```sql
id
espn_match_id
home_team
away_team
home_score
away_score
status
kickoff_time
league
created_at
```

## predictions

```sql
id
user_id
match_id
bet_points
predicted_home_score
predicted_away_score
reward_points
created_at
```

## wallet_transactions

```sql
id
user_id
type
amount
balance_after
note
created_by_admin
created_at
```

## leaderboard_history

```sql
id
user_id
rank
points
snapshot_date
```

## chat_messages

```sql
id
user_id
match_id
message
created_at
```

---

# 13. API Backend Cần Làm

## Auth

```http
POST /api/auth/register
POST /api/auth/login
GET /api/auth/me
```

## Matches

```http
GET /api/matches
GET /api/matches/:id
GET /api/matches/live
```

## Wallet

```http
GET /api/wallet
GET /api/wallet/history
```

## Predictions

```http
POST /api/predictions
GET /api/predictions/me
```

## Leaderboard

```http
GET /api/leaderboard
```

## Chat

```http
GET /api/chat/:matchId
POST /api/chat/send
```

---

# 14. ESPN API Integration

## Service Layer

Tạo service riêng:

```txt
/services/espnService.js
```

## Chức năng:
- Fetch fixtures
- Fetch live scores
- Fetch standings
- Sync matches vào DB
- Cron update score

## Cron jobs:
- Update live score mỗi 30s
- Sync fixture mỗi 6h

---

# 15. UI/UX Mong Muốn

## Theme:
- Dark mode
- Modern football style
- Responsive mobile
- Animation nhẹ

## Trang:
- Home
- Match Detail
- Leaderboard
- Profile
- Login/Register
- Admin Dashboard

---

# 16. Security

## Bắt buộc:
- Hash password bcrypt
- JWT expiration
- Rate limit API
- Validate input
- XSS protection
- SQL injection protection
- Helmet middleware

---

# 17. Tính năng nâng cao (Optional)

## Có thể thêm:
- Fantasy mini game
- Daily mission
- Achievement system
- Clan/team system
- Prediction streak
- AI match prediction
- Livestream embed

---

# 18. Flow Hoạt Động

## User Flow

1. User đăng ký
2. Login
3. Chọn trận đấu
4. Nhập dự đoán
5. Hệ thống khóa dự đoán trước kickoff
6. ESPN API cập nhật kết quả
7. System tự chấm điểm
8. Update leaderboard realtime

---

# 19. Yêu cầu code

## Coding convention
- Clean architecture
- Service + Controller pattern
- Env config
- Error handler middleware
- Logging
- API response standard

Ví dụ response:

```json
{
  "success": true,
  "message": "Prediction created",
  "data": {}
}
```

---

# 20. Mục tiêu MVP

## Version đầu tiên cần:

- Authentication
- Match list
- Prediction system
- Leaderboard
- ESPN API sync
- Responsive UI

Các tính năng khác làm sau.

---

# 21. Gợi ý cấu trúc thư mục Backend

```txt
src/
 ├── controllers/
 ├── services/
 ├── routes/
 ├── middlewares/
 ├── models/
 ├── utils/
 ├── cron/
 ├── sockets/
 ├── config/
 └── app.js
```

---

# 22. Gợi ý cấu trúc Frontend

```txt
src/
 ├── pages/
 ├── components/
 ├── services/
 ├── hooks/
 ├── contexts/
 ├── layouts/
 ├── utils/
 └── styles/
```

---

# 23. Kết luận

Mục tiêu hệ thống:
- Website dự đoán bóng đá vui vẻ giữa bạn bè bằng điểm ảo.
- Có leaderboard tạo cạnh tranh.
- Dữ liệu trận đấu realtime từ ESPN API.
- Không liên quan tiền thật hoặc thanh toán.
- Ưu tiên realtime + trải nghiệm mobile.

