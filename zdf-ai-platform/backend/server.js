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
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import writeFileAtomic from 'write-file-atomic';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import Stripe from 'stripe';
import CryptoJS from 'crypto-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'store.json');
const DIST_PATH = path.join(__dirname, '..', 'dist');
const RAG_DIR = path.join(__dirname, 'data', 'rag');
const JWT_SECRET = process.env.JWT_SECRET || ('zdf_ai_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const BCRYPT_ROUNDS = 10;
if (!process.env.JWT_SECRET) {
  console.warn('[安全警告] 未设置 JWT_SECRET 环境变量，已生成随机密钥。生产环境请务必设置: export JWT_SECRET="你的强密码"');
  console.warn('[安全警告] 服务器重启后旧 token 将全部失效（因为随机密钥每次不同）');
}

// --- Stripe 支付配置 ---
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// RAG 文件上传配置
const ragStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(RAG_DIR, req.userId || 'unknown');
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}_${Buffer.from(file.originalname, 'latin1').toString('utf8')}`),
});
const RAG_ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json', '.log', '.pdf', '.docx'];
const ragUpload = multer({
  storage: ragStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(Buffer.from(file.originalname, 'latin1').toString('utf8')).toLowerCase();
    if (RAG_ALLOWED_EXTS.includes(ext)) cb(null, true);
    else cb(new Error(`不支持的文件类型 ${ext}，仅允许: ${RAG_ALLOWED_EXTS.join(', ')}`));
  },
});

/** 判断密码是否已经是 bcrypt hash */
function isHashed(pw) { return typeof pw === 'string' && /^\$2[aby]\$/.test(pw); }

/** 验证密码（兼容明文和 hash） */
async function verifyPassword(plain, stored) {
  if (isHashed(stored)) return bcrypt.compare(plain, stored);
  return plain === stored;
}

/** 从 JWT token 解析用户 ID，兼容旧的 session_token_xxx 格式 */
function parseUserIdFromAuth(req) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) return '';
  // 兼容旧格式 session_token_xxx
  const legacy = /^session_token_(.+)$/i.exec(token);
  if (legacy) return legacy[1];
  // JWT 解析
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.userId || '';
  } catch { return ''; }
}

/** 简易 cookie 解析 (避免额外依赖) */
function parseCookies(req) {
  const str = req.headers.cookie || '';
  const obj = {};
  str.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
  });
  return obj;
}

/** Express 中间件：解析并注入 req.userId, req.userRole */
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  let token = h.replace(/^Bearer\s+/i, '').trim();
  // 优先从 httpOnly cookie 读取 (L02: 防 XSS)
  if (!token) {
    const cookies = parseCookies(req);
    token = cookies.token || '';
  }
  if (!token) { req.userId = ''; req.userRole = ''; return next(); }
  // 兼容旧格式
  const legacy = /^session_token_(.+)$/i.exec(token);
  if (legacy) {
    req.userId = legacy[1];
    const db = loadDb();
    const u = db.users.find(u => u.id === legacy[1]);
    req.userRole = u?.role || '';
    req.userPlan = u?.plan || 'free';
    return next();
  }
  // 用户 API Key (zdf_ak_xxx)
  if (token.startsWith('zdf_ak_')) {
    const db = loadDb();
    const akRow = (db.userApiKeys || []).find(k => k.key === token);
    if (akRow) {
      const u = db.users.find(u => u.id === akRow.userId);
      if (u && u.status === 'active') {
        req.userId = u.id; req.userRole = u.role || ''; req.userPlan = u.plan || 'free';
        akRow.lastUsed = new Date().toISOString();
        saveDb(db);
        return next();
      }
    }
    req.userId = ''; req.userRole = ''; req.userPlan = 'free';
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId || '';
    req.userRole = payload.role || '';
    req.userPlan = payload.plan || 'free';
    next();
  } catch {
    req.userId = ''; req.userRole = ''; req.userPlan = 'free';
    next();
  }
}

/** 要求必须登录的中间件 */
function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: '未登录或 Token 已过期' });
  next();
}

/** 要求管理员权限的中间件 */
function requireAdmin(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: '未登录' });
  if (req.userRole !== 'admin') return res.status(403).json({ ok: false, error: '权限不足' });
  next();
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
    smsAppKey: '',       // 格式: AccessKeyId:AccessKeySecret
    smsSign: 'ZDF.AI',   // 阿里云短信签名
    smsTemplate: '',     // 阿里云短信模板编号 如 SMS_123456
    webhookWechat: '',   // 企业微信 Webhook URL
    webhookDingtalk: '', // 钉钉 Webhook URL
  };
}

/** 发送 Webhook 告警（企业微信 / 钉钉） */
async function sendWebhookAlert(alertsConfig, title, content) {
  const results = [];
  const wechatUrl = (alertsConfig.webhookWechat || '').trim();
  const dingtalkUrl = (alertsConfig.webhookDingtalk || '').trim();

  // 企业微信 Webhook
  if (wechatUrl) {
    try {
      const r = await fetch(wechatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content: `### ${title}\n${content}\n> ZDF.AI 系统自动告警` },
        }),
      });
      const data = await r.json().catch(() => ({}));
      results.push({ channel: 'wechat', ok: data.errcode === 0, msg: data.errmsg || r.statusText });
    } catch (e) {
      results.push({ channel: 'wechat', ok: false, msg: e.message });
    }
  }

  // 钉钉 Webhook
  if (dingtalkUrl) {
    try {
      const r = await fetch(dingtalkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title, text: `### ${title}\n${content}\n\n> ZDF.AI 系统自动告警` },
        }),
      });
      const data = await r.json().catch(() => ({}));
      results.push({ channel: 'dingtalk', ok: data.errcode === 0, msg: data.errmsg || r.statusText });
    } catch (e) {
      results.push({ channel: 'dingtalk', ok: false, msg: e.message });
    }
  }

  return results;
}

/** 发送邮件告警 (SMTP via nodemailer) */
async function sendEmailAlert(alertsConfig, title, content) {
  const server = (alertsConfig.smtpServer || '').trim();
  const port = Number(alertsConfig.smtpPort) || 465;
  const email = (alertsConfig.email || '').trim();
  const pwd = (alertsConfig.emailPwd || '').trim();
  if (!server || !email || !pwd) return [];
  try {
    const transporter = nodemailer.createTransport({
      host: server,
      port,
      secure: port === 465,
      auth: { user: email, pass: pwd },
      tls: { rejectUnauthorized: false },
    });
    const info = await transporter.sendMail({
      from: `"ZDF.AI 告警" <${email}>`,
      to: email,
      subject: `[ZDF.AI] ${title}`,
      html: `<h2>${title}</h2><pre>${content}</pre><hr><p style="color:#999">ZDF.AI 系统自动告警</p>`,
    });
    return [{ channel: 'email', ok: true, msg: info.messageId }];
  } catch (e) {
    return [{ channel: 'email', ok: false, msg: e.message }];
  }
}

/** 添加审计日志 */
function addLog(db, type, user, action, detail) {
  if (!db.logs) db.logs = [];
  db.logs.push({ ts: new Date().toISOString(), type, user, action, detail });
  if (db.logs.length > 5000) db.logs = db.logs.slice(-5000);
}

/** 套餐限额配置 */
const PLAN_LIMITS = {
  free:       { dailyTasks: 20,  concurrency: 1,  contextChars: 32000,  historyDays: 7,  canExport: false, canApi: false, ragQuotaMB: 100   },
  pro:        { dailyTasks: 500, concurrency: 5,  contextChars: 256000, historyDays: -1, canExport: true,  canApi: true,  ragQuotaMB: 10240 },
  enterprise: { dailyTasks: -1,  concurrency: 50, contextChars: -1,     historyDays: -1, canExport: true,  canApi: true,  ragQuotaMB: -1    },
  max:        { dailyTasks: -1,  concurrency: 50, contextChars: -1,     historyDays: -1, canExport: true,  canApi: true,  ragQuotaMB: -1    },
};

/** RBAC 权限定义 — roleDetail 级别 */
const RBAC_PERMISSIONS = {
  super:    ['admin.overview', 'admin.users', 'admin.keys', 'admin.settings', 'admin.alerts', 'admin.models', 'admin.templates', 'admin.logs', 'admin.revoke', 'admin.usage', 'user.chat', 'user.history', 'user.export', 'user.api', 'user.rag', 'user.profile'],
  operator: ['admin.overview', 'admin.logs', 'admin.usage', 'admin.models', 'admin.templates', 'user.chat', 'user.history', 'user.export', 'user.profile'],
  user:     ['user.chat', 'user.history', 'user.profile'],
};

function getUserPermissions(user) {
  const rd = user?.roleDetail || (user?.role === 'admin' ? 'super' : 'user');
  const base = RBAC_PERMISSIONS[rd] || RBAC_PERMISSIONS.user;
  // 套餐级权限叠加
  const plan = user?.plan || 'free';
  const perms = [...base];
  if (['pro', 'enterprise', 'max'].includes(plan)) { if (!perms.includes('user.export')) perms.push('user.export'); if (!perms.includes('user.api')) perms.push('user.api'); }
  if (['enterprise', 'max'].includes(plan)) { if (!perms.includes('user.rag')) perms.push('user.rag'); }
  return perms;
}

function requirePermission(perm) {
  return (req, res, next) => {
    const db = loadDb();
    const user = db.users.find(u => u.id === req.userId);
    const perms = getUserPermissions(user);
    if (!perms.includes(perm)) return res.status(403).json({ ok: false, error: `权限不足: 需要 ${perm}` });
    next();
  };
}

/** 在线并发计数器 (内存) — key: userId, value: 当前并发数 */
const concurrencyMap = new Map();
/** 并发等待队列 — key: userId, value: resolve[] */
const concurrencyQueue = new Map();

const MAX_QUEUE_SIZE = 10;
const QUEUE_TIMEOUT_MS = 30_000;

function acquireConcurrency(userId, limit) {
  const current = concurrencyMap.get(userId) || 0;
  if (current < limit) {
    concurrencyMap.set(userId, current + 1);
    return Promise.resolve(true);
  }
  // 检查队列长度上限
  const q = concurrencyQueue.get(userId) || [];
  if (q.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new Error('服务器繁忙，请求排队已满，请稍后再试'));
  }
  // 排队等待 + 超时
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // 超时：从队列中移除自己
      const queue = concurrencyQueue.get(userId) || [];
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      if (queue.length === 0) concurrencyQueue.delete(userId);
      else concurrencyQueue.set(userId, queue);
      reject(new Error('排队等待超时（30秒），请稍后再试'));
    }, QUEUE_TIMEOUT_MS);
    const entry = (ok) => { clearTimeout(timer); resolve(ok); };
    q.push(entry);
    concurrencyQueue.set(userId, q);
  });
}

function releaseConcurrency(userId) {
  const current = concurrencyMap.get(userId) || 1;
  const q = concurrencyQueue.get(userId) || [];
  if (q.length > 0) {
    const next = q.shift();
    if (q.length === 0) concurrencyQueue.delete(userId);
    else concurrencyQueue.set(userId, q);
    next(true); // 下一个请求可以继续
  } else {
    concurrencyMap.set(userId, Math.max(0, current - 1));
  }
}

/** 获取今日日期键 (YYYY-MM-DD) */
function todayKey() { return new Date().toISOString().slice(0, 10); }

const DEFAULT_PROMPT_TEMPLATES = [
  { id: 'tpl_1', category: '写作', title: '商业报告生成', desc: '生成专业的商业分析报告', prompt: '请根据以下主题撰写一份专业的商业分析报告，包含：\n1. 执行摘要\n2. 市场分析\n3. 竞争格局\n4. SWOT分析\n5. 建议与结论\n\n主题：{input}', icon: 'FileText', plan: 'free' },
  { id: 'tpl_2', category: '写作', title: '营销文案', desc: '生成吸引人的营销推广文案', prompt: '请为以下产品/服务撰写营销文案，要求：\n- 标题吸引眼球\n- 突出核心卖点\n- 包含行动召唤(CTA)\n- 适合社交媒体传播\n\n产品/服务：{input}', icon: 'Megaphone', plan: 'free' },
  { id: 'tpl_3', category: '分析', title: '数据分析助手', desc: '帮助分析和解读数据', prompt: '请分析以下数据/信息，提供：\n1. 关键发现\n2. 趋势分析\n3. 异常点识别\n4. 可行性建议\n\n数据/信息：{input}', icon: 'BarChart3', plan: 'free' },
  { id: 'tpl_4', category: '分析', title: '法律条款审核', desc: '审核合同和法律文本', prompt: '请以专业法律顾问的视角审核以下合同/条款：\n1. 识别潜在风险条款\n2. 标注模糊或不利表述\n3. 提供修改建议\n4. 合规性评估\n\n合同/条款内容：{input}', icon: 'Scale', plan: 'pro' },
  { id: 'tpl_5', category: '编程', title: '代码审查', desc: 'AI 代码审查和优化建议', prompt: '请对以下代码进行审查，从以下维度分析：\n1. 代码质量与可读性\n2. 性能优化建议\n3. 安全漏洞检查\n4. 最佳实践建议\n5. 重构方案\n\n代码：\n{input}', icon: 'Code', plan: 'pro' },
  { id: 'tpl_6', category: '编程', title: 'API 文档生成', desc: '根据代码自动生成 API 文档', prompt: '请根据以下代码/接口信息生成标准的 API 文档，包含：\n- 接口描述\n- 请求方法和URL\n- 请求参数（表格）\n- 响应示例\n- 错误码说明\n\n代码/信息：{input}', icon: 'BookOpen', plan: 'pro' },
  { id: 'tpl_7', category: '翻译', title: '专业翻译（中英）', desc: '高质量中英文互译', prompt: '请将以下内容进行专业翻译。要求：\n- 保持原文语义和语气\n- 使用地道的目标语言表达\n- 专业术语准确\n- 如有歧义请注明\n\n原文：{input}', icon: 'Languages', plan: 'free' },
  { id: 'tpl_8', category: '决策', title: '多维度决策分析', desc: '4级流水线深度决策分析', prompt: '请对以下决策问题进行多维度深度分析：\n1. 问题拆解\n2. 利弊分析（用评分矩阵）\n3. 风险评估\n4. 最优方案推荐\n5. 实施路线图\n\n决策问题：{input}', icon: 'Target', plan: 'pro' },
  { id: 'tpl_9', category: '创意', title: '头脑风暴', desc: '激发创意和新想法', prompt: '请围绕以下主题进行头脑风暴，生成至少10个创意方案：\n- 每个方案包含：名称、简述、可行性评分(1-5)\n- 从不同角度和维度思考\n- 包含1-2个"疯狂"的创意\n\n主题：{input}', icon: 'Lightbulb', plan: 'free' },
  { id: 'tpl_10', category: '企业', title: '会议纪要整理', desc: '将会议内容结构化整理', prompt: '请将以下会议记录整理为标准会议纪要：\n1. 会议基本信息\n2. 议题与讨论要点\n3. 决议事项\n4. 待办任务（含负责人和截止日期）\n5. 下次会议安排\n\n会议记录：{input}', icon: 'ClipboardList', plan: 'enterprise' },
];

