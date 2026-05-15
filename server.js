const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
require('./src/config/env');

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const {
  PUBLIC_DIR,
  DB_PATH,
  leagueCatalog,
  defaultSettings
} = require('./src/config');
const {
  loadDb,
  saveDb,
  nextId,
  ensureSeedValues
} = require('./src/store');
const {
  makePasswordRecord,
  verifyPasswordSync,
  toSafeUser,
  normalizeUsername,
  normalizeEmail,
  isValidEmail,
  isStrongPassword,
  buildAuthToken,
  verifyToken,
  parseAuthTokenFromRequest
} = require('./src/auth');
const {
  syncMatches,
  upsertMatches,
  isMatchLocked,
  matchOutcome,
  getMultiplier
} = require('./src/espn');

const PORT = Number(process.env.PORT || 3000);
const HEARTBEAT_MS = 25000;
const REFRESH_LIVE_MS = Math.max(10000, Number(process.env.ESPN_LIVE_SYNC_SECONDS || 30) * 1000);
const REFRESH_FIXTURES_MS = Math.max(60 * 60 * 1000, Number(process.env.ESPN_FIXTURE_SYNC_HOURS || 8) * 60 * 60 * 1000);
const FIXTURE_RANGE_DAYS = Math.max(0, Number(process.env.ESPN_FIXTURE_RANGE_DAYS || 100));
const ODDS_RANGE_DAYS = Math.max(0, Number(process.env.ESPN_ODDS_RANGE_DAYS || 20));
const LIVE_WINDOW_MINUTES = Math.max(15, Number(process.env.ESPN_LIVE_WINDOW_MINUTES || 180));

let db = null;

function buildFixtureOffsets(rangeDays) {
  const offsets = [];
  for (let i = 0; i <= rangeDays; i += 1) {
    offsets.push(i);
  }
  return offsets;
}

function shouldRunLiveSync() {
  if (!Array.isArray(db?.matches) || db.matches.length === 0) return false;
  const now = Date.now();
  const windowMs = LIVE_WINDOW_MINUTES * 60 * 1000;
  return db.matches.some((match) => {
    if (match?.isLive || String(match?.status) === 'in') return true;
    if (match?.isFinal || String(match?.status) === 'post') return false;
    const kickoff = new Date(match?.kickoffTime || 0).getTime();
    if (!Number.isFinite(kickoff)) return false;
    return Math.abs(kickoff - now) <= windowMs;
  });
}

function ensureSeedUsers() {
  if (Array.isArray(db.users) && db.users.length > 0) {
    return;
  }
  const now = new Date().toISOString();
  const existingAdmin = db.users.find((user) => user.email === 'admin@demo.local');
  if (!existingAdmin) {
    db.users.push({
      id: nextId(db, 'nextUserId'),
      username: 'Admin',
      email: 'admin@demo.local',
      passwordHash: makePasswordRecord('Admin123!'),
      avatar: '',
      role: 'admin',
      banned: false,
      points: 5000,
      walletBalance: 5000,
      createdAt: now,
      updatedAt: now,
      stats: { predictions: 0, correct: 0, exact: 0 }
    });
  }
  const existingDemo = db.users.find((user) => user.email === 'demo@demo.local');
  if (!existingDemo) {
    db.users.push({
      id: nextId(db, 'nextUserId'),
      username: 'Demo Player',
      email: 'demo@demo.local',
      passwordHash: makePasswordRecord('Demo12345'),
      avatar: '',
      role: 'user',
      banned: false,
      points: defaultSettings.initialBalance,
      walletBalance: defaultSettings.initialBalance,
      createdAt: now,
      updatedAt: now,
      stats: { predictions: 0, correct: 0, exact: 0 }
    });
  }
  void saveDb(db);
}

const streamClients = new Map();
const rateBuckets = new Map();
let publicSnapshot = {
  matches: [],
  leaderboard: [],
  notifications: []
};
let refreshBusy = false;

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload));
}

function allowApiRequest(req) {
  const ip = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const limit = 240;
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= limit;
}

function ok(res, message, data = {}) {
  sendJson(res, 200, { success: true, message, data });
}

function fail(res, statusCode, message, extra = {}) {
  sendJson(res, statusCode, { success: false, message, ...extra });
}

