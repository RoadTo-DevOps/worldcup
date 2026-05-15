require('./config/env');

const fs = require('fs');
const { DATA_DIR, DB_PATH, defaultSettings } = require('./config');

let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}

const STATE_ID = 'worldcup-prediction-state';
let mongoClient = null;
let mongoCollection = null;
let storageMode = 'json';

const DAY_MS = 24 * 60 * 60 * 1000;
const retention = {
  predictionDays: readIntEnv('PREDICTION_HISTORY_DAYS', 180),
  walletDays: readIntEnv('WALLET_HISTORY_DAYS', 180),
  matchDays: readIntEnv('MATCH_HISTORY_DAYS', 7),
  chatDays: readIntEnv('CHAT_HISTORY_DAYS', 30),
  notificationDays: readIntEnv('NOTIFICATION_HISTORY_DAYS', 30),
  leaderboardDays: readIntEnv('LEADERBOARD_HISTORY_DAYS', 30),
  maxPredictionsPerUser: readIntEnv('MAX_PREDICTIONS_PER_USER', 30),
  maxSettledPredictions: readIntEnv('MAX_SETTLED_PREDICTIONS', 1000),
  maxWalletTransactions: readIntEnv('MAX_WALLET_TRANSACTIONS', 2000),
  maxChatMessages: readIntEnv('MAX_CHAT_MESSAGES', 500),
  maxNotifications: readIntEnv('MAX_NOTIFICATIONS', 300),
  maxLeaderboardHistory: readIntEnv('MAX_LEADERBOARD_HISTORY', 300)
};

function readIntEnv(key, fallback) {
  const value = Number(process.env[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function createDefaultDb() {
  const now = new Date().toISOString();
  return {
    meta: {
      nextUserId: 1,
      nextMatchId: 1,
      nextPredictionId: 1,
      nextParlayId: 1,
      nextTransactionId: 1,
      nextChatMessageId: 1,
      nextNotificationId: 2
    },
    settings: JSON.parse(JSON.stringify(defaultSettings)),
    users: [],
    matches: [],
    predictions: [],
    parlays: [],
    walletTransactions: [],
    leaderboardHistory: [],
    chatMessages: [],
    notifications: [
      {
        id: 1,
        userId: null,
        type: 'system',
        title: 'Welcome',
        message: 'MVP ready to bet with virtual points.',
        read: false,
        createdAt: now
      }
    ]
  };
}

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(createDefaultDb(), null, 2), 'utf8');
  }
}