const DEFAULT_WORKFLOWS = [
  {
    id: 'wf_default_pipeline', name: '四级决策流水线', builtin: true, active: true,
    steps: [
      { id: 'A', role: '生成者', systemPrompt: '直接回答用户问题。', inputTemplate: '{input}' },
      { id: 'B', role: '校核者', systemPrompt: '你是一个严格的事实校核员。', inputTemplate: '问题: {input}\n初稿:\n{A}\n任务: 事实校核。' },
      { id: 'C', role: '审核者', systemPrompt: '你是一个专业的审核专家。', inputTemplate: '校核稿:\n{B}\n任务: 润色。' },
      { id: 'D', role: '终审者', systemPrompt: '', inputTemplate: '原始问题: {input}\n\n阶段A（生成者）输出:\n{A}\n\n阶段B（校核者）输出:\n{B}\n\n阶段C（审核者）输出:\n{C}\n\n任务: 作为终审者，根据策略输出最终纯文本结果。' },
    ],
  },
  {
    id: 'wf_single', name: '快速单模型', builtin: true, active: true,
    steps: [{ id: 'A', role: '直接生成', systemPrompt: '', inputTemplate: '{input}' }],
  },
  {
    id: 'wf_cross_verify', name: '双模型交叉验证', builtin: true, active: true,
    steps: [
      { id: 'A', role: '生成者 A', systemPrompt: '请直接回答用户问题。', inputTemplate: '{input}' },
      { id: 'B', role: '独立生成 B', systemPrompt: '请独立回答用户问题，提供你自己的分析。', inputTemplate: '{input}' },
      { id: 'C', role: '比对合并', systemPrompt: '请比较以下两个独立回答，取其精华合并为一个最佳答案。', inputTemplate: '问题: {input}\n\n回答A:\n{A}\n\n回答B:\n{B}\n\n请合并出最佳答案。' },
    ],
  },
];

function defaultDb() {
  return {
    users: [
      {
        id: 'usr_admin',
        username: 'admin123',
        password: bcrypt.hashSync('admin456', BCRYPT_ROUNDS),
        role: 'admin',
        roleDetail: 'super',
        name: '系统管理员',
        plan: 'enterprise',
        status: 'active',
        balance: 9999.0,
      },
    ],
    keys: {},
    settings: { isTestMode: true, strategy: 'fusion', alertsConfig: defaultAlerts() },
    logs: [],
    histories: {},
    vendors: DEFAULT_VENDORS,
    usage: {},       // { userId: { "2025-06-05": { tasks: 3, credits: 15, tokens: { input: 1200, output: 800 }, cost: 0.05 } } }
    tokenLogs: [],   // [{ ts, userId, vendor, model, roleId, inputTokens, outputTokens, cost }]
    promptTemplates: DEFAULT_PROMPT_TEMPLATES,
    userApiKeys: [],  // [{ key, userId, name, createdAt, lastUsed }]
    ragDocs: [],      // [{ id, userId, filename, originalName, chunks, createdAt, scope?, orgId? }]
    workflows: DEFAULT_WORKFLOWS,
    orgs: [],            // [{ id, name, ownerId, members: [{ userId, role }], createdAt }]
    upgradeRequests: [], // [{ id, userId, username, fromPlan, toPlan, message, status, createdAt, reviewedAt, reviewNote }]
    orders: [],          // [{ id, userId, plan, amount, currency, provider, status, createdAt, paidAt, externalId }]
  };
}

// --- RAG 向量存储 (内存，启动时从磁盘重建) ---
const ragVectorStore = new Map(); // docId -> [{ text, embedding: Float64Array }]

/** 获取 embedding 缓存路径 */
function embeddingCachePath(docId, userId) {
  return path.join(RAG_DIR, userId, `${docId}.embeddings.json`);
}

/** 启动时重建 RAG 向量索引：优先从磁盘缓存加载，无缓存才调 API */
async function rebuildRagVectors() {
  const db = loadDb();
  const docs = db.ragDocs || [];
  if (docs.length === 0) return;
  console.log(`[RAG] 正在重建 ${docs.length} 篇文档的向量索引...`);
  let ok = 0, fail = 0, cached = 0;
  for (const doc of docs) {
    try {
      // 优先读缓存
      const cachePath = embeddingCachePath(doc.id, doc.userId);
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        ragVectorStore.set(doc.id, cache.map(c => ({ text: c.text, embedding: new Float64Array(c.embedding) })));
        ok++; cached++;
        continue;
      }
      const filePath = path.join(RAG_DIR, doc.userId, doc.filename);
      if (!fs.existsSync(filePath)) { fail++; continue; }
      const text = await extractText(filePath);
      if (!text || text.length < 20) { fail++; continue; }
      const chunks = chunkText(text);
      const embeddings = await getEmbeddings(chunks, db);
      const vectorChunks = chunks.map((c, i) => ({ text: c, embedding: embeddings[i] }));
      ragVectorStore.set(doc.id, vectorChunks);
      // 写入缓存
      try {
        const serializable = vectorChunks.map(c => ({ text: c.text, embedding: Array.from(c.embedding) }));
        fs.writeFileSync(cachePath, JSON.stringify(serializable), 'utf8');
      } catch {}
      ok++;
    } catch (e) {
      console.warn(`[RAG] 重建文档 ${doc.id} 失败: ${e.message}`);
      fail++;
    }
  }
  console.log(`[RAG] 向量索引重建完成: ${ok} 成功 (${cached} 从缓存), ${fail} 失败`);
}

/** 计算用户 RAG 存储占用 (bytes) */
function getUserRagStorageBytes(userId) {
  const userDir = path.join(RAG_DIR, userId);
  if (!fs.existsSync(userDir)) return 0;
  let total = 0;
  try {
    const files = fs.readdirSync(userDir);
    for (const f of files) {
      try { total += fs.statSync(path.join(userDir, f)).size; } catch {}
    }
  } catch {}
  return total;
}

/** 从文件中提取纯文本（支持 txt/md/csv/json/pdf/docx） */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (ext === '.pdf') {
    try {
      const buf = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buf });
      await parser.load();
      return (await parser.getText()) || '';
    } catch (e) { console.warn('[RAG] PDF 解析失败:', e.message); return ''; }
  }
  if (ext === '.docx') {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    } catch (e) { console.warn('[RAG] DOCX 解析失败:', e.message); return ''; }
  }
  // 其他二进制文件尝试读取可读文本
  try {
    const buf = fs.readFileSync(filePath);
    return buf.toString('utf8').replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r\t]/g, ' ').replace(/\s{3,}/g, '\n');
  } catch { return ''; }
}

/** 将文本切分为块 (每块约 500 字符，有重叠) */
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }
  return chunks.filter(c => c.length > 20);
}

