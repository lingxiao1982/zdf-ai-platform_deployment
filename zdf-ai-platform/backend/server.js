/**
 * ZDF.AI 最小可运行后端：JSON 持久化 + 多厂商调度（有 Key 则真调，无 Key 则结构化模拟）。
 * 启动：在 backend 目录 `npm i` 后 `npm start`；与前端同机时默认端口 3000。
 * 生产：可先 `npm run build` 再仅启动本服务，将自动托管 ../dist 静态资源（/api 除外）。
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'store.json');
const DIST_PATH = path.join(__dirname, '..', 'dist');

/** @returns {string} */
function parseUserIdFromAuth(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+session_token_(.+)$/i.exec(h.trim());
  return m ? m[1] : '';
}

function defaultAlerts() {
  return {
    email: '',
    phone: '',
    wechat: '',
    smtpServer: '',
    smtpPort: '',
    emailPwd: '',
    smsProvider: 'aliyun',
    smsAppKey: '',
  };
}

function defaultDb() {
  return {
    users: [
      {
        id: 'usr_admin',
        username: 'admin123',
        password: 'admin456',
        role: 'admin',
        roleDetail: 'super',
        name: '系统管理员',
        plan: 'enterprise',
        status: 'active',
        balance: 9999.0,
      },
    ],
    keys: {},
    settings: { isTestMode: true, alertsConfig: defaultAlerts() },
    logs: [],
    histories: {},
  };
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_PATH)) return defaultDb();
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = defaultDb().users;
    if (!data.keys || typeof data.keys !== 'object') data.keys = {};
    if (!data.settings) data.settings = defaultDb().settings;
    if (!Array.isArray(data.logs)) data.logs = [];
    if (!data.histories || typeof data.histories !== 'object') data.histories = {};
    return data;
  } catch {
    return defaultDb();
  }
}

