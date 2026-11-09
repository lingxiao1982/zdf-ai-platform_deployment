#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * Bounded, read-only BestAnswer verifier.
 *
 *   node scripts/verify-bestanswer.mjs
 *   VERIFY_ORIGIN=https://zdfai.cn node scripts/verify-bestanswer.mjs
 *
 * Does not call generation/payment/login or other mutating endpoints.
 * Does not eval fetched JS/CSS. Only same-origin paths on an allow-list are fetched.
 */

const DEFAULT_ORIGIN = 'https://zdfai.cn';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

const BESS_PREFIX = '/europeBESS-financial';
const ALLOWED_PATH_PREFIXES = [
  '/BestAnswer/',
  '/BestAnswer?',
  '/SuitAssistant/',
  `${BESS_PREFIX}/`,
];
const ALLOWED_EXACT_PATHS = ['/', '/BestAnswer', '/SuitAssistant', BESS_PREFIX];

export function normalizeOrigin(raw) {
  const u = new URL(String(raw || DEFAULT_ORIGIN));
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported origin protocol: ${u.protocol}`);
  }
  u.hash = '';
  u.search = '';
  let href = u.href;
  if (href.endsWith('/')) href = href.slice(0, -1);
  return href;
}

export function assertAllowedUrl(absUrl, origin) {
  const target = new URL(absUrl);
  const base = new URL(origin);
  if (target.origin !== base.origin) {
    throw new Error(`blocked cross-origin fetch: ${target.origin} (allowed origin ${base.origin})`);
  }
  const path = target.pathname || '/';
  const okExact = ALLOWED_EXACT_PATHS.includes(path);
  const okPrefix = ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p.replace(/\?$/, '')) || `${path}${target.search}`.startsWith(p));
  const okBess = path === BESS_PREFIX || path.startsWith(`${BESS_PREFIX}/`);
  if (!okExact && !okPrefix && !okBess) {
    throw new Error(`blocked path outside allow-list: ${path}`);
  }
  return target;
}

export function extractHashedAssets(html) {
  const js = [];
  const css = [];
  const seen = new Set();
  const push = (arr, raw) => {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    arr.push(v);
  };
  for (const m of String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) push(js, m[1]);
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) push(css, href[1]);
  }
  return { js, css };
}

export function looksLikeHtml(contentType, bodyText) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const head = String(bodyText || '').trimStart().slice(0, 96).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

export function isJsContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.includes('javascript') || ct.includes('ecmascript');
}

export function isCssContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('text/css');
}

export function isHealthyJson(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.ok === true
    && typeof value.service === 'string'
    && value.service.trim().length > 0,
  );
}

function contentTypeOf(headers) {
  return headers.get('content-type') || headers.get('Content-Type') || '';
}

async function fetchOnce(url, { timeoutMs, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'zdf-bestanswer-verifier/1.0', Accept: '*/*' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const loc = res.headers.get('location') || res.headers.get('Location') || '';
    return {
      status: res.status,
      headers: res.headers,
      body: buf,
      location: loc,
      url,
    };
  } catch (e) {
    const name = e?.name || '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`timeout after ${timeoutMs}ms fetching ${url}`);
    }
    throw new Error(`HTTP failure fetching ${url}: ${e.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollow(url, opts, redirectsLeft = MAX_REDIRECTS) {
  const res = await fetchOnce(url, opts);
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirectsLeft <= 0) throw new Error(`too many redirects at ${url}`);
    if (!res.location) throw new Error(`redirect ${res.status} without Location from ${url}`);
    const next = new URL(res.location, url).href;
    assertAllowedUrl(next, opts.origin);
    const followed = await fetchFollow(next, opts, redirectsLeft - 1);
    followed.redirectChain = [...(res.redirectChain || [url]), next];
    followed.fromRedirect = true;
    return followed;
  }
  res.redirectChain = [url];
  return res;
}

function fail(id, detail) {
  return { id, ok: false, detail };
}
function pass(id, detail) {
  return { id, ok: true, detail };
}