/** 调用 Embedding API (OpenAI 兼容) */
async function getEmbeddings(texts, db) {
  // 尝试用配置的 API Key 调 embedding
  const vendors = [
    { id: 'openai', base: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
    { id: 'deepseek', base: 'https://api.deepseek.com/v1/embeddings', model: 'deepseek-embedding' },
    { id: 'alibaba', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', model: 'text-embedding-v3' },
  ];
  for (const v of vendors) {
    const keyObj = (db.keys || {})[v.id];
    if (!keyObj?.value || keyObj.value.length < 5) continue;
    try {
      const resp = await fetch(v.base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyObj.value}` },
        body: JSON.stringify({ input: texts, model: v.model }),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data.sort((a, b) => a.index - b.index).map(d => new Float64Array(d.embedding));
      }
    } catch { continue; }
  }
  // Fallback: 简单 TF 向量（无外部 API 时的降级方案）
  return texts.map(text => {
    const words = text.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean);
    const freq = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    const keys = Object.keys(freq).sort().slice(0, 128);
    const vec = new Float64Array(128);
    keys.forEach((k, i) => { vec[i] = freq[k] / words.length; });
    return vec;
  });
}

/** 余弦相似度 */
function cosineSim(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function getUserOrgIds(userId, db) {
  return (db.orgs || []).filter(o => o.members.some(m => m.userId === userId)).map(o => o.id);
}

/** RAG 搜索：返回最相关的 topK 个文本块（含个人 + 所属组织文档） */
async function ragSearch(query, userId, db, topK = 5) {
  const [queryVec] = await getEmbeddings([query], db);
  const results = [];
  const orgIds = getUserOrgIds(userId, db);
  const docs = (db.ragDocs || []).filter(d =>
    d.userId === userId || (d.scope === 'org' && orgIds.includes(d.orgId))
  );
  for (const doc of docs) {
    const chunks = ragVectorStore.get(doc.id) || [];
    for (const chunk of chunks) {
      const score = cosineSim(queryVec, chunk.embedding);
      results.push({ text: chunk.text, score, docName: doc.originalName, scope: doc.scope || 'personal' });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

let _dbCache = null;
let _dbCacheDirty = true;

function loadDb() {
  if (_dbCache && !_dbCacheDirty) return _dbCache;
  try {
    if (!fs.existsSync(DATA_PATH)) { _dbCache = defaultDb(); _dbCacheDirty = false; return _dbCache; }
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = defaultDb().users;
    if (!data.keys || typeof data.keys !== 'object') data.keys = {};
    if (!data.settings) data.settings = defaultDb().settings;
    if (!Array.isArray(data.logs)) data.logs = [];
    if (!data.histories || typeof data.histories !== 'object') data.histories = {};
    if (!Array.isArray(data.vendors) || data.vendors.length === 0) {
      data.vendors = DEFAULT_VENDORS;
    } else {
      const existingIds = new Set(data.vendors.map(v => v.id));
      for (const dv of DEFAULT_VENDORS) {
        if (!existingIds.has(dv.id)) data.vendors.push(dv);
      }
      // 迁移：修正无效的豆包模型名
      const dbao = data.vendors.find(v => v.id === 'doubao');
      if (dbao && dbao.models?.some(m => m.startsWith('doubao-seed-2.0'))) {
        dbao.models = DEFAULT_VENDORS.find(v => v.id === 'doubao').models;
        try { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8'); } catch {}
      }
    }
    if (!data.usage || typeof data.usage !== 'object') data.usage = {};
    if (!Array.isArray(data.tokenLogs)) data.tokenLogs = [];
    if (!Array.isArray(data.promptTemplates)) data.promptTemplates = DEFAULT_PROMPT_TEMPLATES;
    if (!Array.isArray(data.userApiKeys)) data.userApiKeys = [];
    if (!Array.isArray(data.ragDocs)) data.ragDocs = [];
    if (!Array.isArray(data.workflows) || data.workflows.length === 0) data.workflows = DEFAULT_WORKFLOWS;
    if (!Array.isArray(data.orgs)) data.orgs = [];
    if (!Array.isArray(data.upgradeRequests)) data.upgradeRequests = [];
    if (!Array.isArray(data.orders)) data.orders = [];
    // 迁移：将明文密码自动 hash（兼容旧 store.json）
    let migrated = false;
    for (const u of data.users) {
      if (u.password && !isHashed(u.password)) {
        u.password = bcrypt.hashSync(u.password, BCRYPT_ROUNDS);
        migrated = true;
      }
    }
    if (migrated) { try { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8'); } catch {} }
    _dbCache = data;
    _dbCacheDirty = false;
    return data;
  } catch {
    _dbCache = defaultDb();
    _dbCacheDirty = false;
    return _dbCache;
  }
}

function saveDb(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  writeFileAtomic.sync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
  _dbCache = data;
  _dbCacheDirty = false;
}

const OPENAI_STYLE_VENDORS = {
  openai: { base: 'https://api.openai.com', path: '/v1/chat/completions' },
  deepseek: { base: 'https://api.deepseek.com', path: '/v1/chat/completions' },
  moonshot: { base: 'https://api.moonshot.cn', path: '/v1/chat/completions' },
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions' },
  alibaba: { base: 'https://dashscope.aliyuncs.com/compatible-mode', path: '/v1/chat/completions' },
  doubao: { base: 'https://ark.cn-beijing.volces.com/api/v3', path: '/chat/completions' },
  ollama: { base: process.env.OLLAMA_BASE_URL || 'http://localhost:11434', path: '/v1/chat/completions' },
  vllm:   { base: process.env.VLLM_BASE_URL   || 'http://localhost:8000', path: '/v1/chat/completions' },
  localai: { base: process.env.LOCALAI_BASE_URL || 'http://localhost:8080', path: '/v1/chat/completions' },
};

const DEFAULT_VENDORS = [
  { id: 'openai', name: 'OpenAI', region: 'US', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini'] },
  { id: 'anthropic', name: 'Anthropic', region: 'US', models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5'] },
  { id: 'google', name: 'Google', region: 'US', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'] },
  { id: 'deepseek', name: 'DeepSeek (深度求索)', region: 'CN', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { id: 'alibaba', name: 'Alibaba (阿里)', region: 'CN', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-plus', 'qwen3-coder-plus'] },
  { id: 'zhipu', name: 'Zhipu (智谱)', region: 'CN', models: ['glm-5.1', 'glm-5', 'glm-4-plus', 'glm-4'] },
  { id: 'doubao', name: 'Doubao (豆包)', region: 'CN', models: ['doubao-seed-1.6', 'doubao-seed-1.6-lite', 'doubao-seed-code', 'doubao-1.5-pro-32k', 'doubao-pro-128k'] },
  { id: 'moonshot', name: 'Moonshot (月之暗面)', region: 'CN', models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k'] },
  { id: 'ollama', name: 'Ollama (本地)', region: 'LOCAL', models: ['llama3.3', 'qwen2.5', 'deepseek-r1', 'codellama', 'mistral', 'gemma2'] },
  { id: 'vllm', name: 'vLLM (本地)', region: 'LOCAL', models: ['自定义模型'] },
];

/**
 * 将前端展示用模型名映射为各平台常用 API 模型 id。
 * @param {string} vendor
 * @param {string} model
 */
function resolveApiModel(vendor, model) {
  const m = (model || '').trim();
  if (vendor === 'openai') {
    if (/gpt-4\.1(?![-\w])/i.test(m)) return 'gpt-4.1';
    if (/4\.1-mini/i.test(m)) return 'gpt-4.1-mini';
    if (/4\.1-nano/i.test(m)) return 'gpt-4.1-nano';
    if (/gpt-4o/i.test(m)) return 'gpt-4o';
    if (/o4-mini/i.test(m)) return 'o4-mini';
    return 'gpt-4.1-mini';
  }
  if (vendor === 'deepseek') {
    if (/v4-pro/i.test(m)) return 'deepseek-v4-pro';
    if (/v4-flash/i.test(m)) return 'deepseek-v4-flash';
    if (/reasoner/i.test(m)) return 'deepseek-reasoner';
    return 'deepseek-chat';
  }
  if (vendor === 'moonshot') {
    if (/k2\.6/i.test(m)) return 'kimi-k2.6';
    if (/k2\.5/i.test(m)) return 'kimi-k2.5';
    if (/128k/i.test(m)) return 'moonshot-v1-128k';
    return 'kimi-k2.6';
  }
  if (vendor === 'zhipu') {
    if (/5\.1/i.test(m)) return 'glm-5.1';
    if (/glm-5(?!\.)/i.test(m)) return 'glm-5';
    if (/4-plus/i.test(m)) return 'glm-4-plus';
    return 'glm-4';
  }
  if (vendor === 'alibaba') {
    if (/qwen-max/i.test(m)) return 'qwen-max';
    if (/qwen-plus/i.test(m)) return 'qwen-plus';
    if (/qwq/i.test(m)) return 'qwq-plus';
    if (/coder/i.test(m)) return 'qwen3-coder-plus';
    return 'qwen-turbo';
  }
  if (vendor === 'anthropic') {
    if (/opus/i.test(m)) return 'claude-opus-4-8';
    if (/haiku/i.test(m)) return 'claude-haiku-4-5';
    if (/sonnet.*4-5|4\.5/i.test(m)) return 'claude-sonnet-4-5';
    return 'claude-sonnet-4-6';
  }
  if (vendor === 'google') {
    if (/2\.5.*pro/i.test(m)) return 'gemini-2.5-pro';
    if (/2\.5.*lite|lite/i.test(m)) return 'gemini-2.5-flash-lite';
    return 'gemini-2.5-flash';
  }
  if (vendor === 'doubao') {
    // 支持用户直接填写接入点 ID（ep-xxxxx）
    if (/^ep-/i.test(m)) return m;
    if (/seed-1\.6(?![-\w])/i.test(m)) return 'doubao-seed-1.6';
    if (/seed.*1\.6.*lite|seed-1\.6-lite/i.test(m)) return 'doubao-seed-1.6-lite';
    if (/seed.*code/i.test(m)) return 'doubao-seed-code';
    if (/1\.5.*pro.*32k/i.test(m)) return 'doubao-1.5-pro-32k';
    if (/128k/i.test(m)) return 'doubao-pro-128k';
    return m || 'doubao-seed-1.6';
  }
  // 本地模型（Ollama / vLLM / LocalAI）: 直接透传模型名
  if (['ollama', 'vllm', 'localai'].includes(vendor)) {
    return m || 'llama3.3';
  }
  return m.replace(/\s*\(.*?\)\s*/g, '').trim() || 'gpt-4.1-mini';
}

/**
 * @param {string} baseUrl
 * @param {string} chatPath 如 /v1/chat/completions 或智谱 /chat/completions
 * @param {string} apiKey
 * @param {string} apiModel
 * @param {string} systemPrompt
 * @param {string} userText
 */
/** 模型单价表 (USD per 1M tokens) */
const MODEL_PRICING = {
  // OpenAI
  'gpt-4.1':       { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':  { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':  { input: 0.10, output: 0.40 },
  'gpt-4o':        { input: 2.50, output: 10.00 },
  'o4-mini':       { input: 1.10, output: 4.40 },
  // Anthropic
  'claude-sonnet-4-6':  { input: 3.00, output: 15.00 },
  'claude-opus-4-8':    { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':   { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5':  { input: 3.00, output: 15.00 },
  // Google
  'gemini-2.5-flash':      { input: 0.15, output: 0.60 },
  'gemini-2.5-pro':        { input: 1.25, output: 10.00 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  // DeepSeek
  'deepseek-v4-pro':    { input: 0.90, output: 0.90 },
  'deepseek-v4-flash':  { input: 0.14, output: 0.14 },
  'deepseek-chat':      { input: 0.27, output: 1.10 },
  'deepseek-reasoner':  { input: 0.55, output: 2.19 },
  // Alibaba Qwen
  'qwen-max':           { input: 2.40, output: 9.60 },
  'qwen-plus':          { input: 0.80, output: 2.00 },
  'qwen-turbo':         { input: 0.30, output: 0.60 },
  'qwq-plus':           { input: 0.80, output: 2.00 },
  'qwen3-coder-plus':   { input: 0.80, output: 2.00 },
  // Zhipu GLM
  'glm-5.1':     { input: 0.50, output: 0.50 },
  'glm-5':       { input: 0.50, output: 0.50 },
  'glm-4-plus':  { input: 0.50, output: 0.50 },
  'glm-4':       { input: 0.15, output: 0.15 },
  // Doubao
  'doubao-seed-1.6':      { input: 0.40, output: 0.40 },
  'doubao-seed-1.6-lite': { input: 0.08, output: 0.08 },
  'doubao-seed-code':     { input: 0.40, output: 0.40 },
  'doubao-1.5-pro-32k':   { input: 0.40, output: 0.40 },
  'doubao-pro-128k':      { input: 0.70, output: 0.90 },
  // Moonshot
  'kimi-k2.6':          { input: 0.60, output: 0.60 },
  'kimi-k2.5':          { input: 0.60, output: 0.60 },
  'moonshot-v1-128k':   { input: 0.84, output: 0.84 },
};

/** 计算单次调用成本 (USD) */
function calcCost(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model] || { input: 1.0, output: 1.0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** 估算字符数→token 数 (中文 ≈ 1.5 char/token, 英文 ≈ 4 char/token, 按实际比例加权) */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

async function chatOpenAICompatible(baseUrl, chatPath, apiKey, apiModel, systemPrompt, userText, imageFiles = []) {
  const pathPart = chatPath.startsWith('/') ? chatPath : `/${chatPath}`;
  const url = `${baseUrl.replace(/\/$/, '')}${pathPart}`;
  // 构建 user content：纯文本或多模态
  let userContent;
  if (imageFiles.length > 0) {
    userContent = [
      { type: 'text', text: userText },
      ...imageFiles.map(f => ({
        type: 'image_url',
        image_url: { url: f.data.startsWith('data:') ? f.data : `data:${f.type || 'image/png'};base64,${f.data}` },
      })),
    ];
  } else {
    userContent = userText;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: apiModel,
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401 && url.includes('volces.com')) {
      hint = '\n提示: 豆包 API Key 需从「火山方舟控制台 → API Key 管理」获取，不是火山引擎 AccessKey(AKLT...)。';
    }
    throw new Error(`OpenAI兼容接口 ${res.status}: ${text.slice(0, 400)}${hint}`);
  }
  const data = JSON.parse(text);
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error('OpenAI兼容接口无 choices 文本');
  const usage = data.usage || {};
  return { text: out, inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
}

async function chatAnthropic(apiKey, apiModel, systemPrompt, userText, imageFiles = []) {
  // 构建多模态 content 数组
  const userContent = [{ type: 'text', text: userText }];
  for (const f of imageFiles) {
    const raw = f.data.startsWith('data:') ? f.data.replace(/^data:[^;]+;base64,/, '') : f.data;
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: f.type || 'image/png', data: raw },
    });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful assistant.',
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const blocks = data.content || [];
  const t = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (!t) throw new Error('Anthropic 无文本内容');
  const usage = data.usage || {};
  return { text: t, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
}

async function chatGoogleGemini(apiKey, apiModel, systemPrompt, userText, imageFiles = []) {
  const model = apiModel.startsWith('models/') ? apiModel : `models/${apiModel}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // 构建 parts 数组（支持图片）
  const parts = [{ text: userText }];
  for (const f of imageFiles) {
    const raw = f.data.startsWith('data:') ? f.data.replace(/^data:[^;]+;base64,/, '') : f.data;
    parts.push({ inlineData: { mimeType: f.type || 'image/png', data: raw } });
  }
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: systemPrompt
        ? { parts: [{ text: systemPrompt }] }
        : undefined,
      contents: [{ role: 'user', parts }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const resParts = data.candidates?.[0]?.content?.parts || [];
  const out = resParts.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini 无输出文本');
  const meta = data.usageMetadata || {};
  return { text: out, inputTokens: meta.promptTokenCount || 0, outputTokens: meta.candidatesTokenCount || 0 };
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
 * @param {Array<{ name?: string, type?: string, isImage?: boolean, data?: string }>} [files]
 */
async function runDispatchLLM(prompt, systemPrompt, dispatch, keysFromDb, files) {
  const vendor = (dispatch?.vendor || 'openai').toLowerCase();
  const model = dispatch?.model || '';
  const apiKey = resolveApiKey(dispatch, keysFromDb);
  const apiModel = resolveApiModel(vendor, model);
  const userText = String(prompt || '');
  // 过滤出有 base64 数据的图片附件
  const imageFiles = (files || []).filter(f => f.isImage && f.data);

  const isLocalVendor = ['ollama', 'vllm', 'localai'].includes(vendor);
  if (!apiKey && !isLocalVendor) {
    const est = estimateTokens(userText);
    return { text: buildStubReply(dispatch, prompt, ''), stub: true, inputTokens: est, outputTokens: Math.ceil(est * 0.5), apiModel };
  }

  try {
    let result;
    if (OPENAI_STYLE_VENDORS[vendor]) {
      const { base, path: chatPath } = OPENAI_STYLE_VENDORS[vendor];
      result = await chatOpenAICompatible(base, chatPath, apiKey, apiModel, systemPrompt, userText, imageFiles);
    } else if (vendor === 'anthropic') {
      result = await chatAnthropic(apiKey, apiModel, systemPrompt, userText, imageFiles);
    } else if (vendor === 'google') {
      result = await chatGoogleGemini(apiKey, apiModel, systemPrompt, userText, imageFiles);
    } else {
      const est = estimateTokens(userText);
      return {
        text: buildStubReply(dispatch, prompt, `厂商「${vendor}」尚未接入真实 API，请使用 OpenAI/DeepSeek/Moonshot/智谱/阿里兼容或 Anthropic/Google。`),
        stub: true, inputTokens: est, outputTokens: 0, apiModel,
      };
    }
    // 如果 API 没有返回 token 数，用估算
    const inT = result.inputTokens || estimateTokens(systemPrompt + userText);
    const outT = result.outputTokens || estimateTokens(result.text);
    return { text: result.text, stub: false, inputTokens: inT, outputTokens: outT, apiModel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const est = estimateTokens(userText);
    return { text: buildStubReply(dispatch, prompt, msg), stub: true, error: msg, inputTokens: est, outputTokens: 0, apiModel };
  }
}

// --- SLA 追踪 ---
const SLA_START_TIME = Date.now();
const slaMetrics = {
  totalRequests: 0,
  totalErrors: 0,  // 5xx
  responseTimes: [], // last 1000 API response times in ms
  aiResponseTimes: [], // last 500 AI generate response times
  hourlyUptime: {},  // { "2026-06-15T14": { ok: 120, err: 2 } }
};
const SLA_MAX_RT = 1000;
const SLA_MAX_AI_RT = 500;

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : null; // null = 开发模式允许全部
app.use(cors({
  origin: ALLOWED_ORIGINS
    ? (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error('CORS blocked')))
    : true,
  credentials: true,
}));

// SLA 响应时间追踪中间件
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = Date.now();
  slaMetrics.totalRequests++;
  const hourKey = new Date().toISOString().slice(0, 13);
  if (!slaMetrics.hourlyUptime[hourKey]) slaMetrics.hourlyUptime[hourKey] = { ok: 0, err: 0 };
  res.on('finish', () => {
    const duration = Date.now() - start;
    slaMetrics.responseTimes.push(duration);
    if (slaMetrics.responseTimes.length > SLA_MAX_RT) slaMetrics.responseTimes.shift();
    if (res.statusCode >= 500) {
      slaMetrics.totalErrors++;
      slaMetrics.hourlyUptime[hourKey].err++;
    } else {
      slaMetrics.hourlyUptime[hourKey].ok++;
    }
  });
  next();
});

// Stripe webhook 必须在 express.json() 之前注册（需要 raw body 验签）
app.post('/api/payment/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (e) {
    console.error('[Stripe Webhook] 签名验证失败:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan, orderId } = session.metadata || {};
    if (userId && plan) {
      const db = loadDb();
      const order = db.orders.find(o => o.id === orderId);
      if (order) {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        order.externalId = session.subscription || session.id;
      }
      const user = db.users.find(u => u.id === userId);
      if (user && PLAN_PRICES[plan]) {
        user.plan = plan;
        console.log(`[Stripe] 用户 ${user.username} 升级到 ${plan}`);
      }
      saveDb(db);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '32mb' }));
app.use(authMiddleware);

// --- 速率限制 ---
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { ok: false, error: '请求过于频繁，请 1 分钟后再试' }, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60_000, max: 5, message: { ok: false, error: '注册请求过于频繁，请稍后再试' }, standardHeaders: true, legacyHeaders: false });
const generateLimiter = rateLimit({ windowMs: 60_000, max: 30, message: { ok: false, error: 'AI 调用过于频繁，请稍后再试' }, standardHeaders: true, legacyHeaders: false });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'zdf-ai-platform-backend' });
});