function currentUser(req) {
  const token = parseAuthTokenFromRequest(req) || req.urlToken || null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.users.find((user) => String(user.id) === String(payload.sub)) || null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    fail(res, 401, 'Unauthorized');
    return null;
  }
  if (user.banned) {
    fail(res, 403, 'User banned');
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    fail(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

function findUserByEmail(email) {
  return db.users.find((user) => user.email === normalizeEmail(email));
}

function findUserByLogin(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  const email = normalizeEmail(value);
  const username = normalizeUsername(value).toLowerCase();
  return db.users.find((user) => (
    user.email === email ||
    normalizeUsername(user.username).toLowerCase() === username
  ));
}

function findUserById(id) {
  return db.users.find((user) => String(user.id) === String(id));
}

function activeAdminCount() {
  return db.users.filter((user) => !user.banned && user.role === 'admin').length;
}

function deleteUserAccount(user) {
  const userId = String(user.id);
  const before = {
    users: db.users.length,
    predictions: db.predictions.length,
    walletTransactions: db.walletTransactions.length,
    chatMessages: db.chatMessages.length,
    notifications: db.notifications.length
  };
  db.users = db.users.filter((item) => String(item.id) !== userId);
  db.predictions = db.predictions.filter((item) => String(item.userId) !== userId);
  db.walletTransactions = db.walletTransactions.filter((item) => String(item.userId) !== userId);
  db.chatMessages = db.chatMessages.filter((item) => String(item.userId) !== userId);
  db.notifications = db.notifications.filter((item) => String(item.userId) !== userId);
  return {
    users: before.users - db.users.length,
    predictions: before.predictions - db.predictions.length,
    walletTransactions: before.walletTransactions - db.walletTransactions.length,
    chatMessages: before.chatMessages - db.chatMessages.length,
    notifications: before.notifications - db.notifications.length
  };
}

function serializeMatch(match, userId = null) {
  const userPredictions = userId
    ? db.predictions.filter((item) => String(item.userId) === String(userId) && String(item.matchId) === String(match.id))
    : [];
  return {
    ...match,
    markets: buildBetMarkets(match),
    userPrediction: userPredictions[0] || null,
    userPredictions,
    locked: isMatchLocked(match, db.settings)
  };
}

function buildBetMarkets(match) {
  return Array.isArray(match?.oddsMarkets) ? match.oddsMarkets : [];
}

function findMarketPick(match, marketKey, optionKey) {
  const markets = buildBetMarkets(match);
  const market = markets.find((item) => item.key === marketKey);
  if (!market || market.disabled) return null;
  const option = market.options.find((item) => item.key === optionKey);
  if (!option) return null;
  return { market, option };
}

function rankUsersByPoints(users) {
  return [...users]
    .filter((user) => !user.banned)
    .sort((a, b) => Number(b.points || 0) - Number(a.points || 0))
    .map((user, index) => ({
      rank: index + 1,
      ...toSafeUser(user)
    }));
}

function periodStart(period) {
  const now = new Date();
  if (period === 'week') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (period === 'month') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
}

function buildLeaderboard(period = 'all-time') {
  const start = periodStart(period);
  const totals = new Map();
  for (const user of db.users) {
    if (!user.banned) totals.set(String(user.id), 0);
  }
  if (start) {
    for (const tx of db.walletTransactions) {
      if (new Date(tx.createdAt) < start) continue;
      const current = totals.get(String(tx.userId));
      if (current === undefined) continue;
      totals.set(String(tx.userId), current + Number(tx.amount || 0));
    }
  }
  const source = db.users
    .filter((user) => !user.banned)
    .map((user) => {
      const predictions = db.predictions.filter((prediction) => String(prediction.userId) === String(user.id));
      const settled = predictions.filter((prediction) => prediction.status !== 'pending');
      const correct = settled.filter((prediction) => Number(prediction.rewardPoints || 0) > 0);
      const accuracy = settled.length ? Math.round((correct.length / settled.length) * 1000) / 10 : 0;
      const periodPoints = start ? totals.get(String(user.id)) || 0 : Number(user.points || 0);
      return {
        id: user.id,
        username: user.username,
        avatar: user.avatar || '',
        points: Number(user.points || 0),
        walletBalance: Number(user.walletBalance || 0),
        periodPoints,
        accuracy,
        predictions: settled.length,
        correctPredictions: correct.length
      };
    });

  source.sort((a, b) => {
    if (period === 'all-time') return b.points - a.points;
    if (b.periodPoints !== a.periodPoints) return b.periodPoints - a.periodPoints;
    return b.points - a.points;
  });

  return source.map((row, index) => ({
    rank: index + 1,
    ...row
  }));
}

function addTransaction({ userId, type, amount, note, createdByAdmin, relatedId = null }) {
  const user = findUserById(userId);
  if (!user) return null;
  const nextBalance = Number(user.points || 0) + Number(amount || 0);
  user.points = Math.max(0, Math.round(nextBalance));
  user.walletBalance = user.points;
  user.updatedAt = new Date().toISOString();
  const transaction = {
    id: nextId(db, 'nextTransactionId'),
    userId: user.id,
    type,
    amount: Number(amount || 0),
    balanceAfter: user.points,
    note: note || '',
    relatedId,
    createdByAdmin: createdByAdmin ? String(createdByAdmin) : null,
    createdAt: new Date().toISOString()
  };
  db.walletTransactions.push(transaction);
  return transaction;
}

function resetUserWallet(user, adminId) {
  const amount = -Number(user.points || 0);
  const transaction = {
    id: nextId(db, 'nextTransactionId'),
    userId: user.id,
    type: 'reset',
    amount,
    balanceAfter: 0,
    note: 'Wallet reset by admin',
    relatedId: null,
    createdByAdmin: String(adminId),
    createdAt: new Date().toISOString()
  };
  user.points = 0;
  user.walletBalance = 0;
  user.updatedAt = new Date().toISOString();
  db.walletTransactions.push(transaction);
  return transaction;
}

function settlePredictionAdmin(prediction, outcome, adminId) {
  if (!prediction || prediction.status !== 'pending') return null;
  const settledAt = new Date().toISOString();
  const betPoints = Number(prediction.betPoints || 0);
  const odds = Number(prediction.market?.odds || 1);
  let rewardPoints = 0;
  let status = outcome;

  if (outcome === 'won') {
    rewardPoints = Math.round(betPoints * odds);
    addTransaction({
      userId: prediction.userId,
      type: 'reward',
      amount: rewardPoints,
      note: `Admin settled ${prediction.market?.title || 'bet'} as win`,
      createdByAdmin: adminId,
      relatedId: prediction.id
    });
  } else if (outcome === 'push') {
    rewardPoints = betPoints;
    addTransaction({
      userId: prediction.userId,
      type: 'push',
      amount: rewardPoints,
      note: `Admin settled ${prediction.market?.title || 'bet'} as push`,
      createdByAdmin: adminId,
      relatedId: prediction.id
    });
  } else if (outcome === 'lost') {
    rewardPoints = 0;
  } else {
    return null;
  }

  prediction.status = status;
  prediction.rewardPoints = rewardPoints;
  prediction.settledAt = settledAt;
  prediction.resultSummary = `Admin settled as ${status}`;
  notifyUser(prediction.userId, 'Bet settled', `Your bet was settled as ${status}.`, {
    type: 'prediction',
    predictionId: prediction.id
  });
  return prediction;
}

function notifyUser(userId, title, message, meta = {}) {
  const notification = {
    id: nextId(db, 'nextNotificationId'),
    userId: userId ? Number(userId) : null,
    type: meta.type || 'system',
    title,
    message,
    read: false,
    meta,
    createdAt: new Date().toISOString()
  };
  db.notifications.push(notification);
  return notification;
}

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, client] of streamClients.entries()) {
    try {
      client.res.write(payload);
    } catch {
      streamClients.delete(clientId);
    }
  }
}

