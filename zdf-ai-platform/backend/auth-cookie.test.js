import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function parseSetCookies(res, name = 'token') {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((header) => {
    const parts = String(header).split(';').map((s) => s.trim()).filter(Boolean);
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    const parsed = {
      header,
      name: eq >= 0 ? nv.slice(0, eq) : nv,
      value: eq >= 0 ? nv.slice(eq + 1) : '',
      path: undefined,
      secure: false,
      httpOnly: false,
      sameSite: undefined,
      expires: undefined,
      maxAge: undefined,
    };
    for (const a of attrs) {
      const [k, ...rest] = a.split('=');
      const key = k.trim().toLowerCase();
      const val = rest.join('=');
      if (key === 'path') parsed.path = val;
      else if (key === 'secure') parsed.secure = true;
      else if (key === 'httponly') parsed.httpOnly = true;
      else if (key === 'samesite') parsed.sameSite = val;
      else if (key === 'expires') parsed.expires = val;
      else if (key === 'max-age') parsed.maxAge = val;
    }
    return parsed;
  }).filter((c) => c.name === name);
}

function isCleared(cookie) {
  if (!cookie.value) return true;
  if (cookie.maxAge === '0') return true;
  if (cookie.expires) {
    const t = Date.parse(cookie.expires);
    if (!Number.isNaN(t) && t <= Date.now()) return true;
  }
  return false;
}

async function waitForHealth(child, url, logs, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited ${child.exitCode}: ${logs.join('')}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${lastErr}\n${logs.join('')}`);
}

describe('auth cookie path/Secure and cookie-only history', { concurrency: false }, () => {
  let child;
  let base;
  const logs = [];
  const testUser = { username: `cookie_hist_${Date.now()}`, password: 'test1234' };

  before(async () => {
    const port = await getFreePort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BASE_PATH: '/BestAnswer',
        PORT: String(port),
        JWT_SECRET: 'test-jwt-secret-auth-cookie-history',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => logs.push(String(d)));
    child.stderr.on('data', (d) => logs.push(String(d)));
    base = `http://127.0.0.1:${port}/BestAnswer`;
    await waitForHealth(child, `${base}/api/health`, logs);

    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUser.username, password: testUser.password, name: 'Cookie History Test' }),
    });
    const regData = await regRes.json().catch(() => null);
    if (regRes.status !== 200) {
      throw new Error(`failed to register test user: ${regRes.status} ${JSON.stringify(regData)}`);
    }
  });

  after(() => {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
    }
  });

  async function login() {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUser.username, password: testUser.password }),
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  it('POST /auth/login in production with BASE_PATH=/BestAnswer sets Path=/BestAnswer and Secure', async () => {
    const { res, data } = await login();
    assert.equal(res.status, 200, `login failed: ${res.status} ${JSON.stringify(data)}`);
    assert.ok(data?.token);

    const cookies = parseSetCookies(res);
    const issued = cookies.find((c) => c.path === '/BestAnswer' && !isCleared(c));
    assert.ok(issued, `expected issued token Path=/BestAnswer, got ${JSON.stringify(cookies)}`);
    assert.equal(issued.secure, true);
    assert.equal(issued.httpOnly, true);
    assert.equal(String(issued.sameSite).toLowerCase(), 'lax');
    assert.ok(issued.value);

    const legacy = cookies.find((c) => c.path === '/');
    assert.ok(legacy, `expected leftover Path=/ token to be cleared, got ${JSON.stringify(cookies)}`);
    assert.equal(isCleared(legacy), true);
  });

  it('GET /user/history with only the token cookie returns 200 and a history array', async () => {
    const { res, data } = await login();
    assert.equal(res.status, 200);
    const issued = parseSetCookies(res).find((c) => c.path === '/BestAnswer' && !isCleared(c));
    assert.ok(issued?.value);

    const histRes = await fetch(`${base}/api/user/history`, {
      headers: { Cookie: `token=${issued.value}` },
    });
    const hist = await histRes.json().catch(() => null);
    assert.equal(histRes.status, 200);
    assert.ok(Array.isArray(hist?.history));
    assert.ok(data.token);
  });

  it('GET /user/history without credentials returns 401', async () => {
    const histRes = await fetch(`${base}/api/user/history`);
    const hist = await histRes.json().catch(() => null);
    assert.equal(histRes.status, 401);
    assert.ok(Array.isArray(hist?.history));
  });

  it('GET /user/history still works with Authorization Bearer and no cookie', async () => {
    const { res, data } = await login();
    assert.equal(res.status, 200);
    assert.ok(data?.token);

    const histRes = await fetch(`${base}/api/user/history`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    const hist = await histRes.json().catch(() => null);
    assert.equal(histRes.status, 200);
    assert.ok(Array.isArray(hist?.history));
  });

  it('POST /auth/logout clears the token cookie at Path=/BestAnswer and the old Path=/', async () => {
    const { res: loginRes } = await login();
    assert.equal(loginRes.status, 200);
    const issued = parseSetCookies(loginRes).find((c) => c.path === '/BestAnswer' && !isCleared(c));
    assert.ok(issued?.value);

    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `token=${issued.value}` },
    });
    const body = await logoutRes.json().catch(() => null);
    assert.equal(logoutRes.status, 200);
    assert.equal(body?.ok, true);

    const cookies = parseSetCookies(logoutRes);
    const atNewPath = cookies.find((c) => c.path === '/BestAnswer');
    const atOldPath = cookies.find((c) => c.path === '/');
    assert.ok(atNewPath, `expected cleared Path=/BestAnswer cookie, got ${JSON.stringify(cookies)}`);
    assert.ok(atOldPath, `expected cleared Path=/ cookie, got ${JSON.stringify(cookies)}`);
    assert.equal(isCleared(atNewPath), true);
    assert.equal(isCleared(atOldPath), true);
  });
});