// --- 管理员系统自检（真实检测 DB / API / 存储）---
app.get('/api/admin/health-check', requireAdmin, async (req, res) => {
  const results = [];

  // 1. 数据库连通性
  let db;
  const dbStart = Date.now();
  try {
    db = loadDb();
    const userCount = (db.users || []).length;
    const dbLatency = Date.now() - dbStart;
    results.push({ id: 'db', status: 'ok', msg: `连接成功 (Latency: ${dbLatency}ms, ${userCount} 用户)` });
  } catch (e) {
    results.push({ id: 'db', status: 'error', msg: `数据库读取失败: ${e.message}` });
    db = { keys: {} };
  }

  // 2. API 厂商连通性 — 逐个 ping 已配置 key 的厂商
  const configuredVendors = Object.entries(db.keys || {}).filter(([, v]) => v?.value?.length > 5);
  if (configuredVendors.length === 0) {
    results.push({ id: 'api', status: 'error', msg: '警告：未检测到有效配置的 API Key！用户调度可能受阻' });
  } else {
    const vendorResults = [];
    const pingPromises = configuredVendors.map(async ([vendorId, keyObj]) => {
      const start = Date.now();
      try {
        // 用最小请求测试连通性
        const fakeDispatch = { vendor: vendorId, model: '', mode: 'platform', roleId: 'healthcheck' };
        const keys = { [vendorId]: { value: keyObj.value } };
        const r = await runDispatchLLM('ping', 'Reply OK', fakeDispatch, keys);
        const latency = Date.now() - start;
        if (!r.stub) {
          vendorResults.push({ vendor: vendorId, ok: true, latency });
        } else {
          vendorResults.push({ vendor: vendorId, ok: false, msg: 'stub response' });
        }
      } catch (e) {
        vendorResults.push({ vendor: vendorId, ok: false, msg: e.message?.slice(0, 100) });
      }
    });
    await Promise.allSettled(pingPromises);
    const okCount = vendorResults.filter(v => v.ok).length;
    const failCount = vendorResults.filter(v => !v.ok).length;
    const details = vendorResults.map(v => v.ok ? `${v.vendor}✓(${v.latency}ms)` : `${v.vendor}✗`).join(', ');
    if (failCount === 0) {
      results.push({ id: 'api', status: 'ok', msg: `全部 ${okCount} 个厂商在线: ${details}` });
    } else if (okCount > 0) {
      results.push({ id: 'api', status: 'warn', msg: `${okCount}/${okCount + failCount} 厂商在线: ${details}` });
    } else {
      results.push({ id: 'api', status: 'error', msg: `全部 ${failCount} 个厂商不可达: ${details}` });
    }
  }

  // 3. 存储健康 — 检查 data 目录可写性和大小
  try {
    const dataDir = path.join(__dirname, 'data');
    const stats = fs.statSync(DATA_PATH);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    // 测试写入
    const testFile = path.join(dataDir, '.health_test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    results.push({ id: 'storage', status: 'ok', msg: `存储可读写，数据库文件 ${sizeMB} MB` });
  } catch (e) {
    results.push({ id: 'storage', status: 'error', msg: `存储异常: ${e.message}` });
  }

  res.json({ ok: true, results });
});

// --- Webhook 告警发送 ---
app.post('/api/admin/send-alert', requireAdmin, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ ok: false, error: '缺少 title 或 content' });
  const db = loadDb();
  const cfg = db.settings?.alertsConfig || defaultAlerts();
  const hasWebhook = (cfg.webhookWechat || '').trim() || (cfg.webhookDingtalk || '').trim();
  const hasEmail = (cfg.smtpServer || '').trim() && (cfg.email || '').trim() && (cfg.emailPwd || '').trim();
  const hasSms = (cfg.phone || '').trim() && (cfg.smsAppKey || '').trim();
  if (!hasWebhook && !hasEmail && !hasSms) return res.json({ ok: false, error: '未配置任何告警渠道（Webhook / SMTP 邮箱 / SMS）', results: [] });
  const [webhookResults, emailResults, smsResults] = await Promise.all([
    hasWebhook ? sendWebhookAlert(cfg, title, content) : [],
    hasEmail ? sendEmailAlert(cfg, title, content) : [],
    hasSms ? sendSmsAlert(cfg, title, content) : [],
  ]);
  const results = [...webhookResults, ...emailResults, ...smsResults];
  // 记录日志
  db.logs = db.logs || [];
  db.logs.push({ ts: new Date().toISOString(), type: 'alert', user: req.userId, action: 'Webhook告警', detail: `${title} → ${results.map(r => `${r.channel}:${r.ok ? 'OK' : r.msg}`).join(', ')}` });
  if (db.logs.length > 2000) db.logs = db.logs.slice(-1500);
  saveDb(db);
  res.json({ ok: true, results });
});

// --- 登录接口 (返回 JWT) ---
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: '请提供账号和密码' });
  const db = loadDb();
  const user = db.users.find(u => u.username === username);
  if (!user) {
    addLog(db, 'warn', username, '登录失败', `不存在的账号尝试登录，IP: ${req.ip}`);
    saveDb(db);
    return res.status(401).json({ ok: false, error: '账号或密码错误' });
  }
  if (user.status !== 'active') {
    addLog(db, 'warn', username, '登录失败', `被封禁账号尝试登录，IP: ${req.ip}`);
    saveDb(db);
    return res.status(403).json({ ok: false, error: '账号已被封禁' });
  }
  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    addLog(db, 'warn', username, '登录失败', `密码错误，IP: ${req.ip}`);
    saveDb(db);
    return res.status(401).json({ ok: false, error: '账号或密码错误' });
  }
  // 如果密码是明文，升级为 hash
  if (!isHashed(user.password)) {
    user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
    saveDb(db);
  }
  const token = jwt.sign({ userId: user.id, role: user.role, plan: user.plan }, JWT_SECRET, { expiresIn: '24h' });
  const permissions = getUserPermissions(user);
  addLog(db, 'info', username, '登录成功', `套餐: ${user.plan}，IP: ${req.ip}`);
  saveDb(db);
  // 设置 httpOnly cookie (L02: 防 XSS)
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true, token, user: { id: user.id, username: user.username, role: user.role, roleDetail: user.roleDetail, name: user.name, plan: user.plan, status: user.status, balance: user.balance, permissions } });
});

// --- 修改密码 ---
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, error: '请提供旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  const valid = await verifyPassword(oldPassword, user.password);
  if (!valid) return res.status(401).json({ ok: false, error: '旧密码错误' });
  user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  addLog(db, 'info', user.username, '修改密码', '用户修改了登录密码');
  saveDb(db);
  res.json({ ok: true });
});

// --- 登出（清除 httpOnly cookie）---
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/system-data', requireAdmin, (_req, res) => {
  const db = loadDb();
  // 剥离密码字段，不将 hash 暴露到前端
  const safeUsers = db.users.map(({ password, ...rest }) => rest);
  res.json({
    users: safeUsers,
    isTestMode: db.settings.isTestMode,
    strategy: db.settings.strategy || 'fusion',
    keys: db.keys,
    alerts: db.settings.alertsConfig,
    logs: db.logs,
    vendors: db.vendors,
    promptTemplates: db.promptTemplates || [],
  });
});

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const db = loadDb();
  db.keys = { ...db.keys, ...(req.body || {}) };
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const db = loadDb();
  const b = req.body || {};
  if (typeof b.isTestMode === 'boolean') db.settings.isTestMode = b.isTestMode;
  if (typeof b.strategy === 'string') db.settings.strategy = b.strategy;
  if (b.alertsConfig && typeof b.alertsConfig === 'object') {
    db.settings.alertsConfig = { ...defaultAlerts(), ...b.alertsConfig };
  }
  saveDb(db);
  res.json({ ok: true });
});

// --- Prompt 模板 CRUD ---
app.get('/api/prompt-templates', requireAuth, (req, res) => {
  const db = loadDb();
  // 按用户套餐过滤可用模板
  const planOrder = { free: 0, pro: 1, enterprise: 2, max: 3 };
  const userLevel = planOrder[req.userPlan] ?? 0;
  const available = (db.promptTemplates || []).filter(t => (planOrder[t.plan] ?? 0) <= userLevel);
  res.json({ ok: true, templates: available });
});

app.post('/api/admin/prompt-templates', requireAdmin, (req, res) => {
  const db = loadDb();
  const tpl = req.body || {};
  if (!tpl.title || !tpl.prompt) return res.status(400).json({ ok: false, error: '模板需要 title 和 prompt' });
  tpl.id = tpl.id || `tpl_${Date.now()}`;
  const idx = db.promptTemplates.findIndex(t => t.id === tpl.id);
  if (idx >= 0) db.promptTemplates[idx] = { ...db.promptTemplates[idx], ...tpl };
  else db.promptTemplates.push(tpl);
  saveDb(db);
  res.json({ ok: true, template: tpl });
});

app.delete('/api/admin/prompt-templates/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  db.promptTemplates = db.promptTemplates.filter(t => t.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const db = loadDb();
  const incoming = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.users) ? req.body.users : null);
  if (!incoming) return res.status(400).json({ ok: false, error: '需要用户数组' });
  // 合并模式：以 incoming 为主，保留 incoming 中没有的旧用户的密码
  const existingMap = new Map(db.users.map(u => [u.id, u]));
  for (const u of incoming) {
    if (!u.id) u.id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // 如果前端提交的用户没有密码（被 C08 剥离了），从旧数据恢复
    if (!u.password && existingMap.has(u.id)) {
      u.password = existingMap.get(u.id).password;
    }
    if (u.password && !isHashed(u.password)) {
      u.password = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
    }
  }
  db.users = incoming;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/logs', requireAdmin, (req, res) => {
  const db = loadDb();
  if (Array.isArray(req.body)) db.logs = req.body;
  else if (Array.isArray(req.body?.logs)) db.logs = req.body.logs;
  saveDb(db);
  res.json({ ok: true });
});

// --- 厂商与模型管理 ---
app.get('/api/vendors', (_req, res) => {
  const db = loadDb();
  res.json({ vendors: db.vendors || DEFAULT_VENDORS });
});

app.get('/api/ollama/models', async (_req, res) => {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return res.json({ ok: false, models: [] });
    const data = await r.json();
    const models = (data.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at }));
    res.json({ ok: true, models });
  } catch {
    res.json({ ok: false, models: [], error: 'Ollama 未运行或无法连接' });
  }
});

app.post('/api/admin/vendors', requireAdmin, (req, res) => {
  const db = loadDb();
  if (Array.isArray(req.body)) db.vendors = req.body;
  else if (Array.isArray(req.body?.vendors)) db.vendors = req.body.vendors;
  else return res.status(400).json({ ok: false, error: 'expected vendors array' });
  addLog(db, 'info', req.userId, '厂商配置变更', `更新了 ${db.vendors.length} 个厂商配置`);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const db = loadDb();
  const u = req.body;
  if (!u || !u.username || !u.password) return res.status(400).json({ ok: false, error: '请提供用户名和密码' });
  if (typeof u.username !== 'string' || u.username.trim().length < 2 || u.username.trim().length > 30) {
    return res.status(400).json({ ok: false, error: '用户名长度需 2-30 个字符' });
  }
  if (typeof u.password !== 'string' || u.password.length < 6) {
    return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  }
  if (db.users.some((x) => x.username === u.username.trim())) {
    return res.status(409).json({ ok: false, error: 'username exists' });
  }
  // 服务端强制安全字段，忽略客户端传入的 role/plan/balance/status
  const isTest = db.settings?.isTestMode;
  const safeUser = {
    id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    username: u.username.trim(),
    password: await bcrypt.hash(u.password, BCRYPT_ROUNDS),
    email: (u.email || '').trim().toLowerCase().slice(0, 100) || '',
    role: 'user',
    roleDetail: 'user',
    name: (u.name || u.username).trim().slice(0, 50),
    plan: isTest ? 'pro' : 'free',
    status: 'active',
    balance: 0.0,
  };
  db.users.push(safeUser);
  addLog(db, 'info', safeUser.username, '用户注册', `新用户注册，套餐: ${safeUser.plan}`);
  saveDb(db);
  const token = jwt.sign({ userId: safeUser.id, role: safeUser.role, plan: safeUser.plan }, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true, token, user: { id: safeUser.id, username: safeUser.username, role: safeUser.role, roleDetail: safeUser.roleDetail, name: safeUser.name, plan: safeUser.plan, status: safeUser.status, balance: safeUser.balance, email: safeUser.email } });
});