function saveDb(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

const OPENAI_STYLE_VENDORS = {
  openai: { base: 'https://api.openai.com', path: '/v1/chat/completions' },
  deepseek: { base: 'https://api.deepseek.com', path: '/v1/chat/completions' },
  moonshot: { base: 'https://api.moonshot.cn', path: '/v1/chat/completions' },
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions' },
  alibaba: { base: 'https://dashscope.aliyuncs.com/compatible-mode', path: '/v1/chat/completions' },
};

/**
 * 将前端展示用模型名映射为各平台常用 API 模型 id。
 * @param {string} vendor
 * @param {string} model
 */
function resolveApiModel(vendor, model) {
  const m = (model || '').trim();
  if (vendor === 'openai') {
    if (/gpt-4o/i.test(m) && !/turbo/i.test(m)) return 'gpt-4o';
    if (/gpt-4-turbo/i.test(m)) return 'gpt-4-turbo';
    if (/3\.5/i.test(m)) return 'gpt-3.5-turbo';
    return 'gpt-4o-mini';
  }
  if (vendor === 'deepseek') {
    if (/coder/i.test(m)) return 'deepseek-coder';
    return 'deepseek-chat';
  }
  if (vendor === 'moonshot') return 'moonshot-v1-8k';
  if (vendor === 'zhipu') {
    if (/glm-4v/i.test(m)) return 'glm-4v';
    if (/glm-4/i.test(m)) return 'glm-4';
    return 'glm-3-turbo';
  }
  if (vendor === 'alibaba') {
    if (/qwen-max/i.test(m)) return 'qwen-max';
    if (/qwen-plus/i.test(m)) return 'qwen-plus';
    return 'qwen-turbo';
  }
  if (vendor === 'anthropic') {
    if (/opus/i.test(m)) return 'claude-3-opus-20240229';
    if (/haiku/i.test(m)) return 'claude-3-haiku-20240307';
    return 'claude-3-5-sonnet-20241022';
  }
  if (vendor === 'google') {
    if (/2\.5|2_5/i.test(m)) return 'gemini-2.5-flash-preview-05-20';
    if (/1\.5-pro/i.test(m)) return 'gemini-1.5-pro-latest';
    if (/1\.5/i.test(m)) return 'gemini-1.5-flash-latest';
    return 'gemini-2.0-flash';
  }
  return m.replace(/\s*\(.*?\)\s*/g, '').trim() || 'gpt-4o-mini';
}

/**
 * @param {string} baseUrl
 * @param {string} chatPath 如 /v1/chat/completions 或智谱 /chat/completions
 * @param {string} apiKey
 * @param {string} apiModel
 * @param {string} systemPrompt
 * @param {string} userText
 */
async function chatOpenAICompatible(baseUrl, chatPath, apiKey, apiModel, systemPrompt, userText) {
  const pathPart = chatPath.startsWith('/') ? chatPath : `/${chatPath}`;
  const url = `${baseUrl.replace(/\/$/, '')}${pathPart}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: apiModel,
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: userText },
      ],
      temperature: 0.7,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI兼容接口 ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error('OpenAI兼容接口无 choices 文本');
  return out;
}

async function chatAnthropic(apiKey, apiModel, systemPrompt, userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const blocks = data.content || [];
  const t = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (!t) throw new Error('Anthropic 无文本内容');
  return t;
}

async function chatGoogleGemini(apiKey, apiModel, systemPrompt, userText) {
  const model = apiModel.startsWith('models/') ? apiModel : `models/${apiModel}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: systemPrompt
        ? { parts: [{ text: systemPrompt }] }
        : undefined,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const out = parts.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini 无输出文本');
  return out;
}

/**
 * @param {{ vendor?: string, model?: string, mode?: string, selfKey?: string, roleId?: string }} dispatch
 * @param {Record<string, { value?: string }>} keysFromDb
 */
function resolveApiKey(dispatch, keysFromDb) {
  if (!dispatch) return '';
  if (dispatch.mode === 'self' && dispatch.selfKey && String(dispatch.selfKey).trim()) {
    return String(dispatch.selfKey).trim();
  }
  const vid = dispatch.vendor || 'openai';
  const row = keysFromDb[vid];
  return (row && row.value && String(row.value).trim()) || '';
}

function buildStubReply(dispatch, prompt, errMsg) {
  const role = dispatch?.roleId || '?';
  const vendor = dispatch?.vendor || 'unknown';
  const model = dispatch?.model || 'unknown';
  const mode = dispatch?.mode || 'platform';
  const head = errMsg ? `【调度测试 · 调用失败】${errMsg}\n` : `【调度测试 · 无可用 Key / 未适配厂商】\n`;
  return (
    `${head}` +
    `流水线角色: ${role}\n` +
    `路由: ${vendor} / ${model}（模式: ${mode}）\n\n` +
    `—— 以下为本地模拟正文（便于联调 UI）——\n` +
    `${(prompt || '').slice(0, 1200)}${(prompt || '').length > 1200 ? '\n…(截断)' : ''}`
  );
}

/**
 * @param {string} prompt
 * @param {string} systemPrompt
 * @param {{ vendor?: string, model?: string, mode?: string, selfKey?: string, roleId?: string }} dispatch
 * @param {Record<string, { value?: string }>} keysFromDb
 */
async function runDispatchLLM(prompt, systemPrompt, dispatch, keysFromDb) {
  const vendor = (dispatch?.vendor || 'openai').toLowerCase();
  const model = dispatch?.model || '';
  const apiKey = resolveApiKey(dispatch, keysFromDb);
  const apiModel = resolveApiModel(vendor, model);
  const userText = String(prompt || '');

  if (!apiKey) {
    return { text: buildStubReply(dispatch, prompt, ''), stub: true };
  }

  try {
    if (OPENAI_STYLE_VENDORS[vendor]) {
      const { base, path: chatPath } = OPENAI_STYLE_VENDORS[vendor];
      const text = await chatOpenAICompatible(base, chatPath, apiKey, apiModel, systemPrompt, userText);
      return { text, stub: false };
    }
    if (vendor === 'anthropic') {
      const text = await chatAnthropic(apiKey, apiModel, systemPrompt, userText);
      return { text, stub: false };
    }
    if (vendor === 'google') {
      const text = await chatGoogleGemini(apiKey, apiModel, systemPrompt, userText);
      return { text, stub: false };
    }
    return {
      text: buildStubReply(dispatch, prompt, `厂商「${vendor}」尚未接入真实 API，请使用 OpenAI/DeepSeek/Moonshot/智谱/阿里兼容或 Anthropic/Google。`),
      stub: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: buildStubReply(dispatch, prompt, msg), stub: true, error: msg };
  }
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '32mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'zdf-ai-platform-backend' });
});