function requireHtmlDocument(id, res, label) {
  const ct = contentTypeOf(res.headers);
  const text = res.body.toString('utf8');
  if (res.status !== 200) return fail(id, `${label} HTTP ${res.status} (want 200)`);
  if (!looksLikeHtml(ct, text)) return fail(id, `${label} not HTML (content-type ${ct || 'missing'})`);
  if (!text.trim()) return fail(id, `${label} empty body`);
  return null;
}

async function checkAsset({ origin, timeoutMs, pageUrl, rel, kind }) {
  const abs = new URL(rel, pageUrl).href;
  let allowed;
  try {
    allowed = assertAllowedUrl(abs, origin);
  } catch (e) {
    return fail(`bestanswer-${kind}`, e.message);
  }
  if (!allowed.pathname.startsWith('/BestAnswer/')) {
    return fail(`bestanswer-${kind}`, `${kind} URL outside /BestAnswer/: ${allowed.pathname}`);
  }
  const res = await fetchFollow(abs, { timeoutMs, origin });
  const ct = contentTypeOf(res.headers);
  const text = res.body.toString('utf8');
  if (res.status !== 200) {
    return fail(`bestanswer-${kind}`, `${kind} ${abs} HTTP ${res.status} (blank-page pattern if 404)`);
  }
  if (looksLikeHtml(ct, text)) {
    return fail(`bestanswer-${kind}`, `${kind} ${abs} looks like HTML (content-type ${ct || 'missing'}, ${res.body.length} bytes) — reject fallback HTML even on 200`);
  }
  if (!text.trim()) return fail(`bestanswer-${kind}`, `${kind} ${abs} empty body`);
  if (kind === 'js' && !isJsContentType(ct)) {
    return fail(`bestanswer-${kind}`, `${kind} ${abs} wrong content-type ${ct || 'missing'} (want javascript)`);
  }
  if (kind === 'css' && !isCssContentType(ct)) {
    return fail(`bestanswer-${kind}`, `${kind} ${abs} wrong content-type ${ct || 'missing'} (want text/css)`);
  }
  return pass(`bestanswer-${kind}`, `${kind} ${abs} HTTP ${res.status} type=${ct} bytes=${res.body.length}`);
}