// --- 忘记密码：发送重置邮件 ---
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: '请提供注册邮箱' });
  const db = loadDb();
  const user = db.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
  if (!user) {
    return res.json({ ok: true, msg: '如果该邮箱已注册，将收到重置邮件' });
  }
  const resetToken = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  if (!db.resetTokens) db.resetTokens = [];
  db.resetTokens = db.resetTokens.filter(t => t.userId !== user.id);
  db.resetTokens.push({ token: resetToken, userId: user.id, expiresAt: Date.now() + 3600_000 });
  if (db.resetTokens.length > 500) db.resetTokens = db.resetTokens.slice(-500);
  saveDb(db);
  const cfg = db.settings?.alertsConfig || defaultAlerts();
  const server = (cfg.smtpServer || '').trim();
  const smtpEmail = (cfg.email || '').trim();
  const pwd = (cfg.emailPwd || '').trim();
  if (server && smtpEmail && pwd) {
    try {
      const transporter = nodemailer.createTransport({
        host: server, port: Number(cfg.smtpPort) || 465,
        secure: (Number(cfg.smtpPort) || 465) === 465,
        auth: { user: smtpEmail, pass: pwd },
        tls: { rejectUnauthorized: false },
      });
      await transporter.sendMail({
        from: `"ZDF.AI" <${smtpEmail}>`,
        to: user.email,
        subject: '[ZDF.AI] 密码重置',
        html: `<h2>密码重置</h2><p>您的密码重置验证码为：</p><h1 style="color:#6366f1;letter-spacing:4px">${resetToken.slice(0, 8).toUpperCase()}</h1><p>验证码 1 小时内有效。如非本人操作请忽略。</p><hr><p style="color:#999">ZDF.AI 多智能体决策系统</p>`,
      });
    } catch (e) {
      console.warn('[密码重置] 邮件发送失败:', e.message);
    }
  }
  addLog(db, 'info', user.username, '密码重置请求', `请求重置密码，邮箱: ${user.email}`);
  res.json({ ok: true, msg: '如果该邮箱已注册，将收到重置邮件' });
});

// --- 忘记密码：验证 code 并重置 ---
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) return res.status(400).json({ ok: false, error: '请提供邮箱、验证码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  const db = loadDb();
  const user = db.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
  if (!user) return res.status(400).json({ ok: false, error: '邮箱未注册' });
  const tokenRow = (db.resetTokens || []).find(t => t.userId === user.id && t.expiresAt > Date.now());
  if (!tokenRow) return res.status(400).json({ ok: false, error: '验证码无效或已过期' });
  if (!tokenRow.token.toUpperCase().startsWith(code.toUpperCase().trim())) {
    return res.status(400).json({ ok: false, error: '验证码错误' });
  }
  user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  db.resetTokens = db.resetTokens.filter(t => t.userId !== user.id);
  addLog(db, 'info', user.username, '密码重置成功', '用户通过邮箱验证码重置了密码');
  saveDb(db);
  res.json({ ok: true });
});

// --- OAuth: GitHub 登录 ---
app.get('/api/auth/github', (req, res) => {
  const db = loadDb();
  const cfg = db.settings?.oauthConfig?.github || {};
  if (!cfg.clientId) return res.status(400).json({ ok: false, error: 'GitHub OAuth 未配置' });
  const state = Math.random().toString(36).slice(2);
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/github/callback`;
  res.json({ ok: true, url: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=user:email` });
});

app.get('/api/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  const db = loadDb();
  const cfg = db.settings?.oauthConfig?.github || {};
  if (!cfg.clientId || !cfg.clientSecret) return res.status(400).send('GitHub OAuth not configured');
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('OAuth token exchange failed');
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'ZDF.AI' },
    });
    const ghUser = await userRes.json();
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'ZDF.AI' },
    });
    const emails = await emailRes.json();
    const primaryEmail = (Array.isArray(emails) ? emails.find(e => e.primary)?.email : '') || ghUser.email || '';
    let user = db.users.find(u => u.oauthGithub === String(ghUser.id)) || db.users.find(u => u.email && primaryEmail && u.email.toLowerCase() === primaryEmail.toLowerCase());
    if (!user) {
      const isTest = db.settings?.isTestMode;
      user = {
        id: `usr_gh_${ghUser.id}`,
        username: ghUser.login || `gh_${ghUser.id}`,
        password: await bcrypt.hash(Math.random().toString(36).slice(2) + Date.now(), BCRYPT_ROUNDS),
        email: primaryEmail,
        role: 'user', roleDetail: 'user',
        name: ghUser.name || ghUser.login,
        plan: isTest ? 'pro' : 'free',
        status: 'active', balance: 0.0,
        oauthGithub: String(ghUser.id),
        avatar: ghUser.avatar_url || '',
      };
      db.users.push(user);
      addLog(db, 'info', user.username, 'GitHub 注册', `通过 GitHub OAuth 注册`);
    } else {
      if (!user.oauthGithub) user.oauthGithub = String(ghUser.id);
      if (ghUser.avatar_url) user.avatar = ghUser.avatar_url;
    }
    saveDb(db);
    const jwtToken = jwt.sign({ userId: user.id, role: user.role, plan: user.plan }, JWT_SECRET, { expiresIn: '24h' });
    res.redirect(`/?oauth_token=${jwtToken}`);
  } catch (e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// --- OAuth: Google 登录 ---
app.get('/api/auth/google', (req, res) => {
  const db = loadDb();
  const cfg = db.settings?.oauthConfig?.google || {};
  if (!cfg.clientId) return res.status(400).json({ ok: false, error: 'Google OAuth 未配置' });
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const state = Math.random().toString(36).slice(2);
  res.json({ ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&state=${state}` });
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  const db = loadDb();
  const cfg = db.settings?.oauthConfig?.google || {};
  if (!cfg.clientId || !cfg.clientSecret) return res.status(400).send('Google OAuth not configured');
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('Token exchange failed');
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const gUser = await infoRes.json();
    let user = db.users.find(u => u.oauthGoogle === gUser.id) || db.users.find(u => u.email && gUser.email && u.email.toLowerCase() === gUser.email.toLowerCase());
    if (!user) {
      const isTest = db.settings?.isTestMode;
      user = {
        id: `usr_gg_${gUser.id}`,
        username: (gUser.email || '').split('@')[0] || `gg_${gUser.id}`,
        password: await bcrypt.hash(Math.random().toString(36).slice(2) + Date.now(), BCRYPT_ROUNDS),
        email: gUser.email || '',
        role: 'user', roleDetail: 'user',
        name: gUser.name || gUser.email,
        plan: isTest ? 'pro' : 'free',
        status: 'active', balance: 0.0,
        oauthGoogle: gUser.id,
        avatar: gUser.picture || '',
      };
      db.users.push(user);
      addLog(db, 'info', user.username, 'Google 注册', `通过 Google OAuth 注册`);
    } else {
      if (!user.oauthGoogle) user.oauthGoogle = gUser.id;
      if (gUser.picture) user.avatar = gUser.picture;
    }
    saveDb(db);
    const jwtToken = jwt.sign({ userId: user.id, role: user.role, plan: user.plan }, JWT_SECRET, { expiresIn: '24h' });
    res.redirect(`/?oauth_token=${jwtToken}`);
  } catch (e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// --- OAuth 配置查询 (前端用) ---
app.get('/api/auth/oauth-config', (_req, res) => {
  const db = loadDb();
  const oa = db.settings?.oauthConfig || {};
  res.json({
    github: !!(oa.github?.clientId),
    google: !!(oa.google?.clientId),
  });
});

// --- 管理员: 保存 OAuth 配置 ---
app.post('/api/admin/oauth-config', requireAdmin, (req, res) => {
  const db = loadDb();
  if (!db.settings) db.settings = {};
  db.settings.oauthConfig = { ...(db.settings.oauthConfig || {}), ...(req.body || {}) };
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/user/history', (req, res) => {
  const uid = parseUserIdFromAuth(req);
  if (!uid) return res.status(401).json({ history: [] });
  const db = loadDb();
  const user = db.users.find(u => u.id === uid);
  const plan = user?.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  let hist = db.histories[uid] || [];
  // 按套餐保留策略清理过期历史
  if (limits.historyDays > 0 && hist.length > 0) {
    const cutoff = Date.now() - limits.historyDays * 86400_000;
    const before = hist.length;
    hist = hist.filter(h => (h.id || 0) >= cutoff);
    if (hist.length < before) { db.histories[uid] = hist; saveDb(db); }
  }
  res.json({ history: hist });
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
const TEST_KEY_MODEL = {
  openai: 'gpt-4.1-mini', anthropic: 'claude-haiku-4-5', google: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat', alibaba: 'qwen-turbo', zhipu: 'glm-4',
  doubao: 'doubao-seed-1.6-lite', moonshot: 'moonshot-v1-128k',
};
app.post('/api/admin/test-key', requireAdmin, async (req, res) => {
  const vendorId = String(req.body?.vendorId || '').toLowerCase();
  const key = String(req.body?.key || '').trim();
  if (!vendorId || !key) return res.status(400).json({ ok: false, error: 'missing vendorId or key' });

  const testModel = TEST_KEY_MODEL[vendorId] || 'gpt-4.1-mini';
  const fakeDispatch = { vendor: vendorId, model: testModel, mode: 'platform', roleId: 'test' };
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

/** 策略系统提示词 */
const STRATEGY_SYSTEM_PROMPTS = {
  fusion: '你是终审决策者。综合前面各阶段的所有信息和建议，提炼各阶段精华，形成最全面、最完整的最终回答。输出纯文本。',
  consensus: '你是终审决策者。分析前面各阶段的意见，保留多方一致认可的观点，剔除存在争议或未经证实的内容。输出纯文本。',
  authority: '你是终审决策者。以评价最高或最权威的模型给出的意见为主，辅以其他阶段的补充。输出纯文本。',
  score: '你是终审决策者。评估前面各阶段的输出质量，仅输出评分最高的中间步骤结果，不做额外修改。输出纯文本。',
};

app.post('/api/ai/generate', generateLimiter, async (req, res) => {
  const prompt = req.body?.prompt ?? '';
  let systemPrompt = req.body?.systemPrompt ?? '';
  const dispatch = req.body?.dispatch || null;
  const userId = req.userId || '';
  const creditCost = Math.max(0, Number(req.body?.creditCost) || 1);

  // 如果是终审角色 D，注入策略系统提示词
  if (dispatch?.roleId === 'D') {
    const db0 = loadDb();
    const strat = req.body?.strategy || db0.settings?.strategy || 'fusion';
    const stratPrompt = STRATEGY_SYSTEM_PROMPTS[strat] || STRATEGY_SYSTEM_PROMPTS.fusion;
    systemPrompt = stratPrompt + (systemPrompt ? '\n\n' + systemPrompt : '');
  }

  const db = loadDb();
  const user = userId ? db.users.find(u => u.id === userId) : null;
  const plan = user?.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const today = todayKey();

  // --- RAG 知识库增强 ---
  let finalPrompt = prompt;
  if (req.body?.useRag && userId && plan !== 'free') {
    try {
      const ragResults = await ragSearch(prompt, userId, db, 3);
      if (ragResults.length > 0) {
        const ragContext = ragResults.map((r, i) => `[知识库 ${i + 1} - ${r.docName}]\n${r.text}`).join('\n\n');
        finalPrompt = `以下是从知识库中检索到的相关资料：\n\n${ragContext}\n\n---\n\n用户问题：${prompt}\n\n请参考上述知识库资料回答问题。如果知识库资料与问题无关，请忽略并直接回答。`;
      }
    } catch { /* RAG 搜索失败时降级为普通查询 */ }
  }

  // --- 0. Free 用户模型白名单检查 ---
  if (plan === 'free' && dispatch?.vendor) {
    const FREE_ALLOWED = { deepseek: true, alibaba: true, openai: ['gpt-4.1-mini', 'gpt-4o-mini'] };
    const v = dispatch.vendor.toLowerCase();
    const allowed = FREE_ALLOWED[v];
    if (!allowed) {
      return res.status(403).json({ ok: false, error: `Free 套餐不支持 ${v} 模型，请升级至 Pro`, code: 'MODEL_RESTRICTED' });
    }
    if (Array.isArray(allowed) && !allowed.includes(dispatch.model)) {
      return res.status(403).json({ ok: false, error: `Free 套餐仅支持 ${allowed.join('/')}，请升级`, code: 'MODEL_RESTRICTED' });
    }
  }

  // --- 1. 每日任务限额检查 ---
  if (limits.dailyTasks > 0 && userId) {
    if (!db.usage[userId]) db.usage[userId] = {};
    if (!db.usage[userId][today]) db.usage[userId][today] = { tasks: 0, credits: 0, tokens: { input: 0, output: 0 }, cost: 0 };
    if (db.usage[userId][today].tasks >= limits.dailyTasks) {
      return res.status(429).json({ ok: false, error: `今日任务已达上限（${limits.dailyTasks} 次），请升级套餐`, code: 'DAILY_LIMIT' });
    }
  }

  // --- 2. 上下文长度截断 ---
  if (limits.contextChars > 0 && finalPrompt.length > limits.contextChars) {
    finalPrompt = finalPrompt.slice(0, limits.contextChars) + '\n\n[...内容已截断至套餐上下文限制]';
  }

  // --- 3. 并发控制（排队等待） ---
  if (userId && limits.concurrency > 0) {
    try {
      await acquireConcurrency(userId, limits.concurrency);
    } catch (queueErr) {
      return res.status(429).json({ ok: false, error: queueErr.message, code: 'QUEUE_FULL' });
    }
  }

  const aiStartTime = Date.now();
  try {
    const { text, stub, inputTokens, outputTokens, apiModel } = await runDispatchLLM(finalPrompt, systemPrompt, dispatch, db.keys, req.body?.files);
    slaMetrics.aiResponseTimes.push(Date.now() - aiStartTime);
    if (slaMetrics.aiResponseTimes.length > SLA_MAX_AI_RT) slaMetrics.aiResponseTimes.shift();

    // --- 4. 记录使用量 ---
    if (userId) {
      const dbAfter = loadDb();
      if (!dbAfter.usage[userId]) dbAfter.usage[userId] = {};
      if (!dbAfter.usage[userId][today]) dbAfter.usage[userId][today] = { tasks: 0, credits: 0, tokens: { input: 0, output: 0 }, cost: 0 };
      const dayUsage = dbAfter.usage[userId][today];
      dayUsage.tasks += 1;
      dayUsage.credits += creditCost;
      dayUsage.tokens.input += (inputTokens || 0);
      dayUsage.tokens.output += (outputTokens || 0);
      const cost = calcCost(apiModel || dispatch?.model, inputTokens || 0, outputTokens || 0);
      dayUsage.cost += cost;

      // 记录 token 日志
      dbAfter.tokenLogs.push({
        ts: new Date().toISOString(),
        userId,
        vendor: dispatch?.vendor,
        model: apiModel || dispatch?.model,
        roleId: dispatch?.roleId,
        inputTokens: inputTokens || 0,
        outputTokens: outputTokens || 0,
        cost: Math.round(cost * 1_000_000) / 1_000_000,
        stub,
      });
      // 只保留最近 5000 条 token 日志
      if (dbAfter.tokenLogs.length > 5000) dbAfter.tokenLogs = dbAfter.tokenLogs.slice(-5000);

      // --- 超额预警：自动触发告警 ---
      if (limits.dailyTasks > 0 && user) {
        const pct = dayUsage.tasks / limits.dailyTasks;
        const prevPct = (dayUsage.tasks - 1) / limits.dailyTasks;
        if (pct >= 1 && prevPct < 1) {
          const cfg = dbAfter.settings?.alertsConfig || defaultAlerts();
          const msg = `用户 ${user.username}（${plan}）达到每日上限 ${limits.dailyTasks} 次`;
          sendWebhookAlert(cfg, '超额预警：用户达到上限', msg).catch(() => {});
          sendEmailAlert(cfg, '超额预警：用户达到上限', msg).catch(() => {});
          addLog(dbAfter, 'warn', user.username, '超额预警', msg);
        } else if (pct >= 0.8 && prevPct < 0.8) {
          addLog(dbAfter, 'warn', user.username, '用量预警', `用户已使用 ${Math.round(pct * 100)}% 每日任务额度（${dayUsage.tasks}/${limits.dailyTasks}）`);
        }
      }

      saveDb(dbAfter);
    }

    const usageWarning = (userId && limits.dailyTasks > 0) ? (() => {
      const dbCheck = loadDb();
      const du = dbCheck.usage[userId]?.[today];
      if (!du) return null;
      const pct = Math.round(du.tasks / limits.dailyTasks * 100);
      if (pct >= 80) return { pct, used: du.tasks, limit: limits.dailyTasks };
      return null;
    })() : null;

    res.json({
      result: text,
      text,
      meta: {
        stub, vendor: dispatch?.vendor, model: dispatch?.model, roleId: dispatch?.roleId,
        inputTokens, outputTokens, truncated: finalPrompt !== prompt,
      },
      usageWarning,
    });
  } finally {
    if (userId && limits.concurrency > 0) {
      releaseConcurrency(userId);
    }
  }
});

// --- 用户用量查询 ---
app.get('/api/user/usage', requireAuth, (req, res) => {
  const db = loadDb();
  const userUsage = db.usage[req.userId] || {};
  const today = todayKey();
  const todayUsage = userUsage[today] || { tasks: 0, credits: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const user = db.users.find(u => u.id === req.userId);
  const plan = user?.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  res.json({ today: todayUsage, limits, plan, allDays: userUsage });
});

// --- 用户提交套餐升级申请 ---
app.post('/api/user/upgrade-request', requireAuth, (req, res) => {
  const { toPlan, message } = req.body || {};
  if (!toPlan || !['pro', 'enterprise'].includes(toPlan)) return res.status(400).json({ ok: false, error: '请选择有效的目标套餐' });
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (user.plan === toPlan) return res.status(400).json({ ok: false, error: '已经是该套餐' });
  // 检查是否有待处理的申请
  const pending = (db.upgradeRequests || []).find(r => r.userId === req.userId && r.status === 'pending');
  if (pending) return res.status(400).json({ ok: false, error: '您已有待审核的升级申请，请等待管理员处理' });
  const request = {
    id: `upg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: req.userId,
    username: user.username,
    fromPlan: user.plan || 'free',
    toPlan,
    message: (message || '').slice(0, 500),
    status: 'pending', // pending | approved | rejected
    createdAt: new Date().toISOString(),
  };
  db.upgradeRequests.push(request);
  saveDb(db);
  res.json({ ok: true, request });
});

// --- 用户查询自己的升级申请 ---
app.get('/api/user/upgrade-requests', requireAuth, (req, res) => {
  const db = loadDb();
  const mine = (db.upgradeRequests || []).filter(r => r.userId === req.userId).sort((a, b) => b.createdAt?.localeCompare(a.createdAt));
  res.json({ ok: true, requests: mine });
});

// --- 管理员: 查看所有升级申请 ---
app.get('/api/admin/upgrade-requests', requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ ok: true, requests: db.upgradeRequests || [] });
});