app.get('/api/admin/system-data', (_req, res) => {
  const db = loadDb();
  res.json({
    users: db.users,
    isTestMode: db.settings.isTestMode,
    keys: db.keys,
    alerts: db.settings.alertsConfig,
    logs: db.logs,
  });
});

app.post('/api/admin/keys', (req, res) => {
  const db = loadDb();
  db.keys = { ...db.keys, ...(req.body || {}) };
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/settings', (req, res) => {
  const db = loadDb();
  const b = req.body || {};
  if (typeof b.isTestMode === 'boolean') db.settings.isTestMode = b.isTestMode;
  if (b.alertsConfig && typeof b.alertsConfig === 'object') {
    db.settings.alertsConfig = { ...defaultAlerts(), ...b.alertsConfig };
  }
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/users', (req, res) => {
  const db = loadDb();
  if (Array.isArray(req.body)) db.users = req.body;
  else if (Array.isArray(req.body?.users)) db.users = req.body.users;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/logs', (req, res) => {
  const db = loadDb();
  if (Array.isArray(req.body)) db.logs = req.body;
  else if (Array.isArray(req.body?.logs)) db.logs = req.body.logs;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/auth/register', (req, res) => {
  const db = loadDb();
  const u = req.body;
  if (!u || !u.username) return res.status(400).json({ ok: false, error: 'invalid user' });
  if (db.users.some((x) => x.username === u.username)) {
    return res.status(409).json({ ok: false, error: 'username exists' });
  }
  db.users.push(u);
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/user/history', (req, res) => {
  const uid = parseUserIdFromAuth(req);
  if (!uid) return res.status(401).json({ history: [] });
  const db = loadDb();
  res.json({ history: db.histories[uid] || [] });
});

app.post('/api/user/history', (req, res) => {
  const uid = parseUserIdFromAuth(req);
  if (!uid) return res.status(401).json({ ok: false });
  const db = loadDb();
  const entry = req.body?.entry;
  if (!entry) return res.status(400).json({ ok: false });
  if (!db.histories[uid]) db.histories[uid] = [];
  db.histories[uid].unshift(entry);
  db.histories[uid] = db.histories[uid].slice(0, 200);
  saveDb(db);
  res.json({ ok: true });
});

/** 管理员「测试 Key」：真实探测各兼容接口 */
app.post('/api/admin/test-key', async (req, res) => {
  const vendorId = String(req.body?.vendorId || '').toLowerCase();
  const key = String(req.body?.key || '').trim();
  if (!vendorId || !key) return res.status(400).json({ ok: false, error: 'missing vendorId or key' });

  const fakeDispatch = { vendor: vendorId, model: 'gpt-4o-mini', mode: 'platform', roleId: 'test' };
  const keys = { [vendorId]: { value: key } };

  try {
    const { text, stub, error } = await runDispatchLLM('ping', 'Reply with exactly: OK', fakeDispatch, keys);
    if (!stub) return res.json({ ok: true, msg: (text || '').slice(0, 120) });
    return res.json({ ok: false, msg: (error || text || 'stub').slice(0, 400) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.json({ ok: false, msg });
  }
});

app.post('/api/ai/generate', async (req, res) => {
  const prompt = req.body?.prompt ?? '';
  const systemPrompt = req.body?.systemPrompt ?? '';
  const dispatch = req.body?.dispatch || null;

  const db = loadDb();
  const { text, stub } = await runDispatchLLM(prompt, systemPrompt, dispatch, db.keys);

  res.json({
    result: text,
    text,
    meta: { stub, vendor: dispatch?.vendor, model: dispatch?.model, roleId: dispatch?.roleId },
  });
});

// 单进程托管前端构建产物（云端一键：先 build 前端再启动本服务）
if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.get(/^(?!\/api).*/, (req, res) => {
    if (req.path.includes('.')) return res.status(404).end();
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[zdf-backend] listening on http://0.0.0.0:${PORT}`);
  if (fs.existsSync(DIST_PATH)) console.log(`[zdf-backend] serving static from ${DIST_PATH}`);
  else console.log('[zdf-backend] dist/ 不存在，仅 API；开发时请与 Vite 同开或先 npm run build');
});
