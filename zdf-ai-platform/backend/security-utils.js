/**
 * Small pure helpers extracted so they can be unit-tested without starting the HTTP server.
 */
import path from 'path';
import crypto from 'crypto';

export const RAG_ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json', '.log', '.pdf', '.docx'];

/**
 * Build a stored RAG filename. Truncation keeps a whitelisted extension so
 * extractText() can still detect the type. Callers should not treat this as a
 * path-traversal defense; multer/busboy already basename uploaded names.
 */
export function sanitizeRagFilename(originalName, now = Date.now()) {
  const decoded = Buffer.from(String(originalName || ''), 'latin1').toString('utf8');
  const base = path.basename(decoded).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  const extRaw = path.extname(base).toLowerCase();
  const safeExt = RAG_ALLOWED_EXTS.includes(extRaw) ? extRaw : '';
  let stem = path.basename(base, path.extname(base));
  stem = stem.replace(/\.{2,}/g, '_').replace(/^\.+/, '');
  if (!stem) stem = 'upload';
  const maxStem = Math.max(1, 200 - safeExt.length);
  if (stem.length > maxStem) stem = stem.slice(0, maxStem);
  return `${now}_${stem}${safeExt}`;
}

export function randomPassword() {
  return crypto.randomBytes(32).toString('base64');
}

export function generateOAuthState() {
  return crypto.randomBytes(16).toString('hex');
}

export function oauthStateCookieName(provider) {
  return `oauth_state_${provider}`;
}

export function oauthStateCookieOptions({ secure = false, maxAge = 600_000, path: cookiePath = '/' } = {}) {
  return { httpOnly: true, sameSite: 'lax', maxAge, path: cookiePath, secure };
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Password-reset email code is the first 8 chars of the stored token; require an exact 8-char match. */
export function resetCodeMatches(token, code) {
  const expected = String(token || '').slice(0, 8).toUpperCase();
  const provided = String(code || '').toUpperCase().trim();
  return provided.length === 8 && timingSafeEqualStr(expected, provided);
}

/** '' for root; '/BestAnswer' (no trailing slash) when a public subpath is configured. */
export function normalizePublicBase(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}
