import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = 'http://localhost:3000/api';
let adminToken = '';
let userToken = '';
let testUserId = '';

async function api(path, opts = {}) {
  const { method = 'GET', body, token } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('ZDF.AI Backend API Tests', { concurrency: false }, () => {
  describe('Health & Auth', () => {
    it('GET /health returns ok', async () => {
      const { status, data } = await api('/health');
      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('POST /auth/login with bad credentials returns 401', async () => {
      const { status } = await api('/auth/login', { method: 'POST', body: { username: 'nonexist', password: 'wrong' } });
      assert.equal(status, 401);
    });

    it('POST /auth/login with admin credentials returns token', async () => {
      const { status, data } = await api('/auth/login', { method: 'POST', body: { username: 'admin123', password: 'admin456' } });
      assert.equal(status, 200);
      assert.ok(data.token);
      assert.equal(data.user.role, 'admin');
      adminToken = data.token;
    });

    it('POST /auth/register creates new user', async () => {
      const username = `testuser_${Date.now()}`;
      const { status, data } = await api('/auth/register', { method: 'POST', body: { username, password: 'test1234', name: 'Test User' } });
      assert.equal(status, 200);
      assert.ok(data.token);
      assert.ok(['free', 'pro'].includes(data.user.plan));
      userToken = data.token;
      testUserId = data.user.id;
    });
  });

  describe('User Endpoints', () => {
    it('GET /user/usage returns usage data', async () => {
      const { status, data } = await api('/user/usage', { token: userToken });
      assert.equal(status, 200);
      assert.ok(data.today);
      assert.ok(data.limits);
    });

    it('GET /user/history returns array', async () => {
      const { status, data } = await api('/user/history', { token: userToken });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.history));
    });

    it('GET /prompt-templates returns templates array', async () => {
      const { status, data } = await api('/prompt-templates', { token: userToken });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.templates));
    });

    it('GET /user/upgrade-requests returns requests', async () => {
      const { status, data } = await api('/user/upgrade-requests', { token: userToken });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.requests));
    });

    it('POST /user/upgrade-request submits upgrade', async () => {
      const { status, data } = await api('/user/upgrade-request', { method: 'POST', token: userToken, body: { toPlan: 'enterprise', message: 'test upgrade' } });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.request.toPlan, 'enterprise');
      assert.equal(data.request.status, 'pending');
    });

    it('POST /user/upgrade-request rejects duplicate', async () => {
      const { status, data } = await api('/user/upgrade-request', { method: 'POST', token: userToken, body: { toPlan: 'enterprise', message: 'duplicate' } });
      assert.equal(status, 400);
      assert.ok(data.error.includes('待审核'));
    });
  });

  describe('Admin Endpoints', () => {
    it('GET /admin/system-data returns full system state', async () => {
      const { status, data } = await api('/admin/system-data', { token: adminToken });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.users));
      assert.ok(Array.isArray(data.logs));
      assert.ok(Array.isArray(data.vendors));
      assert.ok(Array.isArray(data.promptTemplates));
      for (const u of data.users) {
        assert.equal(u.password, undefined, `Password leaked for user ${u.username}`);
      }
    });

    it('GET /admin/usage-stats returns stats', async () => {
      const { status, data } = await api('/admin/usage-stats', { token: adminToken });
      assert.equal(status, 200);
      assert.ok(data.today);
      assert.ok(typeof data.today.totalTasks === 'number');
    });

    it('GET /admin/upgrade-requests returns all requests', async () => {
      const { status, data } = await api('/admin/upgrade-requests', { token: adminToken });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.requests));
      assert.ok(data.requests.length > 0, 'Should have at least one upgrade request from earlier test');
    });

    it('POST /admin/upgrade-requests/:id/review approves request', async () => {
      const list = await api('/admin/upgrade-requests', { token: adminToken });
      const pending = list.data.requests.find(r => r.status === 'pending' && r.userId === testUserId);
      assert.ok(pending, 'No pending request found for test user');
      const { status, data } = await api(`/admin/upgrade-requests/${pending.id}/review`, {
        method: 'POST', token: adminToken, body: { action: 'approve', note: 'test approval' },
      });
      assert.equal(status, 200);
      assert.equal(data.request.status, 'approved');
    });

    it('non-admin cannot access admin endpoints', async () => {
      const { status } = await api('/admin/system-data', { token: userToken });
      assert.ok([401, 403].includes(status));
    });

    it('GET /admin/rag-stats returns stats', async () => {
      const { status, data } = await api('/admin/rag-stats', { token: adminToken });
      assert.equal(status, 200);
      assert.ok(typeof data.totalDocs === 'number');
    });
  });

  describe('AI Generate (stub mode)', () => {
    it('POST /ai/generate returns result even without API keys', async () => {
      const { status, data } = await api('/ai/generate', {
        method: 'POST',
        token: userToken,
        body: { prompt: 'Hello world', systemPrompt: 'Reply OK' },
      });
      assert.equal(status, 200);
      assert.ok(data.result || data.text);
    });
  });

  describe('Password Change', () => {
    it('POST /auth/change-password with wrong old password fails', async () => {
      const { status } = await api('/auth/change-password', {
        method: 'POST', token: userToken, body: { oldPassword: 'wrongpw', newPassword: 'newpass123' },
      });
      assert.ok(status >= 400);
    });
  });

  describe('Password reset code matching', () => {
    const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'store.json');
    const email = `reset_${Date.now()}@example.com`;
    let resetUserPass = 'test1234';

    it('rejects a 1-character prefix and accepts the exact 8-character code', async () => {
      const username = `resetuser_${Date.now()}`;
      const reg = await api('/auth/register', {
        method: 'POST',
        body: { username, password: resetUserPass, name: 'Reset User', email },
      });
      assert.equal(reg.status, 200);

      const forgot = await api('/auth/forgot-password', { method: 'POST', body: { email } });
      assert.equal(forgot.status, 200);

      const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      const user = db.users.find(u => u.email === email);
      assert.ok(user);
      const row = (db.resetTokens || []).find(t => t.userId === user.id);
      assert.ok(row && row.token, 'reset token should be persisted');

      const prefix1 = await api('/auth/reset-password', {
        method: 'POST',
        body: { email, code: row.token.slice(0, 1), newPassword: 'newpass123' },
      });
      assert.equal(prefix1.status, 400, '1-character prefix must not reset the password');

      const exact = await api('/auth/reset-password', {
        method: 'POST',
        body: { email, code: row.token.slice(0, 8), newPassword: 'newpass123' },
      });
      assert.equal(exact.status, 200);
    });
  });

  describe('OAuth github initiate (no store write, cookie-bound state)', () => {
    const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'store.json');

    it('does not persist oauthStates when starting GitHub OAuth', async () => {
      const cfg = await api('/admin/oauth-config', {
        method: 'POST',
        token: adminToken,
        body: { github: { clientId: 'test_github_client_id' } },
      });
      assert.equal(cfg.status, 200);

      const before = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      const beforeStates = JSON.stringify(before.oauthStates || []);
      const beforeSize = fs.statSync(STORE).size;

      const res = await fetch(`${BASE}/auth/github`);
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.ok(data.url && data.url.includes('state='));

      const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      assert.ok(setCookie.some(c => String(c).includes('oauth_state_github=')), `expected oauth_state_github cookie, got ${JSON.stringify(setCookie)}`);

      const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      assert.equal(JSON.stringify(after.oauthStates || []), beforeStates);
      assert.equal(fs.statSync(STORE).size, beforeSize);
    });

    it('rejects callback when the state cookie is missing or does not match', async () => {
      const start = await fetch(`${BASE}/auth/github`);
      assert.equal(start.status, 200);
      const body = await start.json();
      const state = new URL(body.url).searchParams.get('state');
      assert.ok(state);

      const setCookie = typeof start.headers.getSetCookie === 'function'
        ? start.headers.getSetCookie()
        : [start.headers.get('set-cookie')].filter(Boolean);
      const cookieHeader = setCookie.map(c => String(c).split(';')[0]).join('; ');

      const noCookie = await fetch(`${BASE}/auth/github/callback?code=dummy&state=${encodeURIComponent(state)}`);
      const noCookieText = await noCookie.text();
      assert.equal(noCookie.status, 400);
      assert.match(noCookieText, /Invalid or expired OAuth state/);

      const mismatch = await fetch(`${BASE}/auth/github/callback?code=dummy&state=not-the-cookie`, {
        headers: { Cookie: cookieHeader },
      });
      const mismatchText = await mismatch.text();
      assert.equal(mismatch.status, 400);
      assert.match(mismatchText, /Invalid or expired OAuth state/);
    });
  });
});