// --- 管理员: 审批升级申请 ---
app.post('/api/admin/upgrade-requests/:id/review', requireAdmin, (req, res) => {
  const { action, note } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ ok: false, error: '无效操作' });
  const db = loadDb();
  const request = (db.upgradeRequests || []).find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ ok: false, error: '申请不存在' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: '该申请已处理' });
  request.status = action === 'approve' ? 'approved' : 'rejected';
  request.reviewedAt = new Date().toISOString();
  request.reviewNote = (note || '').slice(0, 500);
  request.reviewedBy = req.userId;
  // 如果通过，直接更新用户套餐
  if (action === 'approve') {
    const user = db.users.find(u => u.id === request.userId);
    if (user) {
      user.plan = request.toPlan;
    }
  }
  saveDb(db);
  res.json({ ok: true, request });
});

// ============================================================
//  Phase 3: 支付集成 — Stripe (欧洲) + 支付宝 (中国)
// ============================================================
const PLAN_PRICES = {
  pro:        { eur: 2900, rmb: 19900, label_eur: '€29/月', label_rmb: '¥199/月' },  // 单位: 分
  enterprise: { eur: 49900, rmb: 499900, label_eur: '€499/月', label_rmb: '¥4999/月' },
};

// --- Stripe Checkout Session 创建 ---
app.post('/api/payment/stripe/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, error: 'Stripe 未配置。请设置环境变量 STRIPE_SECRET_KEY' });
  const { plan } = req.body || {};
  const pricing = PLAN_PRICES[plan];
  if (!pricing) return res.status(400).json({ ok: false, error: '无效的套餐' });

  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (user.plan === plan) return res.status(400).json({ ok: false, error: '已经是该套餐' });

  try {
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: pricing.eur,
          recurring: { interval: 'month' },
          product_data: { name: `ZDF.AI ${plan.charAt(0).toUpperCase() + plan.slice(1)}`, description: `ZDF.AI ${plan} 套餐月订阅` },
        },
        quantity: 1,
      }],
      client_reference_id: orderId,
      metadata: { userId: req.userId, plan, orderId },
      success_url: `${req.headers.origin || 'http://localhost:8080'}/?payment=success&order=${orderId}`,
      cancel_url: `${req.headers.origin || 'http://localhost:8080'}/?payment=cancel`,
    });

    db.orders.push({
      id: orderId, userId: req.userId, plan, amount: pricing.eur, currency: 'eur',
      provider: 'stripe', status: 'pending', createdAt: new Date().toISOString(),
      externalId: session.id,
    });
    saveDb(db);

    res.json({ ok: true, url: session.url, orderId });
  } catch (e) {
    console.error('[Stripe] Checkout 创建失败:', e.message);
    res.status(500).json({ ok: false, error: `Stripe 错误: ${e.message}` });
  }
});

// --- 支付宝 H5 支付（服务端签名，生成跳转 URL） ---
app.post('/api/payment/alipay/create-order', requireAuth, async (req, res) => {
  const alipayAppId = process.env.ALIPAY_APP_ID || '';
  const alipayPrivateKey = process.env.ALIPAY_PRIVATE_KEY || '';
  if (!alipayAppId || !alipayPrivateKey) {
    return res.status(503).json({ ok: false, error: '支付宝未配置。请设置环境变量 ALIPAY_APP_ID 和 ALIPAY_PRIVATE_KEY' });
  }

  const { plan } = req.body || {};
  const pricing = PLAN_PRICES[plan];
  if (!pricing) return res.status(400).json({ ok: false, error: '无效的套餐' });

  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (user.plan === plan) return res.status(400).json({ ok: false, error: '已经是该套餐' });

  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const amountYuan = (pricing.rmb / 100).toFixed(2);

  // 构造支付宝 H5 支付参数
  const bizContent = JSON.stringify({
    out_trade_no: orderId,
    total_amount: amountYuan,
    subject: `ZDF.AI ${plan} 套餐`,
    product_code: 'QUICK_WAP_WAY',
  });

  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const params = {
    app_id: alipayAppId,
    method: 'alipay.trade.wap.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp,
    version: '1.0',
    notify_url: `${process.env.ALIPAY_NOTIFY_URL || `http://localhost:${PORT}/api/payment/alipay/notify`}`,
    return_url: `${req.headers.origin || 'http://localhost:8080'}/?payment=success&order=${orderId}`,
    biz_content: bizContent,
  };

  // RSA2 签名
  try {
    const { createSign } = await import('crypto');
    const sorted = Object.keys(params).sort().filter(k => params[k]).map(k => `${k}=${params[k]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(sorted);
    const sign = signer.sign(alipayPrivateKey, 'base64');
    params.sign = sign;

    const formFields = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`).join('');
    const formHtml = `<html><body><form id="f" action="https://openapi.alipay.com/gateway.do" method="POST">${formFields}</form><script>document.getElementById('f').submit();</script></body></html>`;

    db.orders.push({
      id: orderId, userId: req.userId, plan, amount: pricing.rmb, currency: 'cny',
      provider: 'alipay', status: 'pending', createdAt: new Date().toISOString(), externalId: '',
    });
    saveDb(db);

    res.json({ ok: true, orderId, formHtml, amount: amountYuan });
  } catch (e) {
    console.error('[Alipay] 签名失败:', e.message);
    res.status(500).json({ ok: false, error: `支付宝签名错误: ${e.message}` });
  }
});

// --- 支付宝异步通知回调 ---
app.post('/api/payment/alipay/notify', express.urlencoded({ extended: true }), (req, res) => {
  const { out_trade_no, trade_status, trade_no } = req.body || {};
  if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
    const db = loadDb();
    const order = db.orders.find(o => o.id === out_trade_no);
    if (order && order.status === 'pending') {
      order.status = 'paid';
      order.paidAt = new Date().toISOString();
      order.externalId = trade_no || '';
      const user = db.users.find(u => u.id === order.userId);
      if (user && PLAN_PRICES[order.plan]) {
        user.plan = order.plan;
        console.log(`[Alipay] 用户 ${user.username} 升级到 ${order.plan}`);
      }
      saveDb(db);
    }
  }
  res.send('success');
});

// --- 查询用户订单 ---
app.get('/api/user/orders', requireAuth, (req, res) => {
  const db = loadDb();
  const mine = (db.orders || []).filter(o => o.userId === req.userId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ ok: true, orders: mine });
});

// --- 管理员: 查看所有订单 ---
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const db = loadDb();
  const orders = (db.orders || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const users = new Map(db.users.map(u => [u.id, u.username]));
  res.json({ ok: true, orders: orders.map(o => ({ ...o, username: users.get(o.userId) || o.userId })) });
});

// --- 管理员: 全量使用统计 ---
app.get('/api/admin/usage-stats', requireAdmin, (req, res) => {
  const db = loadDb();
  const today = todayKey();
  let totalTasks = 0, totalTokensIn = 0, totalTokensOut = 0, totalCost = 0;
  for (const uid of Object.keys(db.usage)) {
    const dayData = db.usage[uid]?.[today];
    if (dayData) {
      totalTasks += dayData.tasks || 0;
      totalTokensIn += dayData.tokens?.input || 0;
      totalTokensOut += dayData.tokens?.output || 0;
      totalCost += dayData.cost || 0;
    }
  }
  // 用户排行
  const ranking = db.users
    .filter(u => u.role !== 'admin')
    .map(u => {
      const ud = db.usage[u.id]?.[today] || { tasks: 0, cost: 0, tokens: { input: 0, output: 0 } };
      return { userId: u.id, username: u.username, plan: u.plan, tasks: ud.tasks, cost: ud.cost, tokensIn: ud.tokens?.input || 0, tokensOut: ud.tokens?.output || 0 };
    })
    .sort((a, b) => b.tasks - a.tasks)
    .slice(0, 20);
  // 最近 7 天趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dk = d.toISOString().slice(0, 10);
    let tasks = 0, cost = 0, tokensIn = 0, tokensOut = 0;
    for (const uid of Object.keys(db.usage)) {
      const dd = db.usage[uid]?.[dk];
      if (dd) { tasks += dd.tasks || 0; cost += dd.cost || 0; tokensIn += dd.tokens?.input || 0; tokensOut += dd.tokens?.output || 0; }
    }
    trend.push({ date: dk, tasks, cost: Math.round(cost * 100) / 100, tokensIn, tokensOut });
  }
  // --- 模型成本分布 ---
  const modelCosts = {};
  for (const log of db.tokenLogs || []) {
    if (log.ts?.startsWith(today)) {
      const key = `${log.vendor}/${log.model}`;
      if (!modelCosts[key]) modelCosts[key] = { vendor: log.vendor, model: log.model, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      modelCosts[key].calls++;
      modelCosts[key].inputTokens += log.inputTokens || 0;
      modelCosts[key].outputTokens += log.outputTokens || 0;
      modelCosts[key].cost += log.cost || 0;
    }
  }
  const modelBreakdown = Object.values(modelCosts).sort((a, b) => b.cost - a.cost);

  // --- 并发统计 ---
  const concurrencyStats = {};
  for (const [uid, count] of concurrencyMap.entries()) {
    if (count > 0) concurrencyStats[uid] = count;
  }

  // --- 盈利分析 ---
  const planPricing = { free: 0, pro: 48, enterprise: 500, max: 500 };
  let estRevenue = 0;
  const revBreakdown = { free: 0, pro: 0, enterprise: 0 };
  const planCounts = { free: 0, pro: 0, enterprise: 0 };
  for (const u of db.users) {
    if (u.role === 'admin') continue;
    const p = u.plan || 'free';
    const price = planPricing[p] || 0;
    estRevenue += price;
    revBreakdown[p] = (revBreakdown[p] || 0) + price;
    planCounts[p] = (planCounts[p] || 0) + 1;
  }
  const thisMonth = today.slice(0, 7);
  let monthlyCost = 0, monthlyTokensIn = 0, monthlyTokensOut = 0, monthlyTasks = 0;
  for (const uid of Object.keys(db.usage)) {
    for (const [dk, dd] of Object.entries(db.usage[uid])) {
      if (dk.startsWith(thisMonth)) {
        monthlyCost += dd.cost || 0;
        monthlyTokensIn += dd.tokens?.input || 0;
        monthlyTokensOut += dd.tokens?.output || 0;
        monthlyTasks += dd.tasks || 0;
      }
    }
  }

  res.json({
    today: { totalTasks, totalTokensIn, totalTokensOut, totalCost: Math.round(totalCost * 100) / 100 },
    ranking, trend, tokenLogs: db.tokenLogs.slice(-100),
    modelBreakdown,
    concurrency: { active: concurrencyStats, queueLength: Object.values(concurrencyStats).reduce((s, v) => s + v, 0) },
    revenue: {
      estimatedMonthly: estRevenue,
      breakdown: revBreakdown,
      planCounts,
      monthlyCost: Math.round(monthlyCost * 10000) / 10000,
      monthlyProfit: Math.round((estRevenue - monthlyCost) * 100) / 100,
      margin: estRevenue > 0 ? Math.round((1 - monthlyCost / estRevenue) * 10000) / 100 : 0,
      monthlyTasks,
      monthlyTokensIn,
      monthlyTokensOut,
    },
  });
});

