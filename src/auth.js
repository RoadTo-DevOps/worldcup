const crypto = require('crypto');

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'worldcup-mvp-secret';
const TOKEN_TTL_SECONDS = Math.max(60, Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 2));

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? '='.repeat(4 - pad) : '');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashPasswordSync(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPasswordSync(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function signToken(payload, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const tokenPayload = { ...payload, exp };
  const headerPart = base64UrlEncodeJson(header);
  const payloadPart = base64UrlEncodeJson(tokenPayload);
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${headerPart}.${payloadPart}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(expectedSignature);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function makePasswordRecord(password) {
  return hashPasswordSync(password);
}

function toSafeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function normalizeUsername(username) {
  return String(username || '').trim().replace(/\s+/g, ' ');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isStrongPassword(password) {
  const value = String(password || '');
  return value.length > 6;
}

function buildAuthToken(user) {
  return signToken(
    {
      sub: String(user.id),
      role: user.role,
      email: user.email
    },
    TOKEN_TTL_SECONDS
  );
}

function parseAuthTokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

module.exports = {
  makePasswordRecord,
  verifyPasswordSync,
  toSafeUser,
  normalizeUsername,
  normalizeEmail,
  isValidEmail,
  isStrongPassword,
  buildAuthToken,
  verifyToken,
  parseAuthTokenFromRequest,
  sha256
};
