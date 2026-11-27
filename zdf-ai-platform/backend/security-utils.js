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

/** 服务端权威 Credit 价目（忽略客户端 creditCost） */
export const SERVER_CREDIT_COSTS = Object.freeze({
  single: 1,
  pipeline: 5,
  rag: 10,
});

/** 流水线入口角色：计费并签发短期 continuation pass */
export const PIPELINE_OPENER_ROLE = 'A';

/** 可消费 pass 的续跑角色（无有效 pass 时按流水线价计费，禁止白嫖） */
export const PIPELINE_CONTINUATION_ROLES = Object.freeze(['B', 'C', 'D']);

export const PIPELINE_PASS_MAX_CONTINUATIONS = 3;
export const PIPELINE_PASS_TTL_MS = 15 * 60 * 1000;

/**
 * 服务端权威 Credit：完全忽略客户端 creditCost。
 * - useRag → rag
 * - 角色 A → pipeline（开启流水线）
 * - B/C/D 且持有有效 pass → 0（诚实多角色合计仍为 5）
 * - B/C/D 无 pass → pipeline（不可因客户端声称 0 而免单）
 * - 其他/缺失角色 → single（至少 1）
 * @param {{ roleId?: unknown, useRag?: unknown, hasPipelinePass?: boolean }} [opts]
 * @returns {number}
 */
export function resolveServerCreditCost({ roleId, useRag, hasPipelinePass } = {}) {
  if (useRag) return SERVER_CREDIT_COSTS.rag;
  const role = String(roleId || '');
  if (role === PIPELINE_OPENER_ROLE) return SERVER_CREDIT_COSTS.pipeline;
  if (PIPELINE_CONTINUATION_ROLES.includes(role)) {
    return hasPipelinePass ? 0 : SERVER_CREDIT_COSTS.pipeline;
  }
  return SERVER_CREDIT_COSTS.single;
}

/**
 * 内存中的流水线 continuation pass（单进程；与并发队列同级）。
 * A 成功计费后签发；B/C/D 在 TTL 内最多消费 3 次 0 分计费。
 */
export class PipelinePassBook {
  /**
   * @param {{ ttlMs?: number, maxContinuations?: number, now?: () => number }} [opts]
   */
  constructor({
    ttlMs = PIPELINE_PASS_TTL_MS,
    maxContinuations = PIPELINE_PASS_MAX_CONTINUATIONS,
    now = () => Date.now(),
  } = {}) {
    /** @type {Map<string, { expiresAt: number, left: number }>} */
    this._passes = new Map();
    this.ttlMs = ttlMs;
    this.maxContinuations = maxContinuations;
    this.now = now;
  }

  /**
   * @param {string} userId
   * @returns {boolean}
   */
  hasValid(userId) {
    if (!userId) return false;
    const p = this._passes.get(userId);
    if (!p) return false;
    if (this.now() > p.expiresAt || p.left <= 0) {
      this._passes.delete(userId);
      return false;
    }
    return true;
  }

  /**
   * @param {string} userId
   */
  open(userId) {
    if (!userId) return;
    this._passes.set(userId, {
      expiresAt: this.now() + this.ttlMs,
      left: this.maxContinuations,
    });
  }

  /**
   * 消费一次 continuation；无效时返回 false。
   * @param {string} userId
   * @returns {boolean}
   */
  consume(userId) {
    if (!this.hasValid(userId)) return false;
    const p = this._passes.get(userId);
    p.left -= 1;
    if (p.left <= 0) this._passes.delete(userId);
    return true;
  }
}
