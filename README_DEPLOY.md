# Deploy Worldcup Pick tren Ubuntu VPS

Huong dan nay dung cho 1 VPS Ubuntu 22.04/24.04, chay Node app + MongoDB localhost + Nginx reverse proxy.

## 1. Chuan bi VPS

Dang nhap VPS:

```bash
ssh root@YOUR_SERVER_IP
```

Cap nhat package:

```bash
apt update && apt upgrade -y
apt install -y curl git ufw nginx
```

Mo firewall:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
ufw status
```

## 2. Cai Node.js

Cai Node.js LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
npm -v
```

## 3. Cai MongoDB

Cai MongoDB Community:

```bash
apt install -y gnupg
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update
apt install -y mongodb-org
systemctl enable mongod
systemctl start mongod
systemctl status mongod
```

Neu VPS la Ubuntu 22.04, doi `noble` thanh `jammy` trong dong repo MongoDB.

Kiem tra Mongo:

```bash
mongosh --eval 'db.runCommand({ ping: 1 })'
```

Khong mo port MongoDB ra internet. App dung `mongodb://127.0.0.1:27017`.

## 4. Dua source len server

Tao thu muc app:

```bash
mkdir -p /var/www/worldcup-pick
cd /var/www/worldcup-pick
```

Neu co Git repo:

```bash
git clone YOUR_REPO_URL .
```

Neu upload source thu cong, copy toan bo folder project vao `/var/www/worldcup-pick`.

Set owner:

```bash
chown -R root:root /var/www/worldcup-pick
```

## 5. Cai dependency

```bash
cd /var/www/worldcup-pick
npm install
npm run build
```

## 6. Tao file .env

```bash
cp .env.example .env
nano .env
```

Config khuyen dung:

```env
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=worldcup_prediction
TOKEN_SECRET=CHANGE_TO_LONG_RANDOM_SECRET
TOKEN_TTL_SECONDS=7200
ESPN_SYNC_ENABLED=true

PREDICTION_HISTORY_DAYS=180
WALLET_HISTORY_DAYS=180
MATCH_HISTORY_DAYS=7
CHAT_HISTORY_DAYS=30
NOTIFICATION_HISTORY_DAYS=30
LEADERBOARD_HISTORY_DAYS=30
MAX_PREDICTIONS_PER_USER=30
MAX_SETTLED_PREDICTIONS=1000
MAX_WALLET_TRANSACTIONS=2000
MAX_CHAT_MESSAGES=500
MAX_NOTIFICATIONS=300
MAX_LEADERBOARD_HISTORY=300
```

Tao secret:

```bash
openssl rand -hex 32
```

Doi `TOKEN_SECRET` bang chuoi vua tao.

## 7. Test app bang tay

```bash
cd /var/www/worldcup-pick
npm run build
npm start
```

Mo terminal khac test:

```bash
curl http://127.0.0.1:3000/
```

Neu OK, bam `Ctrl+C` de tat app.

## 8. Chay app bang PM2

Tai PM2:

```bash
npm install -g pm2
```

Chay app:

```bash
cd /var/www/worldcup-pick
npm run build
pm2 start server.js --name worldcup-pick --time
```

```bash
pm2 save
pm2 startup systemd -u root --hp /root
```

PM2 se in ra 1 lenh khac. Copy va chay lenh do 1 lan.

Xem trang thai:

```bash
pm2 status
pm2 logs worldcup-pick
```

## 9. Cau hinh Nginx

Tao config:

```bash
nano /etc/nginx/sites-available/worldcup-pick
```

Neu co domain `cloud-manager.cloud`, dung thang:

```nginx
server {
    listen 80;
    server_name cloud-manager.cloud www.cloud-manager.cloud;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

Bat site:

```bash
ln -s /etc/nginx/sites-available/worldcup-pick /etc/nginx/sites-enabled/worldcup-pick
nginx -t
systemctl reload nginx
```

Mo trinh duyet:

```text
http://cloud-manager.cloud
```

Neu chua co domain, co the tam thoi dung IP:

```nginx
server_name YOUR_SERVER_IP;
```

## 10. Cai HTTPS

Tro DNS domain ve IP VPS truoc.

Cai Certbot:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d cloud-manager.cloud -d www.cloud-manager.cloud
```

Test auto renew:

```bash
certbot renew --dry-run
```

## 11. Tai khoan demo

Mac dinh app se seed:

```text
Admin:
Email: admin@demo.local
Password: Admin123!

User demo:
Email: demo@demo.local
Password: Demo12345
```

Sau deploy nen doi mat khau admin bang cach tao admin moi trong app, promote admin moi, roi khoa/xoa tai khoan demo neu can.

## 12. Backup MongoDB

Tao thu muc backup:

```bash
mkdir -p /var/backups/worldcup-pick
```

Backup tay:

```bash
mongodump --db worldcup_prediction --out /var/backups/worldcup-pick/$(date +%F)
```

Restore:

```bash
mongorestore --drop --db worldcup_prediction /var/backups/worldcup-pick/YYYY-MM-DD/worldcup_prediction
```

Cron backup hang ngay 3h sang:

```bash
crontab -e
```

Them:

```cron
0 3 * * * mongodump --db worldcup_prediction --out /var/backups/worldcup-pick/$(date +\%F) >/dev/null 2>&1
30 3 * * * find /var/backups/worldcup-pick -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} \; >/dev/null 2>&1
```

## 13. Update code

```bash
cd /var/www/worldcup-pick
git pull
npm install
npm run build
pm2 restart worldcup-pick
pm2 logs worldcup-pick --lines 80
```

Neu upload tay, thay buoc `git pull` bang viec copy source moi len server.

## 14. Lenh van hanh nhanh

Trang thai app:

```bash
pm2 status
```

Restart app:

```bash
pm2 restart worldcup-pick
```

Xem log app:

```bash
pm2 logs worldcup-pick
```

Trang thai Mongo:

```bash
systemctl status mongod
```

Trang thai Nginx:

```bash
systemctl status nginx
```

Check port:

```bash
ss -lntp
```

## 15. Ghi chu bao mat

- Khong commit `.env`.
- Doi `TOKEN_SECRET` tren production.
- Chi mo port `22`, `80`, `443`.
- Khong mo MongoDB port `27017` ra internet.
- Dung HTTPS khi co domain.
- Backup DB dinh ky.
- Token app song 2 gio theo `TOKEN_TTL_SECONDS=7200`.