function refreshPublicSnapshot() {
  publicSnapshot = {
    matches: db.matches.slice(0, 40).map((match) => serializeMatch(match)),
    leaderboard: buildLeaderboard('all-time').slice(0, 10),
    notifications: db.notifications
      .filter((notification) => notification.userId === null)
      .slice(-15)
      .reverse()
  };
}

function maybePersist() {
  void saveDb(db);
  refreshPublicSnapshot();
}

function formatError(error) {
  return error && error.message ? error.message : 'Server error';
}

async function syncFromEspn(mode = 'fixtures') {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const result = await syncMatches(
      db,
      mode === 'live'
        ? { fixtureDates: [0], oddsMaxDays: 1, allowDemo: false }
        : { fixtureDates: buildFixtureOffsets(FIXTURE_RANGE_DAYS), oddsMaxDays: ODDS_RANGE_DAYS, allowDemo: false }
    );
    const upserted = upsertMatches(db, result.matches);
    let settledCount = 0;
    for (const match of upserted) {
      if (String(match.status) !== 'post' && !match.isFinal) continue;
      const settled = settleMatchPredictions(match);
      settledCount += settled;
    }
    maybePersist();
    broadcast('matches.updated', {
      matches: db.matches.length,
      settledCount,
      errors: result.errors
    });
    return result;
  } finally {
    refreshBusy = false;
  }
}

function settleMatchPredictions(match) {
  const settings = db.settings || defaultSettings;
  const pending = db.predictions.filter((prediction) => String(prediction.matchId) === String(match.id) && prediction.status === 'pending');
  let settledCount = 0;
  for (const prediction of pending) {
    const result = settleBetMarket(match, prediction, settings);
    prediction.status = result.status;
    prediction.rewardPoints = result.status === 'lost' ? 0 : Math.round(Number(prediction.betPoints) * result.multiplier);
    prediction.settledAt = new Date().toISOString();
    prediction.resultSummary = `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`;
    if (prediction.rewardPoints > 0) {
      addTransaction({
        userId: prediction.userId,
        type: 'reward',
        amount: prediction.rewardPoints,
        note: `Prediction settled for match #${match.id}`,
        relatedId: prediction.id
      });
      const user = findUserById(prediction.userId);
      if (user) {
        user.stats ||= { predictions: 0, correct: 0, exact: 0 };
        user.stats.correct = Number(user.stats.correct || 0) + 1;
        if (result.exact) {
          user.stats.exact = Number(user.stats.exact || 0) + 1;
        }
        user.updatedAt = new Date().toISOString();
      }
      notifyUser(prediction.userId, 'Prediction settled', `Match #${match.id} paid ${prediction.rewardPoints} points.`, {
        type: 'prediction',
        matchId: match.id,
        predictionId: prediction.id
      });
    } else {
      const user = findUserById(prediction.userId);
      if (user) {
        user.stats ||= { predictions: 0, correct: 0, exact: 0 };
        user.updatedAt = new Date().toISOString();
      }
      notifyUser(prediction.userId, 'Prediction lost', `Match #${match.id} did not pay out.`, {
        type: 'prediction',
        matchId: match.id,
        predictionId: prediction.id
      });
    }
    settledCount += 1;
  }
  settledCount += settleParlays(match, settings);
  return settledCount;
}