// --- 用户: 历史记录导出 ---
app.get('/api/user/export-history', requireAuth, (req, res) => {
  const plan = req.userPlan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (!limits.canExport) return res.status(403).json({ ok: false, error: '当前套餐不支持导出功能，请升级至 Pro 或以上' });
  const db = loadDb();
  const userHistory = (db.histories || {})[req.userId] || [];
  const format = req.query.format || 'json';
  if (format === 'csv') {
    let csv = 'ID,问题,回答,时间,策略\n';
    for (const h of userHistory) {
      const q = (h.question || '').replace(/"/g, '""');
      const a = (h.answer || '').replace(/"/g, '""');
      csv += `${h.id},"${q}","${a}",${h.timestamp || ''},"${h.strategyName || ''}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=zdf_history.csv');
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=zdf_history.json');
    res.json({ ok: true, history: userHistory, exportedAt: new Date().toISOString() });
  }
});

// --- 管理员: 导出权限检查 ---
app.get('/api/user/can-export', requireAuth, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  const plan = user?.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  res.json({ canExport: limits.canExport, plan });
});

// --- 用户 API Key 管理 (Pro+) ---
function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'zdf_ak_';
  for (let i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

app.get('/api/user/api-keys', requireAuth, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  const limits = PLAN_LIMITS[user?.plan || 'free'] || PLAN_LIMITS.free;
  if (!limits.canApi) return res.json({ ok: true, keys: [], allowed: false });
  const myKeys = (db.userApiKeys || []).filter(k => k.userId === req.userId).map(k => ({ ...k, key: k.key.slice(0, 12) + '...' + k.key.slice(-4) }));
  res.json({ ok: true, keys: myKeys, allowed: true });
});

app.post('/api/user/api-keys', requireAuth, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  const limits = PLAN_LIMITS[user?.plan || 'free'] || PLAN_LIMITS.free;
  if (!limits.canApi) return res.status(403).json({ ok: false, error: '当前套餐不支持 API 访问，需升级到 Pro' });
  const myKeys = (db.userApiKeys || []).filter(k => k.userId === req.userId);
  if (myKeys.length >= 5) return res.status(400).json({ ok: false, error: '最多创建 5 个 API Key' });
  const name = (req.body?.name || '').trim() || `Key-${myKeys.length + 1}`;
  const key = generateApiKey();
  const row = { key, userId: req.userId, name, createdAt: new Date().toISOString(), lastUsed: null };
  db.userApiKeys.push(row);
  saveDb(db);
  res.json({ ok: true, apiKey: key, name });  // 仅创建时返回完整 key
});

app.delete('/api/user/api-keys/:keyPrefix', requireAuth, (req, res) => {
  const db = loadDb();
  const prefix = req.params.keyPrefix;
  const idx = db.userApiKeys.findIndex(k => k.userId === req.userId && k.key.startsWith(prefix));
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Key 不存在' });
  db.userApiKeys.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

// --- RAG 知识库 ---
app.get('/api/rag/docs', requireAuth, (req, res) => {
  const db = loadDb();
  const docs = (db.ragDocs || []).filter(d => d.userId === req.userId);
  const usedBytes = getUserRagStorageBytes(req.userId);
  const plan = req.userPlan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  res.json({ ok: true, docs, storage: { usedBytes, quotaMB: limits.ragQuotaMB } });
});

app.post('/api/rag/upload', requireAuth, ragUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '缺少文件' });
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  const perms = getUserPermissions(user);
  if (!perms.includes('user.rag')) return res.status(403).json({ ok: false, error: '当前套餐不支持 RAG 知识库' });

  // --- 存储配额检查 ---
  const plan = user?.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (limits.ragQuotaMB > 0) {
    const usedBytes = getUserRagStorageBytes(req.userId);
    const quotaBytes = limits.ragQuotaMB * 1024 * 1024;
    if (usedBytes + req.file.size > quotaBytes) {
      try { fs.unlinkSync(req.file.path); } catch {}
      const usedMB = (usedBytes / 1024 / 1024).toFixed(1);
      return res.status(413).json({ ok: false, error: `知识库存储已达上限（已用 ${usedMB}MB / 限额 ${limits.ragQuotaMB}MB）。请删除旧文档或升级套餐。` });
    }
  }

  const docId = `rag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  // 提取文本 + 切块
  const text = await extractText(filePath);
  if (!text || text.length < 20) return res.status(400).json({ ok: false, error: '无法从文件中提取有效文本（支持 txt/md/csv/pdf/docx）' });
  const chunks = chunkText(text);

  // 生成 Embedding
  try {
    const embeddings = await getEmbeddings(chunks, db);
    const vectorChunks = chunks.map((c, i) => ({ text: c, embedding: embeddings[i] }));
    ragVectorStore.set(docId, vectorChunks);
    // 写入 embedding 缓存到磁盘（重启时无需重新调 API）
    try {
      const cachePath = embeddingCachePath(docId, req.userId);
      const serializable = vectorChunks.map(c => ({ text: c.text, embedding: Array.from(c.embedding) }));
      fs.writeFileSync(cachePath, JSON.stringify(serializable), 'utf8');
    } catch {}

    const docMeta = { id: docId, userId: req.userId, filename: req.file.filename, originalName, chunks: chunks.length, chars: text.length, createdAt: new Date().toISOString() };
    db.ragDocs.push(docMeta);
    addLog(db, 'info', req.userId, 'RAG上传', `上传文档 ${originalName}（${chunks.length} 块，${text.length} 字符）`);
    saveDb(db);
    res.json({ ok: true, doc: docMeta });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Embedding 生成失败: ${e.message}` });
  }
});

app.delete('/api/rag/docs/:id', requireAuth, (req, res) => {
  const db = loadDb();
  const idx = db.ragDocs.findIndex(d => d.id === req.params.id && d.userId === req.userId);
  if (idx < 0) return res.status(404).json({ ok: false, error: '文档不存在' });
  const doc = db.ragDocs[idx];
  // 删除文件
  try { fs.unlinkSync(path.join(RAG_DIR, req.userId, doc.filename)); } catch {}
  ragVectorStore.delete(doc.id);
  db.ragDocs.splice(idx, 1);
  addLog(db, 'info', req.userId, 'RAG删除', `删除文档 ${doc.originalName}`);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/rag/search', requireAuth, async (req, res) => {
  const { query, topK } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, error: '缺少 query' });
  const db = loadDb();
  const results = await ragSearch(query, req.userId, db, topK || 5);
  res.json({ ok: true, results });
});

// --- 组织/团队管理 (多租户) ---
app.get('/api/user/orgs', requireAuth, (req, res) => {
  const db = loadDb();
  const orgs = (db.orgs || []).filter(o => o.members.some(m => m.userId === req.userId));
  const result = orgs.map(o => {
    const member = o.members.find(m => m.userId === req.userId);
    return { id: o.id, name: o.name, role: member?.role || 'member', memberCount: o.members.length, createdAt: o.createdAt };
  });
  res.json({ ok: true, orgs: result });
});

app.post('/api/user/orgs', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
    return res.status(400).json({ ok: false, error: '组织名称需 2-50 字符' });
  }
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user || !['pro', 'enterprise', 'max'].includes(user.plan)) {
    return res.status(403).json({ ok: false, error: '仅 Pro 及以上套餐可创建组织' });
  }
  const org = {
    id: `org_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    ownerId: req.userId,
    members: [{ userId: req.userId, role: 'owner', joinedAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  };
  db.orgs.push(org);
  addLog(db, 'info', req.userId, '创建组织', `创建了组织「${org.name}」`);
  saveDb(db);
  res.json({ ok: true, org: { id: org.id, name: org.name, role: 'owner', memberCount: 1, createdAt: org.createdAt } });
});

app.get('/api/orgs/:orgId/members', requireAuth, (req, res) => {
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  if (!org.members.some(m => m.userId === req.userId)) return res.status(403).json({ ok: false, error: '非组织成员' });
  const members = org.members.map(m => {
    const u = db.users.find(x => x.id === m.userId);
    return { userId: m.userId, username: u?.username, name: u?.name, role: m.role, joinedAt: m.joinedAt };
  });
  res.json({ ok: true, members, orgName: org.name });
});

app.post('/api/orgs/:orgId/members', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ ok: false, error: '请提供用户名' });
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  const me = org.members.find(m => m.userId === req.userId);
  if (!me || !['owner', 'admin'].includes(me.role)) return res.status(403).json({ ok: false, error: '无权添加成员' });
  const target = db.users.find(u => u.username === username.trim());
  if (!target) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (org.members.some(m => m.userId === target.id)) return res.status(400).json({ ok: false, error: '用户已是成员' });
  org.members.push({ userId: target.id, role: 'member', joinedAt: new Date().toISOString() });
  addLog(db, 'info', req.userId, '添加组织成员', `将 ${target.username} 加入组织「${org.name}」`);
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/orgs/:orgId/members/:memberId', requireAuth, (req, res) => {
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  const me = org.members.find(m => m.userId === req.userId);
  if (!me || !['owner', 'admin'].includes(me.role)) return res.status(403).json({ ok: false, error: '无权移除成员' });
  if (req.params.memberId === org.ownerId) return res.status(400).json({ ok: false, error: '不能移除组织所有者' });
  const idx = org.members.findIndex(m => m.userId === req.params.memberId);
  if (idx < 0) return res.status(404).json({ ok: false, error: '成员不存在' });
  org.members.splice(idx, 1);
  addLog(db, 'info', req.userId, '移除组织成员', `将成员从组织「${org.name}」中移除`);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/orgs/:orgId/members/:memberId/role', requireAuth, (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ ok: false, error: '角色无效' });
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  const me = org.members.find(m => m.userId === req.userId);
  if (!me || me.role !== 'owner') return res.status(403).json({ ok: false, error: '仅所有者可变更角色' });
  const target = org.members.find(m => m.userId === req.params.memberId);
  if (!target) return res.status(404).json({ ok: false, error: '成员不存在' });
  target.role = role;
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/orgs/:orgId/rag/docs', requireAuth, (req, res) => {
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  if (!org.members.some(m => m.userId === req.userId)) return res.status(403).json({ ok: false, error: '非组织成员' });
  const docs = (db.ragDocs || []).filter(d => d.scope === 'org' && d.orgId === req.params.orgId);
  res.json({ ok: true, docs, orgName: org.name });
});

app.post('/api/orgs/:orgId/rag/upload', requireAuth, ragUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '缺少文件' });
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(404).json({ ok: false, error: '组织不存在' }); }
  const me = org.members.find(m => m.userId === req.userId);
  if (!me || !['owner', 'admin'].includes(me.role)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(403).json({ ok: false, error: '仅管理员可上传组织文档' });
  }

  const docId = `rag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const text = await extractText(filePath);
  if (!text || text.length < 20) return res.status(400).json({ ok: false, error: '无法从文件中提取有效文本' });
  const chunks = chunkText(text);

  try {
    const embeddings = await getEmbeddings(chunks, db);
    const vectorChunks = chunks.map((c, i) => ({ text: c, embedding: embeddings[i] }));
    ragVectorStore.set(docId, vectorChunks);
    try {
      const cachePath = embeddingCachePath(docId, req.userId);
      const serializable = vectorChunks.map(c => ({ text: c.text, embedding: Array.from(c.embedding) }));
      fs.writeFileSync(cachePath, JSON.stringify(serializable), 'utf8');
    } catch {}

    const docMeta = { id: docId, userId: req.userId, orgId: req.params.orgId, scope: 'org', filename: req.file.filename, originalName, chunks: chunks.length, chars: text.length, createdAt: new Date().toISOString() };
    db.ragDocs.push(docMeta);
    addLog(db, 'info', req.userId, '组织RAG上传', `向组织「${org.name}」上传文档 ${originalName}`);
    saveDb(db);
    res.json({ ok: true, doc: docMeta });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Embedding 生成失败: ${e.message}` });
  }
});

