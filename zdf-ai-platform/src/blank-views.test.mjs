/**
 * Frozen acceptance: BestAnswer blank/white-screen menu views (t218u).
 * Visiting each of the 6 crashing views must render without throw.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = join(HERE, 'App.jsx');

const CRASH_VIEWS = [
  { role: 'admin', nav: '升级审批', heading: '套餐升级审批' },
  { role: 'admin', nav: '订单管理', heading: '订单与支付管理' },
  { role: 'admin', nav: '工作流编排', heading: '工作流编排引擎' },
  { role: 'admin', nav: 'SLA 保障', heading: 'SLA 服务等级协议' },
  { role: 'admin', nav: '私有化部署', heading: '私有化部署管理' },
  { role: 'user', navTitle: '知识库', heading: '知识库管理' },
];

const WORKING_ADMIN = [
  '数据看板', '用户管线', '系统接口配置', '厂商与模型管理',
  '管理员与权限', '运行与告警日志', '全局与告警设置', 'Prompt 模板',
];
const WORKING_USER_TITLES = ['调度中心', '历史记录', '账户设置'];

function installBrowserShims() {
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.sessionStorage = sessionStorage;
  globalThis.window = {
    sessionStorage,
    location: { origin: 'http://localhost', search: '', pathname: '/', href: 'http://localhost/' },
    history: { replaceState() {} },
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      requests: [],
      orders: [],
      workflows: [],
      docs: [],
      orgs: [],
      members: [],
      results: [],
      templates: [],
      history: [],
      today: { tasks: 0, credits: 0 },
      storage: { usedBytes: 0, quotaMB: -1 },
    }),
  });
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  globalThis.prompt = () => '';
}

function treeText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(treeText).join('');
  if (typeof node === 'object') return treeText(node.children);
  return '';
}

function findIifeHookViolations(src) {
  const hits = [];
  const startRe = /\(\(\)\s*=>\s*\{/g;
  let m;
  while ((m = startRe.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const block = src.slice(m.index, i);
    if (/\b(?:React\.)?use(?:State|Effect|Ref|Callback|Memo)\s*\(/.test(block)) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push({ line, excerpt: block.replace(/\s+/g, ' ').slice(0, 100) });
    }
  }
  return hits;
}

function clickButton(root, pred) {
  const buttons = root.findAll((n) => n.type === 'button' && typeof n.props?.onClick === 'function');
  const match = buttons.find(pred);
  assert.ok(match, `expected a matching button in the tree (found ${buttons.length} buttons)`);
  act(() => { match.props.onClick(); });
}

function buttonHasLabel(node, label) {
  return instanceText(node).includes(label);
}

const ADMIN_PERMS = [
  'admin.overview', 'admin.users', 'admin.keys', 'admin.models',
  'admin.revoke', 'admin.logs', 'admin.settings',
];

const adminAuth = {
  id: 'adm1',
  username: 'admin123',
  name: 'Admin',
  role: 'admin',
  roleDetail: 'super',
  plan: 'enterprise',
  permissions: ADMIN_PERMS,
};

const userAuth = {
  id: 'u1',
  username: 'user1',
  name: 'User',
  role: 'user',
  plan: 'enterprise',
};

const noop = () => {};

installBrowserShims();

const { AdminApp, UserApp, FALLBACK_VENDORS } = await import('./App.jsx');

function instanceText(inst) {
  if (inst == null) return '';
  if (typeof inst === 'string' || typeof inst === 'number') return String(inst);
  if (!inst.children) return '';
  return inst.children.map(instanceText).join('');
}

function mountAdmin() {
  let renderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(AdminApp, {
        auth: adminAuth,
        onLogout: noop,
        dbUsers: [],
        setDbUsers: noop,
        isTestMode: true,
        setIsTestMode: noop,
        adminKeys: {},
        setAdminKeys: noop,
        alertsConfig: {},
        setAlertsConfig: noop,
        dbLogs: [],
        setDbLogs: noop,
        vendors: FALLBACK_VENDORS,
        setVendors: noop,
        strategy: 'fusion',
        setStrategy: noop,
        onSwitchToUser: noop,
        adminTemplates: [],
        setAdminTemplates: noop,
      }),
    );
  });
  return renderer;
}

function mountUser() {
  let renderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(UserApp, {
        auth: userAuth,
        onLogout: noop,
        isTestMode: true,
        dbKeys: {},
        dbUsers: [],
        vendors: FALLBACK_VENDORS,
        strategy: 'fusion',
        onSwitchToAdmin: noop,
        onUpdateAuth: noop,
      }),
    );
  });
  return renderer;
}

describe('BestAnswer blank-view acceptance (t218u)', () => {
  before(() => {
    assert.equal(typeof AdminApp, 'function');
    assert.equal(typeof UserApp, 'function');
  });

  it('App.jsx does not call hooks inside IIFEs', () => {
    const src = readFileSync(APP_SRC, 'utf8');
    const hits = findIifeHookViolations(src);
    assert.deepEqual(hits, [], `hooks inside IIFEs crash tab switches:\n${hits.map((h) => `  L${h.line}: ${h.excerpt}`).join('\n')}`);
  });

  it('Admin starts on 数据看板 then each crashing view renders without throw', () => {
    const renderer = mountAdmin();
    const overview = treeText(renderer.toJSON());
    assert.match(overview, /数据看板|数据中心/);

    for (const view of CRASH_VIEWS.filter((v) => v.role === 'admin')) {
      assert.doesNotThrow(() => {
        clickButton(renderer.root, (n) => buttonHasLabel(n, view.nav));
      }, `clicking ${view.nav} must not throw`);
      const text = treeText(renderer.toJSON());
      assert.ok(text.includes(view.heading), `${view.nav} must show "${view.heading}", got: ${text.slice(0, 200)}`);
    }
    renderer.unmount();
  });

  it('User starts on 调度中心 then 知识库 renders without throw', () => {
    const renderer = mountUser();
    const start = treeText(renderer.toJSON());
    assert.ok(start.includes('调度设置') || start.includes('调度中心'), `expected dispatch view, got: ${start.slice(0, 200)}`);

    const rag = CRASH_VIEWS.find((v) => v.role === 'user');
    assert.doesNotThrow(() => {
      clickButton(renderer.root, (n) => n.props?.title === rag.navTitle);
    }, 'clicking 知识库 must not throw');
    const text = treeText(renderer.toJSON());
    assert.ok(text.includes(rag.heading), `知识库 must show "${rag.heading}", got: ${text.slice(0, 200)}`);
    renderer.unmount();
  });

  it('working Admin tabs still render', () => {
    const renderer = mountAdmin();
    for (const label of WORKING_ADMIN) {
      assert.doesNotThrow(() => {
        clickButton(renderer.root, (n) => buttonHasLabel(n, label));
      }, `working tab ${label} must not throw`);
    }
    renderer.unmount();
  });

  it('working User tabs still render', () => {
    const renderer = mountUser();
    for (const title of WORKING_USER_TITLES) {
      assert.doesNotThrow(() => {
        clickButton(renderer.root, (n) => n.props?.title === title);
      }, `working tab ${title} must not throw`);
    }
    renderer.unmount();
  });
});