function settleParlays(match, settings) {
  let settledCount = 0;
  const pendingParlays = (db.parlays || []).filter(p => p.status === 'pending');
  
  for (const parlay of pendingParlays) {
    const selection = parlay.selections.find(s => String(s.matchId) === String(match.id));
    if (!selection || selection.status !== 'pending') continue;

    const result = settleBetMarket(match, selection, settings);
    selection.status = result.status;
    selection.multiplier = result.multiplier;

    if (selection.status === 'lost') {
      parlay.status = 'lost';
      parlay.rewardPoints = 0;
      parlay.settledAt = new Date().toISOString();
      parlay.resultSummary = `Lost leg: ${match.homeTeam} vs ${match.awayTeam}`;
      
      const user = findUserById(parlay.userId);
      if (user) {
        user.stats ||= { predictions: 0, correct: 0, exact: 0 };
        user.updatedAt = new Date().toISOString();
      }
      notifyUser(parlay.userId, 'Parlay lost', `One of your parlay legs lost.`, {
        type: 'parlay',
        parlayId: parlay.id
      });
      settledCount += 1;
    } else if (selection.status === 'won' || selection.status === 'push') {
      const allSettled = parlay.selections.every(s => s.status !== 'pending');
      if (allSettled) {
        let finalMultiplier = 1.0;
        let hasWon = false;
        const wonByMatch = {};
        
        for (const s of parlay.selections) {
          if (s.status === 'won') {
            hasWon = true;
            if (!wonByMatch[s.matchId]) wonByMatch[s.matchId] = [];
            wonByMatch[s.matchId].push(s);
          }
        }
        
        if (!hasWon) {
          parlay.status = 'push';
          parlay.rewardPoints = Number(parlay.betPoints);
        } else {
          parlay.status = 'won';
          Object.values(wonByMatch).forEach(group => {
            let groupMul = 1.0;
            group.forEach(s => { groupMul *= Number(s.multiplier || 1); });
            groupMul *= Math.pow(0.5, group.length - 1);
            finalMultiplier *= groupMul;
          });
          parlay.rewardPoints = Math.round(Number(parlay.betPoints) * finalMultiplier);
        }
        
        parlay.settledAt = new Date().toISOString();
        parlay.resultSummary = `Parlay ${parlay.status}: ${parlay.selections.length} folds`;
        
        if (parlay.rewardPoints > 0) {
          addTransaction({
            userId: parlay.userId,
            type: parlay.status === 'push' ? 'push' : 'reward',
            amount: parlay.rewardPoints,
            note: `Parlay settled for ${parlay.selections.length} folds`,
            relatedId: parlay.id
          });
          const user = findUserById(parlay.userId);
          if (user) {
            user.stats ||= { predictions: 0, correct: 0, exact: 0 };
            if (parlay.status === 'won') user.stats.correct = Number(user.stats.correct || 0) + 1;
            user.updatedAt = new Date().toISOString();
          }
          notifyUser(parlay.userId, `Parlay ${parlay.status}`, `Your parlay paid ${parlay.rewardPoints} points.`, {
            type: 'parlay',
            parlayId: parlay.id
          });
        }
        settledCount += 1;
      }
    }
  }
  return settledCount;
}

function settleBetMarket(match, prediction, settings) {
  if (!prediction.market) {
    return getMultiplier(match, prediction, settings);
  }
  if (prediction.market.settlementMode !== 'auto' || prediction.market.period !== 'full') {
    return { status: 'pending', multiplier: 0, exact: false };
  }
  const homeScore = Number(match.homeScore || 0);
  const awayScore = Number(match.awayScore || 0);
  const odds = Number(prediction.market.odds || 1.9);
  let won = false;
  let push = false;

  if (prediction.market.marketType === 'moneyline') {
    won = matchOutcome(match) === prediction.market.selection;
  }

  if (prediction.market.marketType === 'handicap') {
    const lineHome = Number(prediction.market.lineHome || 0);
    const adjustedHome = homeScore + lineHome;
    if (adjustedHome === awayScore) push = true;
    if (prediction.market.selection === 'home') won = adjustedHome > awayScore;
    if (prediction.market.selection === 'away') won = adjustedHome < awayScore;
  }

  if (prediction.market.marketType === 'total') {
    const total = homeScore + awayScore;
    const line = Number(prediction.market.line || 0);
    if (total === line) push = true;
    if (prediction.market.selection === 'over') won = total > line;
    if (prediction.market.selection === 'under') won = total < line;
  }

  if (prediction.market.marketType === 'double_chance') {
    const actual = matchOutcome(match);
    if (prediction.market.selection === 'home_draw') won = actual === 'home' || actual === 'draw';
    if (prediction.market.selection === 'home_away') won = actual === 'home' || actual === 'away';
    if (prediction.market.selection === 'draw_away') won = actual === 'draw' || actual === 'away';
  }

  if (push) return { status: 'push', multiplier: 1, exact: false };
  return won
    ? { status: 'won', multiplier: odds, exact: false }
    : { status: 'lost', multiplier: 0, exact: false };
}

function validateMatchId(id) {
  return String(id || '').trim();
}

function parsePositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function isValidAvatarUrl(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (text.length > 500) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const filePath = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(PUBLIC_DIR, 'index.html');
  const isHtml = filePath.endsWith('index.html');
  const cacheControl = isHtml ? 'no-store' : 'no-store';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer'
    });
    res.end(content);
  });
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;
  req.urlToken = searchParams.get('token');

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return ok(res, 'ok', {
        dbPath: DB_PATH,
        leagues: leagueCatalog.length,
        matches: db.matches.length,
        users: db.users.length
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const avatar = String(body.avatar || '').trim();
      if (!username || username.length < 2) return fail(res, 400, 'Username too short');
      if (!isValidEmail(email)) return fail(res, 400, 'Email invalid');
      if (!isStrongPassword(password)) return fail(res, 400, 'Password too weak');
      if (findUserByEmail(email)) return fail(res, 409, 'Email already used');

      const now = new Date().toISOString();
      const user = {
        id: nextId(db, 'nextUserId'),
        username,
        email,
        passwordHash: makePasswordRecord(password),
        avatar,
        role: 'user',
        banned: false,
        points: 0,
        walletBalance: 0,
        createdAt: now,
        updatedAt: now,
        stats: { predictions: 0, correct: 0, exact: 0 }
      };
      db.users.push(user);
      addTransaction({
        userId: user.id,
        type: 'welcome',
        amount: db.settings.initialBalance,
        note: 'Welcome bonus'
      });
      maybePersist();
      const token = buildAuthToken(user, Boolean(body.remember));
      return ok(res, 'Registered', {
        token,
        user: toSafeUser(user)
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      const identifier = String(body.email || body.identifier || '').trim();
      const password = String(body.password || '');
      const user = findUserByLogin(identifier);
      if (!user) return fail(res, 401, 'Invalid credentials');
      if (user.banned) return fail(res, 403, 'User banned');
      if (!verifyPasswordSync(password, user.passwordHash)) return fail(res, 401, 'Invalid credentials');
      const token = buildAuthToken(user, Boolean(body.remember));
      return ok(res, 'Logged in', {
        token,
        user: toSafeUser(user)
      });
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const user = requireUser(req, res);
      if (!user) return;
      return ok(res, 'Current user', {
        user: toSafeUser(user)
      });
    }

    if (req.method === 'PATCH' && pathname === '/api/profile') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const avatar = String(body.avatar || '').trim();

      if (!isValidAvatarUrl(avatar)) {
        return fail(res, 400, 'Avatar URL must be http(s) and <= 500 chars');
      }

      user.avatar = avatar;
      user.updatedAt = new Date().toISOString();
      maybePersist();
      return ok(res, 'Profile updated', {
        user: toSafeUser(user)
      });
    }

    if (req.method === 'POST' && pathname === '/api/profile/password') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');

      if (!verifyPasswordSync(currentPassword, user.passwordHash)) {
        return fail(res, 401, 'Current password is incorrect');
      }
      if (!isStrongPassword(newPassword)) {
        return fail(res, 400, 'Password too weak');
      }
      if (currentPassword === newPassword) {
        return fail(res, 400, 'New password must be different');
      }

      user.passwordHash = makePasswordRecord(newPassword);
      user.updatedAt = new Date().toISOString();
      maybePersist();
      return ok(res, 'Password updated', {
        user: toSafeUser(user)
      });
    }

    if (req.method === 'GET' && pathname === '/api/matches/live') {
      const liveMatches = db.matches.filter((match) => match.isLive || String(match.status) === 'in').map((match) => serializeMatch(match, currentUser(req)?.id));
      return ok(res, 'Live matches', { matches: liveMatches });
    }

    if (req.method === 'GET' && pathname === '/api/matches') {
      const league = String(searchParams.get('league') || 'all');
      const status = String(searchParams.get('status') || 'all');
      const date = String(searchParams.get('date') || '');
      const q = String(searchParams.get('q') || '').trim().toLowerCase();
      const user = currentUser(req);
      let matches = db.matches.slice();
      if (league !== 'all') {
        matches = matches.filter((match) => match.league === league);
      }
      if (status !== 'all') {
        matches = matches.filter((match) => {
          if (status === 'live') return match.isLive || String(match.status) === 'in';
          if (status === 'upcoming') return !match.isFinal && !match.isLive && String(match.status) !== 'post';
          if (status === 'final') return match.isFinal || String(match.status) === 'post';
          return true;
        });
      }
      if (date) {
        matches = matches.filter((match) => String(match.kickoffTime || '').slice(0, 10) === date);
      }
      if (q) {
        matches = matches.filter((match) => `${match.homeTeam} ${match.awayTeam} ${match.leagueLabel}`.toLowerCase().includes(q));
      }
      matches.sort((a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime));
      return ok(res, 'Matches', {
        matches: matches.map((match) => serializeMatch(match, user?.id))
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/matches/')) {
      const matchId = validateMatchId(pathname.split('/').pop());
      const user = currentUser(req);
      const match = db.matches.find((item) => String(item.id) === matchId);
      if (!match) return fail(res, 404, 'Match not found');
      const chat = db.chatMessages
        .filter((message) => String(message.matchId) === matchId && !message.deleted)
        .map((message) => ({
          ...message,
          user: toSafeUser(findUserById(message.userId))
        }));
      return ok(res, 'Match detail', {
        match: serializeMatch(match, user?.id),
        chat
      });
    }

    if (req.method === 'POST' && pathname === '/api/predictions') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const match = db.matches.find((item) => String(item.id) === String(body.matchId));
      if (!match) return fail(res, 404, 'Match not found');
      if (isMatchLocked(match, db.settings)) return fail(res, 409, 'Prediction locked');

      const betPoints = parsePositiveNumber(body.betPoints);
      if (!betPoints || betPoints < 1) return fail(res, 400, 'Bet points invalid');
      if (betPoints > Number(user.walletBalance || 0)) return fail(res, 400, 'Not enough points');

      const marketKey = String(body.marketKey || '').trim();
      const optionKey = String(body.optionKey || '').trim();
      const pick = findMarketPick(match, marketKey, optionKey);
      if (!pick) return fail(res, 400, 'Bet market invalid');
      const already = db.predictions.find((prediction) =>
        String(prediction.userId) === String(user.id) &&
        String(prediction.matchId) === String(match.id) &&
        prediction.market?.marketKey === marketKey &&
        prediction.market?.optionKey === optionKey &&
        prediction.status === 'pending'
      );
      if (already) return fail(res, 409, 'This pick already exists');

      addTransaction({
        userId: user.id,
        type: 'bet',
        amount: -betPoints,
        note: `${pick.market.title}: ${pick.option.label}`
      });
      const prediction = {
        id: nextId(db, 'nextPredictionId'),
        userId: user.id,
        matchId: match.id,
        betPoints,
        market: {
          marketKey: pick.market.key,
          optionKey: pick.option.key,
          marketType: pick.market.marketType,
          period: pick.market.period,
          settlementMode: pick.market.settlementMode,
          title: pick.market.title,
          label: pick.option.label,
          selection: pick.option.selection,
          odds: Number(pick.option.odds || 1),
          line: pick.option.line ?? pick.market.line ?? null,
          lineHome: pick.option.lineHome ?? pick.market.lineHome ?? null
        },
        predictedHomeScore: null,
        predictedAwayScore: null,
        predictedWinner: null,
        firstScorer: '',
        rewardPoints: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        settledAt: null,
        resultSummary: ''
      };
      db.predictions.push(prediction);
      user.stats ||= { predictions: 0, correct: 0, exact: 0 };
      user.stats.predictions = Number(user.stats.predictions || 0) + 1;
      maybePersist();
      broadcast('wallet.updated', { userId: user.id });
      return ok(res, 'Prediction created', {
        prediction
      });
    }

    if (req.method === 'POST' && pathname === '/api/parlays') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      
      const betPoints = parsePositiveNumber(body.betPoints);
      if (!betPoints || betPoints < 1) return fail(res, 400, 'Bet points invalid');
      if (betPoints > Number(user.walletBalance || 0)) return fail(res, 400, 'Not enough points');

      if (!Array.isArray(body.picks) || body.picks.length < 2) {
        return fail(res, 400, 'Parlay must have at least 2 picks');
      }

      const selections = [];
      const picksByMatch = {};

      for (const pickInput of body.picks) {
        const match = db.matches.find((item) => String(item.id) === String(pickInput.matchId));
        if (!match) return fail(res, 404, `Match not found: ${pickInput.matchId}`);
        if (isMatchLocked(match, db.settings)) return fail(res, 409, `Match locked: ${match.homeTeam} vs ${match.awayTeam}`);

        const marketKey = String(pickInput.marketKey || '').trim();
        const optionKey = String(pickInput.optionKey || '').trim();
        const pick = findMarketPick(match, marketKey, optionKey);
        if (!pick) return fail(res, 400, `Bet market invalid for match ${match.id}`);

        const provider = pick.market.provider || 'ESPN';
        const marketType = pick.market.marketType;
        if (!picksByMatch[match.id]) picksByMatch[match.id] = [];
        const group = picksByMatch[match.id];
        
        if (group.some(g => g.pick.market.marketType === marketType)) {
           return fail(res, 400, `Cannot select multiple options from the same market type in match ${match.id}`);
        }
        
        group.push({ pick, match, provider });
        
        selections.push({
          matchId: match.id,
          market: {
            marketKey: pick.market.key,
            optionKey: pick.option.key,
            marketType: pick.market.marketType,
            period: pick.market.period,
            settlementMode: pick.market.settlementMode,
            title: pick.market.title,
            label: pick.option.label,
            selection: pick.option.selection,
            odds: Number(pick.option.odds || 1),
            line: pick.option.line ?? pick.market.line ?? null,
            lineHome: pick.option.lineHome ?? pick.market.lineHome ?? null,
            provider
          },
          status: 'pending'
        });
      }

      const getSgpMultiplier = (n) => {
        if (n <= 1) return 1.0;
        if (n === 2) return 0.85;
        if (n === 3) return 0.67;
        if (n === 4) return 0.42;
        if (n === 5) return 0.25;
        if (n === 6) return 0.15;
        return Math.pow(0.6, n - 1);
      };

      let combinedOdds = 1.0;
      Object.values(picksByMatch).forEach(group => {
        let groupOdds = 1.0;
        group.forEach(g => { groupOdds *= Number(g.pick.option.odds || 1); });
        groupOdds *= getSgpMultiplier(group.length);
        combinedOdds *= groupOdds;
      });

      addTransaction({
        userId: user.id,
        type: 'bet',
        amount: -betPoints,
        note: `Parlay Bet: ${selections.length} folds`
      });

      const parlay = {
        id: nextId(db, 'nextParlayId'),
        userId: user.id,
        betPoints,
        selections,
        combinedOdds,
        rewardPoints: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        settledAt: null,
        resultSummary: ''
      };

      db.parlays.push(parlay);
      user.stats ||= { predictions: 0, correct: 0, exact: 0 };
      user.stats.predictions = Number(user.stats.predictions || 0) + 1;
      maybePersist();
      broadcast('wallet.updated', { userId: user.id });
      return ok(res, 'Parlay created', { parlay });
    }

    if (req.method === 'GET' && pathname === '/api/predictions/me') {
      const user = requireUser(req, res);
      if (!user) return;
      const predictions = db.predictions
        .filter((prediction) => String(prediction.userId) === String(user.id))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((prediction) => ({
          ...prediction,
          match: db.matches.find((match) => String(match.id) === String(prediction.matchId)) || null
        }));
      
      const parlays = (db.parlays || [])
        .filter((parlay) => String(parlay.userId) === String(user.id))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((parlay) => ({
          ...parlay,
          selections: parlay.selections.map(s => ({
            ...s,
            match: db.matches.find(m => String(m.id) === String(s.matchId)) || null
          }))
        }));

      return ok(res, 'My predictions', { predictions, parlays });
    }

    if (req.method === 'GET' && pathname === '/api/wallet') {
      const user = requireUser(req, res);
      if (!user) return;
      return ok(res, 'Wallet', {
        balance: Number(user.walletBalance || 0),
        points: Number(user.points || 0)
      });
    }

    if (req.method === 'GET' && pathname === '/api/wallet/history') {
      const user = requireUser(req, res);
      if (!user) return;
      const history = db.walletTransactions
        .filter((transaction) => String(transaction.userId) === String(user.id))
        .filter((transaction) => ['admin_add', 'admin_deduct'].includes(String(transaction.type || '')))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return ok(res, 'Wallet history', { history });
    }

    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      const period = String(searchParams.get('period') || 'all-time');
      return ok(res, 'Leaderboard', {
        period,
        leaderboard: buildLeaderboard(period)
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/chat/')) {
      const matchId = validateMatchId(pathname.split('/').pop());
      const messages = db.chatMessages
        .filter((message) => String(message.matchId) === matchId && !message.deleted)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map((message) => ({
          ...message,
          user: toSafeUser(findUserById(message.userId))
        }));
      return ok(res, 'Chat messages', { messages });
    }

    if (req.method === 'POST' && pathname === '/api/chat/send') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const matchId = validateMatchId(body.matchId);
      const message = String(body.message || '').trim();
      const replyToMessageId = body.replyToMessageId ? String(body.replyToMessageId) : null;
      if (!matchId) return fail(res, 400, 'Match required');
      if (!message || message.length > 280) return fail(res, 400, 'Message invalid');
      const record = {
        id: nextId(db, 'nextChatMessageId'),
        userId: user.id,
        matchId,
        message,
        replyToMessageId,
        deleted: false,
        deletedByAdmin: false,
        createdAt: new Date().toISOString()
      };
      db.chatMessages.push(record);
      notifyUser(user.id, 'Chat sent', `Message sent in match ${matchId}.`, {
        type: 'chat',
        matchId
      });
      maybePersist();
      broadcast('chat.message', { matchId, message: record });
      return ok(res, 'Message sent', { message: record });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/chat/')) {
      return fail(res, 403, 'Deleting chat messages is disabled');
    }

    if (req.method === 'GET' && pathname === '/api/notifications') {
      const user = requireUser(req, res);
      if (!user) return;
      const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit') || 20)));
      const notifications = db.notifications
        .filter((notification) => notification.userId === null || String(notification.userId) === String(user.id))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
      return ok(res, 'Notifications', { notifications });
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const users = db.users.map((user) => {
        const predictions = db.predictions.filter((prediction) => String(prediction.userId) === String(user.id));
        const settled = predictions.filter((prediction) => prediction.status !== 'pending');
        const correct = settled.filter((prediction) => Number(prediction.rewardPoints || 0) > 0);
        return {
          ...toSafeUser(user),
          stats: {
            predictions: settled.length,
            correct: correct.length,
            exact: Number(user.stats?.exact || 0)
          }
        };
      });
      return ok(res, 'Users', { users });
    }

    if (req.method === 'GET' && pathname === '/api/admin/transactions') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const userId = searchParams.get('userId');
      const transactions = db.walletTransactions
        .filter((transaction) => !userId || String(transaction.userId) === String(userId))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return ok(res, 'Transactions', { transactions });
    }

    if (req.method === 'GET' && pathname === '/api/admin/predictions') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const status = String(searchParams.get('status') || 'all');
      const predictions = db.predictions
        .filter((prediction) => status === 'all' || prediction.status === status)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((prediction) => ({
          ...prediction,
          user: toSafeUser(findUserById(prediction.userId)),
          match: db.matches.find((match) => String(match.id) === String(prediction.matchId)) || null
        }));
      return ok(res, 'Predictions', { predictions });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/admin/predictions/')) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const segments = pathname.split('/');
      const predictionId = validateMatchId(segments[4]);
      const action = segments[5];
      if (action !== 'settle') return fail(res, 404, 'Unknown admin action');
      const body = await readBody(req);
      const prediction = db.predictions.find((item) => String(item.id) === predictionId);
      if (!prediction) return fail(res, 404, 'Prediction not found');
      const settled = settlePredictionAdmin(prediction, String(body.outcome || ''), admin.id);
      if (!settled) return fail(res, 400, 'Settle outcome invalid');
      maybePersist();
      broadcast('wallet.updated', { userId: prediction.userId });
      return ok(res, 'Prediction settled', { prediction: settled });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const userId = validateMatchId(pathname.split('/')[4]);
      const user = findUserById(userId);
      if (!user) return fail(res, 404, 'User not found');
      if (String(user.id) === String(admin.id)) return fail(res, 400, 'Cannot delete your own account');
      if (user.role === 'admin' && activeAdminCount() <= 1) {
        return fail(res, 400, 'Need at least one admin');
      }
      const removed = deleteUserAccount(user);
      maybePersist();
      broadcast('leaderboard.updated', { userId: user.id, deleted: true });
      broadcast('wallet.updated', { userId: user.id, deleted: true });
      return ok(res, 'User deleted', { removed });
    }

    if (req.method === 'PATCH' && pathname.startsWith('/api/admin/users/')) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const segments = pathname.split('/');
      const userId = validateMatchId(segments[4]);
      const action = segments[5];
      const user = findUserById(userId);
      if (!user) return fail(res, 404, 'User not found');
      const body = await readBody(req).catch(() => ({}));
      if (action === 'ban') {
        user.banned = true;
      } else if (action === 'unban') {
        user.banned = false;
      } else if (action === 'role') {
        if (String(user.id) === String(admin.id)) return fail(res, 400, 'Cannot change your own role');
        const nextRole = String(body.role || '').trim();
        if (!['user', 'admin'].includes(nextRole)) return fail(res, 400, 'Role invalid');
        if (user.role === 'admin' && nextRole !== 'admin' && activeAdminCount() <= 1) {
          return fail(res, 400, 'Need at least one admin');
        }
        user.role = nextRole;
      } else {
        return fail(res, 404, 'Unknown admin action');
      }
      user.updatedAt = new Date().toISOString();
      maybePersist();
      broadcast('leaderboard.updated', { userId: user.id });
      return ok(res, 'Updated', { user: toSafeUser(user) });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/admin/users/')) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const segments = pathname.split('/');
      const userId = validateMatchId(segments[4]);
      const action = segments[5];
      const user = findUserById(userId);
      if (!user) return fail(res, 404, 'User not found');
      const body = await readBody(req);
      if (action === 'reset') {
        resetUserWallet(user, admin.id);
        maybePersist();
        broadcast('wallet.updated', { userId: user.id });
        return ok(res, 'Wallet reset', { user: toSafeUser(user) });
      }
      if (action === 'points') {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount === 0) return fail(res, 400, 'Amount invalid');
        const note = String(body.note || '').trim() || 'Admin adjustment';
        addTransaction({
          userId: user.id,
          type: amount > 0 ? 'admin_add' : 'admin_deduct',
          amount,
          note,
          createdByAdmin: admin.id
        });
        maybePersist();
        broadcast('wallet.updated', { userId: user.id });
        return ok(res, 'Balance updated', { user: toSafeUser(user) });
      }
      return fail(res, 404, 'Unknown admin action');
    }

    if (req.method === 'POST' && pathname === '/api/admin/config') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const multipliers = body.multipliers || {};
      const nextSettings = db.settings || {};
      if (multipliers.win !== undefined) nextSettings.multipliers.win = Number(multipliers.win);
      if (multipliers.exact !== undefined) nextSettings.multipliers.exact = Number(multipliers.exact);
      if (multipliers.draw !== undefined) nextSettings.multipliers.draw = Number(multipliers.draw);
      if (body.initialBalance !== undefined) nextSettings.initialBalance = Math.max(0, Number(body.initialBalance));
      if (body.predictionLockMinutes !== undefined) nextSettings.predictionLockMinutes = Math.max(0, Number(body.predictionLockMinutes));
      if (body.featureLeague !== undefined) nextSettings.featureLeague = String(body.featureLeague);
      db.settings = nextSettings;
      maybePersist();
      return ok(res, 'Config updated', { settings: db.settings });
    }

    if (req.method === 'GET' && pathname === '/api/admin/config') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return ok(res, 'Config', { settings: db.settings });
    }

    if (req.method === 'POST' && pathname === '/api/admin/sync') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req).catch(() => ({}));
      const mode = String(body.mode || 'fixtures');
      const result = await syncFromEspn(mode);
      return ok(res, 'Synced', result);
    }

    if (req.method === 'GET' && pathname === '/api/admin/matches') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return ok(res, 'Matches', { matches: db.matches.map((match) => serializeMatch(match)) });
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      return ok(res, 'Snapshot', publicSnapshot);
    }

    return fail(res, 404, 'Route not found');
  } catch (error) {
    return fail(res, error.statusCode || 500, formatError(error));
  }
}