app.delete('/api/orgs/:orgId/rag/docs/:docId', requireAuth, (req, res) => {
  const db = loadDb();
  const org = (db.orgs || []).find(o => o.id === req.params.orgId);
  if (!org) return res.status(404).json({ ok: false, error: '组织不存在' });
  const me = org.members.find(m => m.userId === req.userId);
  if (!me || !['owner', 'admin'].includes(me.role)) return res.status(403).json({ ok: false, error: '仅管理员可删除组织文档' });
  const idx = db.ragDocs.findIndex(d => d.id === req.params.docId && d.orgId === req.params.orgId);
  if (idx < 0) return res.status(404).json({ ok: false, error: '文档不存在' });
  const doc = db.ragDocs[idx];
  try { fs.unlinkSync(path.join(RAG_DIR, doc.userId, doc.filename)); } catch {}
  ragVectorStore.delete(doc.id);
  db.ragDocs.splice(idx, 1);
  addLog(db, 'info', req.userId, '组织RAG删除', `从组织「${org.name}」删除文档 ${doc.originalName}`);
  saveDb(db);
  res.json({ ok: true });
});

// --- 工作流管理 ---
app.get('/api/workflows', requireAuth, (req, res) => {
  const db = loadDb();
  const workflows = db.workflows || DEFAULT_WORKFLOWS;
  res.json({ ok: true, workflows: workflows.filter(w => w.active !== false) });
});

app.get('/api/admin/workflows', requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ ok: true, workflows: db.workflows || DEFAULT_WORKFLOWS });
});

app.post('/api/admin/workflows', requireAdmin, (req, res) => {
  const { name, steps } = req.body || {};
  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ ok: false, error: '工作流名称和步骤不能为空' });
  }
  for (const s of steps) {
    if (!s.id || !s.role) return res.status(400).json({ ok: false, error: '每个步骤需要 id 和 role' });
  }
  const db = loadDb();
  const wf = {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name, steps, builtin: false, active: true,
    createdBy: req.userId, createdAt: new Date().toISOString(),
  };
  db.workflows.push(wf);
  addLog(db, 'info', req.userId, '创建工作流', `创建自定义工作流「${name}」（${steps.length} 步）`);
  saveDb(db);
  res.json({ ok: true, workflow: wf });
});

app.put('/api/admin/workflows/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const wf = (db.workflows || []).find(w => w.id === req.params.id);
  if (!wf) return res.status(404).json({ ok: false, error: '工作流不存在' });
  if (wf.builtin) return res.status(400).json({ ok: false, error: '内置工作流不可编辑' });
  const { name, steps, active } = req.body || {};
  if (name) wf.name = name;
  if (Array.isArray(steps) && steps.length > 0) wf.steps = steps;
  if (typeof active === 'boolean') wf.active = active;
  addLog(db, 'info', req.userId, '编辑工作流', `修改工作流「${wf.name}」`);
  saveDb(db);
  res.json({ ok: true, workflow: wf });
});

app.delete('/api/admin/workflows/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.workflows || []).findIndex(w => w.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: '工作流不存在' });
  if (db.workflows[idx].builtin) return res.status(400).json({ ok: false, error: '内置工作流不可删除' });
  const removed = db.workflows.splice(idx, 1)[0];
  addLog(db, 'info', req.userId, '删除工作流', `删除工作流「${removed.name}」`);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/workflow/execute', requireAuth, async (req, res) => {
  const { workflowId, input, dispatch } = req.body || {};
  if (!input) return res.status(400).json({ ok: false, error: '缺少输入' });
  const db = loadDb();
  const wf = (db.workflows || []).find(w => w.id === workflowId && w.active !== false);
  if (!wf) return res.status(404).json({ ok: false, error: '工作流不存在或已禁用' });

  const user = db.users.find(u => u.id === req.userId);
  const plan = user?.plan || 'free';
  if (plan === 'free' && wf.steps.length > 1) {
    return res.status(403).json({ ok: false, error: 'Free 套餐仅支持单步工作流' });
  }

  const stepResults = {};
  const stepDetails = [];
  try {
    for (const step of wf.steps) {
      let prompt = (step.inputTemplate || '{input}').replace(/\{input\}/g, input);
      for (const [key, val] of Object.entries(stepResults)) {
        prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
      }
      const stepDispatch = dispatch?.[step.id] || dispatch?.default || dispatch || null;
      const { text, inputTokens, outputTokens, apiModel } = await runDispatchLLM(prompt, step.systemPrompt || '', stepDispatch, db.keys);
      stepResults[step.id] = text;
      stepDetails.push({ stepId: step.id, role: step.role, text, inputTokens, outputTokens, model: apiModel });
    }
    const finalStep = wf.steps[wf.steps.length - 1];
    res.json({ ok: true, result: stepResults[finalStep.id], steps: stepDetails, workflowName: wf.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: `工作流执行失败: ${e.message}`, steps: stepDetails });
  }
});

// --- RBAC 权限查询 ---
// --- 用户: 修改个人资料 ---
app.post('/api/user/profile', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 50) {
    return res.status(400).json({ ok: false, error: '昵称长度需在 1-50 字符之间' });
  }
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  user.name = name.trim();
  saveDb(db);
  res.json({ ok: true, name: user.name });
});

app.get('/api/user/permissions', requireAuth, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.userId);
  const perms = getUserPermissions(user);
  res.json({ ok: true, permissions: perms, roleDetail: user?.roleDetail || 'user', plan: user?.plan || 'free' });
});

// --- L10: Admin RAG 存储统计 ---
app.get('/api/admin/rag-stats', requireAdmin, (req, res) => {
  const db = loadDb();
  const docs = db.ragDocs || [];
  const userStats = {};
  for (const doc of docs) {
    if (!userStats[doc.userId]) userStats[doc.userId] = { docs: 0, chunks: 0, chars: 0, bytes: 0 };
    userStats[doc.userId].docs++;
    userStats[doc.userId].chunks += doc.chunks || 0;
    userStats[doc.userId].chars += doc.chars || 0;
  }
  for (const uid of Object.keys(userStats)) {
    userStats[uid].bytes = getUserRagStorageBytes(uid);
    const u = db.users.find(x => x.id === uid);
    userStats[uid].username = u?.username || uid;
    userStats[uid].plan = u?.plan || 'free';
  }
  res.json({ ok: true, stats: userStats, totalDocs: docs.length });
});

// --- SLA 仪表盘数据 ---
app.get('/api/admin/sla', requireAdmin, (req, res) => {
  const uptimeMs = Date.now() - SLA_START_TIME;
  const uptimeHours = (uptimeMs / 3600000).toFixed(1);
  const uptimeDays = (uptimeMs / 86400000).toFixed(2);

  const rts = slaMetrics.responseTimes;
  const aiRts = slaMetrics.aiResponseTimes;
  const sorted = [...rts].sort((a, b) => a - b);
  const aiSorted = [...aiRts].sort((a, b) => a - b);

  const percentile = (arr, p) => arr.length === 0 ? 0 : arr[Math.floor(arr.length * p / 100)] || 0;
  const avg = (arr) => arr.length === 0 ? 0 : Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);

  const availability = slaMetrics.totalRequests === 0 ? 100
    : ((1 - slaMetrics.totalErrors / slaMetrics.totalRequests) * 100).toFixed(3);

  const hourlyKeys = Object.keys(slaMetrics.hourlyUptime).sort().slice(-168);
  const hourlyData = hourlyKeys.map(k => {
    const h = slaMetrics.hourlyUptime[k];
    const total = h.ok + h.err;
    return { hour: k, requests: total, errors: h.err, availability: total === 0 ? 100 : ((h.ok / total) * 100).toFixed(2) };
  });

  res.json({
    ok: true,
    uptime: { ms: uptimeMs, hours: parseFloat(uptimeHours), days: parseFloat(uptimeDays), startedAt: new Date(SLA_START_TIME).toISOString() },
    availability: parseFloat(availability),
    totalRequests: slaMetrics.totalRequests,
    totalErrors: slaMetrics.totalErrors,
    responseTime: {
      avg: avg(rts), p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
      samples: rts.length,
    },
    aiResponseTime: {
      avg: avg(aiRts), p50: percentile(aiSorted, 50), p95: percentile(aiSorted, 95), p99: percentile(aiSorted, 99),
      samples: aiRts.length,
    },
    hourly: hourlyData,
  });
});

// --- 短信告警（阿里云 SMS HTTP API + HMAC-SHA1 签名） ---
function aliyunSign(params, accessSecret) {
  const sorted = Object.keys(params).sort();
  const canonicalized = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const stringToSign = `POST&${encodeURIComponent('/')}&${encodeURIComponent(canonicalized)}`;
  const hmac = CryptoJS.HmacSHA1(stringToSign, accessSecret + '&');
  return CryptoJS.enc.Base64.stringify(hmac);
}

async function sendSmsAlert(alertsConfig, title, content) {
  const phone = (alertsConfig.phone || '').trim();
  const appKeyRaw = (alertsConfig.smsAppKey || '').trim();
  const provider = (alertsConfig.smsProvider || 'aliyun').trim();
  const smsSign = (alertsConfig.smsSign || 'ZDF.AI').trim();
  const smsTemplate = (alertsConfig.smsTemplate || '').trim();
  if (!phone || !appKeyRaw) return [];

  if (provider === 'aliyun') {
    // appKey 格式: "AccessKeyId:AccessKeySecret"
    const parts = appKeyRaw.split(':');
    if (parts.length < 2) {
      return [{ channel: 'sms', ok: false, msg: 'AccessKey 格式应为 AccessKeyId:AccessKeySecret' }];
    }
    const [accessKeyId, accessSecret] = parts;
    if (!smsTemplate) {
      return [{ channel: 'sms', ok: false, msg: '请配置短信模板编号（如 SMS_123456）' }];
    }
    try {
      const params = {
        AccessKeyId: accessKeyId,
        Action: 'SendSms',
        Format: 'JSON',
        PhoneNumbers: phone,
        RegionId: 'cn-hangzhou',
        SignName: smsSign,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        SignatureVersion: '1.0',
        TemplateCode: smsTemplate,
        TemplateParam: JSON.stringify({ title: title.slice(0, 20), content: content.slice(0, 100) }),
        Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        Version: '2017-05-25',
      };
      params.Signature = aliyunSign(params, accessSecret);

      const body = new URLSearchParams(params).toString();
      const res = await fetch('https://dysmsapi.aliyuncs.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json = await res.json();
      if (json.Code === 'OK') {
        console.log(`[SMS] 阿里云短信发送成功 -> ${phone}`);
        return [{ channel: 'sms', ok: true, msg: `短信已发送到 ${phone}` }];
      } else {
        console.warn(`[SMS] 阿里云返回错误:`, json);
        return [{ channel: 'sms', ok: false, msg: `阿里云 SMS 错误: ${json.Code} - ${json.Message}` }];
      }
    } catch (e) {
      console.error('[SMS] 发送异常:', e.message);
      return [{ channel: 'sms', ok: false, msg: `短信发送异常: ${e.message}` }];
    }
  }
  return [{ channel: 'sms', ok: false, msg: `不支持的 SMS 提供商: ${provider}` }];
}

// --- M14: 服务端 DOCX 导出 ---
app.get('/api/user/export-docx', requireAuth, async (req, res) => {
  const db = loadDb();
  const hist = db.histories[req.userId] || [];
  if (hist.length === 0) return res.status(404).json({ ok: false, error: '无历史记录' });
  // 生成简单 OOXML .docx（最小化实现，不依赖额外库的 XML 拼接）
  const escXml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let body = '';
  for (const h of hist.slice(-100)) {
    const time = h.id ? new Date(h.id).toLocaleString('zh-CN') : '';
    body += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escXml(time)} — ${escXml(h.model || '')}</w:t></w:r></w:p>`;
    body += `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>提问: </w:t></w:r><w:r><w:t>${escXml((h.prompt || '').slice(0, 500))}</w:t></w:r></w:p>`;
    body += `<w:p><w:r><w:t>${escXml((h.result || '').slice(0, 2000))}</w:t></w:r></w:p>`;
    body += `<w:p/>`;
  }
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  // 用 Node.js 内置 zlib 打包 ZIP (DOCX = ZIP)
  const { createDeflateRaw } = await import('zlib');
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(docXml, 'utf8') },
  ];
  // 简单 STORE-mode ZIP（无压缩，兼容性最好）
  const parts = [];
  const centralDir = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // sig
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 8); // compression: store
    localHeader.writeUInt32LE(crc32(entry.data), 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    parts.push(localHeader, nameBytes, entry.data);
    // central dir entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt32LE(crc32(entry.data), 16);
    cdEntry.writeUInt32LE(entry.data.length, 20);
    cdEntry.writeUInt32LE(entry.data.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt32LE(offset, 42);
    centralDir.push(cdEntry, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  const zipBuffer = Buffer.concat([...parts, ...centralDir, eocd]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', 'attachment; filename="zdf_history.docx"');
  res.send(zipBuffer);
});

/** CRC-32 (for ZIP) */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- M15: 服务端 PDF 导出 (pdfkit) ---
app.get('/api/user/export-pdf', requireAuth, (req, res) => {
  const db = loadDb();
  const hist = db.histories[req.userId] || [];
  if (hist.length === 0) return res.status(404).json({ ok: false, error: '无历史记录' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="zdf_history.pdf"');
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(res);
  doc.fontSize(18).text('ZDF.AI — 对话历史导出', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).fillColor('#666').text(`导出时间: ${new Date().toLocaleString('zh-CN')}  |  共 ${hist.length} 条记录`, { align: 'center' });
  doc.moveDown(2);
  for (const h of hist.slice(-100)) {
    const time = h.id ? new Date(h.id).toLocaleString('zh-CN') : '';
    doc.fontSize(11).fillColor('#333').text(`[${time}] 模型: ${h.model || 'N/A'}`, { underline: true });
    doc.fontSize(10).fillColor('#000').text(`提问: ${(h.prompt || '').slice(0, 500)}`);
    doc.fontSize(10).fillColor('#444').text(`回答: ${(h.result || '').slice(0, 2000)}`);
    doc.moveDown();
    if (doc.y > 700) doc.addPage();
  }
  doc.end();
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
  // 异步重建 RAG 向量索引（不阻塞启动）
  rebuildRagVectors().catch(e => console.warn('[RAG] 向量索引重建异常:', e.message));
});
