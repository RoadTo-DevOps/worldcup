# Worldcup Prediction MVP

MVP website du doan bong da vui voi ban be, chi dung diem ao.

Included:

- Auth bang token JWT-style HMAC
- Wallet diem ao + transaction history
- Match list/live/upcoming filter
- ESPN public scoreboard sync, fallback demo fixtures neu ESPN fail
- Prediction truoc kickoff, settle reward theo config
- Leaderboard all-time/week/month
- Chat room theo match
- Admin user/point/config/sync panel
- SSE realtime refresh cho match, wallet, leaderboard, chat

Run:

```bash
npm start
```

Open:

```txt
http://localhost:3000
```

Default admin:

- Email: `admin@demo.local`
- Password: `Admin123!`

Default demo user:

- Email: `demo@demo.local`
- Password: `Demo12345`

Runtime data is stored in `data/db.json` and ignored by git. Delete that file to reset local state.