export async function runChecks({ origin = DEFAULT_ORIGIN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const originNorm = normalizeOrigin(origin);
  const checks = [];
  const opts = { timeoutMs, origin: originNorm };

  // 1. BestAnswer HTML
  let htmlText = '';
  let htmlUrl = `${originNorm}/BestAnswer/`;
  try {
    assertAllowedUrl(htmlUrl, originNorm);
    const htmlRes = await fetchFollow(htmlUrl, opts);
    htmlUrl = htmlRes.redirectChain[htmlRes.redirectChain.length - 1] || htmlUrl;
    const htmlFail = requireHtmlDocument('bestanswer-html', htmlRes, 'BestAnswer HTML');
    if (htmlFail) checks.push(htmlFail);
    else {
      htmlText = htmlRes.body.toString('utf8');
      checks.push(pass('bestanswer-html', `HTTP ${htmlRes.status} type=${contentTypeOf(htmlRes.headers)} bytes=${htmlRes.body.length}`));
    }
  } catch (e) {
    checks.push(fail('bestanswer-html', e.message));
  }

  const { js, css } = extractHashedAssets(htmlText);
  if (!checks.find((c) => c.id === 'bestanswer-html')?.ok) {
    checks.push(fail('bestanswer-js', 'skipped: BestAnswer HTML failed'));
    checks.push(fail('bestanswer-css', 'skipped: BestAnswer HTML failed'));
  } else if (js.length === 0) {
    checks.push(fail('bestanswer-js', 'HTML contained no <script src> (cannot verify hashed JS)'));
  } else {
    try {
      checks.push(await checkAsset({ ...opts, pageUrl: htmlUrl, rel: js[0], kind: 'js' }));
    } catch (e) {
      checks.push(fail('bestanswer-js', e.message));
    }
  }
  if (checks.find((c) => c.id === 'bestanswer-html')?.ok && css.length === 0) {
    checks.push(fail('bestanswer-css', 'HTML contained no stylesheet href (cannot verify hashed CSS)'));
  } else if (checks.find((c) => c.id === 'bestanswer-html')?.ok && css.length > 0) {
    try {
      checks.push(await checkAsset({ ...opts, pageUrl: htmlUrl, rel: css[0], kind: 'css' }));
    } catch (e) {
      checks.push(fail('bestanswer-css', e.message));
    }
  }

  // Health
  try {
    const healthUrl = `${originNorm}/BestAnswer/api/health`;
    assertAllowedUrl(healthUrl, originNorm);
    const res = await fetchFollow(healthUrl, opts);
    const ct = contentTypeOf(res.headers);
    const text = res.body.toString('utf8');
    if (res.status !== 200) checks.push(fail('bestanswer-health', `HTTP ${res.status} (want 200)`));
    else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        checks.push(fail('bestanswer-health', `malformed JSON: ${text.slice(0, 120)}`));
        parsed = null;
      }
      if (parsed) {
        if (!isHealthyJson(parsed)) {
          checks.push(fail('bestanswer-health', `unhealthy JSON: ${text.slice(0, 160)}`));
        } else if (!String(ct).toLowerCase().includes('json')) {
          checks.push(fail('bestanswer-health', `healthy JSON but content-type ${ct || 'missing'}`));
        } else {
          checks.push(pass('bestanswer-health', `HTTP 200 ${text}`));
        }
      }
    }
  } catch (e) {
    checks.push(fail('bestanswer-health', e.message));
  }

  // SuitAssistant HTML
  try {
    const suitUrl = `${originNorm}/SuitAssistant/`;
    assertAllowedUrl(suitUrl, originNorm);
    const res = await fetchFollow(suitUrl, opts);
    const err = requireHtmlDocument('suitassistant-html', res, 'SuitAssistant HTML');
    checks.push(err || pass('suitassistant-html', `HTTP ${res.status} type=${contentTypeOf(res.headers)} bytes=${res.body.length}`));
  } catch (e) {
    checks.push(fail('suitassistant-html', e.message));
  }

  // Root → BESS
  try {
    const rootUrl = `${originNorm}/`;
    assertAllowedUrl(rootUrl, originNorm);
    const first = await fetchOnce(rootUrl, opts);
    if (![301, 302, 303, 307, 308].includes(first.status)) {
      checks.push(fail('bess-redirect', `GET / HTTP ${first.status} (want 3xx to ${BESS_PREFIX}/)`));
    } else {
      const dest = new URL(first.location || '', rootUrl);
      assertAllowedUrl(dest.href, originNorm);
      if (!(dest.pathname === BESS_PREFIX || dest.pathname.startsWith(`${BESS_PREFIX}/`))) {
        checks.push(fail('bess-redirect', `GET / redirected to ${dest.pathname}, want ${BESS_PREFIX}/`));
      } else {
        checks.push(pass('bess-redirect', `GET / HTTP ${first.status} → ${dest.pathname}`));
        const destRes = await fetchFollow(dest.href, opts);
        const err = requireHtmlDocument('bess-html', destRes, 'BESS destination HTML');
        checks.push(err || pass('bess-html', `HTTP ${destRes.status} type=${contentTypeOf(destRes.headers)} bytes=${destRes.body.length}`));
      }
    }
  } catch (e) {
    checks.push(fail('bess-redirect', e.message));
  }

  const ids = [
    'bestanswer-html',
    'bestanswer-js',
    'bestanswer-css',
    'bestanswer-health',
    'suitassistant-html',
    'bess-redirect',
    'bess-html',
  ];
  const byId = new Map(checks.map((c) => [c.id, c]));
  const ordered = ids.map((id) => byId.get(id) || fail(id, 'check did not run'));
  return { ok: ordered.every((c) => c.ok), checks: ordered, origin: originNorm };
}

export function formatReport(result) {
  const lines = [`verify-bestanswer origin=${result.origin} overall=${result.ok ? 'PASS' : 'FAIL'}`];
  for (const c of result.checks) {
    lines.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`);
  }
  return lines.join('\n');
}

const isCli = Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);

if (isCli) {
  const origin = process.env.VERIFY_ORIGIN || DEFAULT_ORIGIN;
  runChecks({ origin }).then((result) => {
    console.log(formatReport(result));
    process.exit(result.ok ? 0 : 1);
  }).catch((e) => {
    console.error(`verify-bestanswer fatal: ${e.message}`);
    process.exit(1);
  });
}