function readJsonFallback() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeJsonFallback(db) {
  ensureDbFile();
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

async function connectMongo() {
  if (!MongoClient) return null;
  if (mongoCollection) return mongoCollection;

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_DB || 'worldcup_prediction';
  mongoClient = new MongoClient(uri, {
    serverSelectionTimeoutMS: 1500
  });
  await mongoClient.connect();
  const mongoDb = mongoClient.db(dbName);
  mongoCollection = mongoDb.collection('app_state');
  await mongoCollection.createIndex({ updatedAt: -1 });
  storageMode = 'mongodb';
  return mongoCollection;
}

async function loadDb() {
  let db = null;
  try {
    const collection = await connectMongo();
    if (collection) {
      const doc = await collection.findOne({ _id: STATE_ID });
      if (doc?.state) {
        db = doc.state;
      } else {
        db = readJsonFallback();
        ensureSeedValues(db);
        await collection.updateOne(
          { _id: STATE_ID },
          { $set: { state: db, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
      }
    }
  } catch (error) {
    storageMode = 'json';
    console.warn(`[store] MongoDB unavailable, using JSON fallback: ${error.message}`);
  }

  if (!db) {
    db = readJsonFallback();
  }

  ensureSeedValues(db);
  pruneDb(db);
  return db;
}

async function saveDb(db) {
  ensureSeedValues(db);
  pruneDb(db);
  writeJsonFallback(db);

  try {
    const collection = await connectMongo();
    if (!collection) return;
    await collection.updateOne(
      { _id: STATE_ID },
      {
        $set: {
          state: db,
          updatedAt: new Date().toISOString()
        },
        $setOnInsert: {
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
  } catch (error) {
    storageMode = 'json';
    console.warn(`[store] MongoDB save skipped: ${error.message}`);
  }
}

function nextId(db, key) {
  db.meta[key] = Number(db.meta[key] || 1);
  const value = db.meta[key];
  db.meta[key] += 1;
  return value;
}

function ensureSeedValues(db) {
  db.meta ||= {};
  db.settings ||= JSON.parse(JSON.stringify(defaultSettings));
  db.users ||= [];
  db.matches ||= [];
  db.predictions ||= [];
  db.parlays ||= [];
  db.walletTransactions ||= [];
  db.leaderboardHistory ||= [];
  db.chatMessages ||= [];
  db.notifications ||= [];
  db.meta.nextUserId = Math.max(Number(db.meta.nextUserId || 1), maxId(db.users) + 1);
  db.meta.nextMatchId = Math.max(Number(db.meta.nextMatchId || 1), maxId(db.matches) + 1);
  db.meta.nextPredictionId = Math.max(Number(db.meta.nextPredictionId || 1), maxId(db.predictions) + 1);
  db.meta.nextParlayId = Math.max(Number(db.meta.nextParlayId || 1), maxId(db.parlays) + 1);
  db.meta.nextTransactionId = Math.max(Number(db.meta.nextTransactionId || 1), maxId(db.walletTransactions) + 1);
  db.meta.nextChatMessageId = Math.max(Number(db.meta.nextChatMessageId || 1), maxId(db.chatMessages) + 1);
  db.meta.nextNotificationId = Math.max(Number(db.meta.nextNotificationId || 1), maxId(db.notifications) + 1);
}

function maxId(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0);
}

function pruneDb(db) {
  if (!db) return db;
  db.matches = pruneMatches(db.matches);
  db.predictions = prunePredictions(db.predictions);
  db.parlays = prunePredictions(db.parlays);
  db.walletTransactions = pruneTimedList(db.walletTransactions, retention.walletDays, retention.maxWalletTransactions);
  db.chatMessages = pruneTimedList(db.chatMessages, retention.chatDays, retention.maxChatMessages);
  db.notifications = pruneTimedList(db.notifications, retention.notificationDays, retention.maxNotifications);
  db.leaderboardHistory = pruneTimedList(db.leaderboardHistory, retention.leaderboardDays, retention.maxLeaderboardHistory);
  return db;
}

function pruneMatches(matches) {
  if (!Array.isArray(matches)) return [];
  if (!retention.matchDays) return matches;
  const cutoff = cutoffTime(retention.matchDays);
  return matches.filter((match) => {
    const matchTime = itemTime(match);
    return !cutoff || matchTime >= cutoff;
  });
}

function prunePredictions(predictions) {
  if (!Array.isArray(predictions)) return [];
  const cutoff = cutoffTime(retention.predictionDays);
  const byUser = new Map();

  for (const prediction of predictions) {
    const userKey = String(prediction?.userId || 'anonymous');
    if (!byUser.has(userKey)) byUser.set(userKey, []);
    byUser.get(userKey).push(prediction);
  }

  const nextPredictions = [];
  for (const userPredictions of byUser.values()) {
    const pending = userPredictions.filter((prediction) => prediction.status === 'pending');
    let settled = userPredictions.filter((prediction) => {
      if (prediction.status === 'pending') return false;
      return !cutoff || itemTime(prediction) >= cutoff;
    });

    const maxSettledForUser = retention.maxPredictionsPerUser
      ? Math.max(Math.min(retention.maxPredictionsPerUser - pending.length, retention.maxSettledPredictions), 0)
      : retention.maxSettledPredictions;

    settled = keepNewest(settled, maxSettledForUser);
    nextPredictions.push(...pending, ...settled);
  }

  return sortByCreatedAt(nextPredictions);
}

function pruneTimedList(items, days, maxCount) {
  if (!Array.isArray(items)) return [];
  const cutoff = cutoffTime(days);
  const recent = cutoff ? items.filter((item) => itemTime(item) >= cutoff) : items.slice();
  return keepNewest(recent, maxCount);
}

function keepNewest(items, maxCount) {
  const sorted = sortByCreatedAt(items);
  if (!maxCount || sorted.length <= maxCount) return sorted;
  return sorted.slice(-maxCount);
}

function sortByCreatedAt(items) {
  return [...items].sort((a, b) => {
    const left = itemTime(a);
    const right = itemTime(b);
    if (left !== right) return left - right;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function cutoffTime(days) {
  if (!days) return 0;
  return Date.now() - days * DAY_MS;
}

function itemTime(item) {
  const time = new Date(item?.createdAt || item?.settledAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getStorageInfo() {
  return {
    mode: storageMode,
    mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    mongoDb: process.env.MONGODB_DB || 'worldcup_prediction',
    jsonPath: DB_PATH
  };
}

module.exports = {
  createDefaultDb,
  loadDb,
  saveDb,
  nextId,
  ensureSeedValues,
  getStorageInfo
};