function handleStream(req, res, urlObj) {
  const token = urlObj.searchParams.get('token');
  const payload = verifyToken(token);
  const user = payload ? findUserById(payload.sub) : null;
  if (!user || user.banned) {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8'
    });
    res.end('Unauthorized');
    return;
  }

  const clientId = `${user.id}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no'
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, userId: user.id })}\n\n`);
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
      streamClients.delete(clientId);
    }
  }, HEARTBEAT_MS);
  streamClients.set(clientId, { res, userId: user.id, heartbeat });

  req.on('close', () => {
    clearInterval(heartbeat);
    streamClients.delete(clientId);
  });
}

function startTimers() {
  setInterval(() => {
    if (!shouldRunLiveSync()) return;
    syncFromEspn('live').catch(() => {});
  }, REFRESH_LIVE_MS);

  setInterval(() => {
    syncFromEspn('fixtures').catch(() => {});
  }, REFRESH_FIXTURES_MS);
}

async function bootstrap() {
  db = await loadDb();
  ensureSeedValues(db);
  ensureSeedUsers();
  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname === '/api/stream') {
      return handleStream(req, res, urlObj);
    }
    if (urlObj.pathname.startsWith('/api/')) {
      if (!allowApiRequest(req)) {
        return fail(res, 429, 'Too many requests');
      }
      return handleApi(req, res, urlObj);
    }
    return serveStatic(req, res, urlObj.pathname);
  });

  server.listen(PORT, () => {
    console.log(`Worldcup Prediction MVP running at http://localhost:${PORT}`);
    syncFromEspn('fixtures').catch(() => null);
    startTimers();
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
