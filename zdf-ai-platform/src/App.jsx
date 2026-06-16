import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Activity, Settings, Users, ShieldCheck, MessageSquare, Play,
  CheckCircle2, AlertCircle, Database, LayoutDashboard, LogOut,
  Zap, Info, CreditCard, ArrowRight, Paperclip, X, FileText,
  Clock, Trash2, Mail, Lock, User, Key, MonitorDot,
  Crown, MessageCircleQuestion, Send, Sliders, Image,
  Download, Share2, Smartphone, BellRing, Server, AlertTriangle,
  ClipboardList, UserCog, Save, Plus, ArrowLeftRight, BookOpen, Upload, Search,
  GitBranch, Shield, Cloud, TrendingUp, DollarSign, PieChart, BarChart3
} from 'lucide-react';

const ROLES = [
  { id: 'A', name: '生成者', description: '给出初始答案', icon: <MessageSquare size={18} /> },
  { id: 'B', name: '校核者', description: '事实与逻辑校核', icon: <ShieldCheck size={18} /> },
  { id: 'C', name: '审核者', description: '质量与风险识别', icon: <AlertCircle size={18} /> },
  { id: 'D', name: '终审者', description: '裁定并输出最终答案', icon: <CheckCircle2 size={18} /> },
];

const STRATEGIES = [
  { id: 'fusion', name: '综合融合', desc: '提炼各阶段精华，形成最全回答' },
  { id: 'consensus', name: '共识优先', desc: '保留多方一致的观点，剔除争议' },
  { id: 'authority', name: '权威优先', desc: '以高权重模型的意见为主' },
  { id: 'score', name: '评分最优', desc: '仅输出评分最高的中间步骤结果' },
];

const FALLBACK_VENDORS = [
  { id: 'openai', name: 'OpenAI', region: 'US', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini'] },
  { id: 'anthropic', name: 'Anthropic', region: 'US', models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5'] },
  { id: 'google', name: 'Google', region: 'US', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'] },
  { id: 'deepseek', name: 'DeepSeek (深度求索)', region: 'CN', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { id: 'alibaba', name: 'Alibaba (阿里)', region: 'CN', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-plus', 'qwen3-coder-plus'] },
  { id: 'zhipu', name: 'Zhipu (智谱)', region: 'CN', models: ['glm-5.1', 'glm-5', 'glm-4-plus', 'glm-4'] },
  { id: 'doubao', name: 'Doubao (豆包)', region: 'CN', models: ['doubao-seed-2.0-pro', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-code', 'doubao-pro-128k'] },
  { id: 'moonshot', name: 'Moonshot (月之暗面)', region: 'CN', models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k'] },
];

const PLANS = [
  {
    id: 'free', name: 'Free 免费版', price: '免费', priceEn: '€0 / mo',
    features: ['每日 20 次任务', '1 路并发', '32K 上下文', '7 天历史记录', 'DeepSeek · Qwen · GPT-4.1-mini'],
    canExport: false, canApi: false, canRag: false,
  },
  {
    id: 'pro', name: 'Pro 专业版', price: '199~399 RMB/月', priceEn: '€29~59 / mo',
    features: ['每日 500 次任务', '5 路并发', '256K 上下文', '无限历史记录', 'PDF / Word 导出', 'API 接口', 'RAG 基础版'],
    canExport: true, canApi: true, canRag: true,
  },
  {
    id: 'enterprise', name: 'Enterprise 企业版', price: '联系我们', priceEn: 'Contact Us',
    features: ['无限次任务', '50+ 并发', '无限上下文', '私有化部署', 'RBAC 权限', '审计日志', 'SLA 支持'],
    canExport: true, canApi: true, canRag: true,
  },
];

// 套餐限额（-1 表示无限）
const PLAN_LIMITS = {
  free:       { dailyTasks: 20,  historyDays: 7,  canExport: false, canRag: false },
  pro:        { dailyTasks: 500, historyDays: -1, canExport: true,  canRag: true  },
  enterprise: { dailyTasks: -1,  historyDays: -1, canExport: true,  canRag: true  },
  max:        { dailyTasks: -1,  historyDays: -1, canExport: true,  canRag: true  }, // 历史兼容
};

// AI Credit 消耗定义（与后端 CLAUDE.md 一致）
const CREDIT_COSTS = { single: 1, pipeline: 5, rag: 10, deepReasoning: 20 };
const PIPELINE_CREDITS = 5;  // 四模型协同流水线总消耗（前端 UI 展示用）

const API_BASE_URL = "/api"; // 部署前务必使用相对路径，让 Nginx 代理到后端 3000

const stripMarkdown = (text) => {
  if (!text) return text;
  return text.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/#{1,6}\s?/g, '').replace(/---/g, '').replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * 调用后端统一调度接口；`dispatch` 携带流水线角色与厂商/模型，便于多模型路由与测试。
 * @param {string} prompt
 * @param {string} systemPrompt
 * @param {Array<{ name: string, type: string, isImage: boolean, data: string | null }>} files
 * @param {{ roleId: string, vendor: string, model: string, mode: string, selfKey?: string } | null} [dispatch]
 * @returns {Promise<string>}
 */
const callGemini = async (prompt, systemPrompt = "", files = [], dispatch = null, extraPayload = {}) => {
  let retries = 0;
  const maxRetries = 3;
  const payload = {
    prompt,
    systemPrompt,
    files: files.map(f => ({ name: f.name, type: f.type, isImage: f.isImage, data: f.data })),
    ...(dispatch ? { dispatch } : {}),
    ...extraPayload,
  };

  const execute = async () => {
    const response = await fetch(`${API_BASE_URL}/ai/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errHint = '';
      let errCode = '';
      try {
        const errJson = await response.json();
        errHint = errJson.error || errJson.message || '';
        errCode = errJson.code || '';
      } catch {
        /* ignore */
      }
      if (errCode === 'MODEL_RESTRICTED') {
        throw new Error(`__UPGRADE__:${errHint}`);
      }
      if (errCode === 'DAILY_LIMIT') {
        throw new Error(`__UPGRADE__:${errHint}`);
      }
      console.warn('后端 /ai/generate 非成功状态，启用离线降级模拟...', response.status);
      await new Promise(r => setTimeout(r, 800));
      return `[模拟回复] ${errHint || `HTTP ${response.status}`}\n请确认后端已启动且 API Key 已配置。`;
    }

    const data = await response.json();
    return data.result || data.text || '无返回内容';
  };

  while (retries < maxRetries) {
    try {
      return await execute();
    } catch (e) {
      if (e?.message?.startsWith('__UPGRADE__:')) throw e;
      retries++;
      await new Promise(r => setTimeout(r, Math.pow(2, retries) * 500));
      if (retries === maxRetries) return `[错误] 后端调度失败: ${e.message}`;
    }
  }
};

// --- 流水线传送带动画 ---
const pipelineCSS = `
@keyframes pl-glow{0%,100%{box-shadow:0 0 8px 2px rgba(99,102,241,.3)}50%{box-shadow:0 0 20px 6px rgba(99,102,241,.7)}}
@keyframes pl-gear{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes pl-packet{0%{left:0;opacity:0}10%{opacity:1}90%{opacity:1}100%{left:100%;opacity:0}}
@keyframes pl-done-glow{0%{opacity:0;filter:brightness(1)}30%{opacity:1;filter:brightness(1.4)}100%{opacity:1;filter:brightness(1)}}
@keyframes pl-bulb-pop{0%{transform:scale(0) rotate(-20deg);opacity:0}50%{transform:scale(1.25) rotate(5deg);opacity:1}70%{transform:scale(0.95) rotate(-2deg)}100%{transform:scale(1) rotate(0);opacity:1}}
@keyframes pl-rays{0%{transform:scale(0);opacity:.6}100%{transform:scale(2.5);opacity:0}}
@keyframes pl-fadein{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}
.pl-node-active{animation:pl-glow 1.5s ease-in-out infinite}
.pl-gear{animation:pl-gear 2s linear infinite}
.pl-packet{position:absolute;top:50%;transform:translateY(-50%);animation:pl-packet 1.8s ease-in-out infinite}
.pl-done-glow{animation:pl-done-glow .8s ease-out forwards}
.pl-bulb-pop{animation:pl-bulb-pop .6s cubic-bezier(.34,1.56,.64,1) forwards}
.pl-rays{animation:pl-rays 1s ease-out forwards}
.pl-fadein{animation:pl-fadein .5s ease-out .3s both}
`;

const PipelineAnimation = ({ currentStep, configs, results, vendors, isComplete }) => {
  const steps = [
    { id: 'A', label: '生成者', desc: '生成初始答案' },
    { id: 'B', label: '校核者', desc: '事实与逻辑校核' },
    { id: 'C', label: '审核者', desc: '质量与风险审核' },
    { id: 'D', label: '终审者', desc: '终审并输出结果' },
  ];
  const stepIdx = steps.findIndex(s => s.id === currentStep);

  const getStatus = (i) => {
    if (isComplete) return 'done';
    if (i < stepIdx) return 'done';
    if (i === stepIdx) return 'active';
    return 'pending';
  };

  const getVendorModel = (roleId) => {
    const c = configs[roleId];
    if (!c) return { vName: '', mName: '' };
    const v = vendors.find(x => x.id === c.vendor);
    return { vName: v ? v.name : c.vendor, mName: c.model };
  };

  return (
    <div className="py-6">
      <style>{pipelineCSS}</style>

      {/* Completion celebration */}
      {isComplete && (
        <div className="flex flex-col items-center mb-6">
          <div className="relative">
            <div className="pl-rays absolute inset-0 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-amber-200 to-yellow-400 opacity-30" />
            </div>
            <div className="pl-bulb-pop text-5xl relative z-10">💡</div>
          </div>
          <div className="pl-fadein mt-3 text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-500 via-yellow-500 to-amber-600">
            决策完成
          </div>
        </div>
      )}

      {/* Conveyor belt */}
      <div className="flex items-center justify-center gap-0 px-4">
        {steps.map((step, i) => {
          const status = getStatus(i);
          const { vName, mName } = getVendorModel(step.id);
          return (
            <React.Fragment key={step.id}>
              {/* Node */}
              <div className="flex flex-col items-center" style={{ minWidth: 110 }}>
                <div
                  className={`relative w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-black border-2 transition-all duration-500 ${
                    status === 'done'
                      ? (isComplete ? 'bg-gradient-to-br from-amber-400 to-yellow-500 border-amber-400 text-white shadow-lg pl-done-glow' : 'bg-emerald-500 border-emerald-400 text-white shadow-md')
                      : status === 'active'
                      ? 'bg-indigo-600 border-indigo-400 text-white pl-node-active'
                      : 'bg-gray-100 border-gray-200 text-gray-400'
                  }`}
                >
                  {status === 'done' && !isComplete && (
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                  )}
                  {status === 'done' && isComplete && <span>{step.id}</span>}
                  {status === 'active' && (
                    <svg className="w-6 h-6 pl-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                  )}
                  {status === 'pending' && <span className="text-base">{step.id}</span>}
                </div>
                <div className={`mt-2 text-xs font-bold ${status === 'active' ? 'text-indigo-600' : status === 'done' ? (isComplete ? 'text-amber-600' : 'text-emerald-600') : 'text-gray-400'}`}>
                  {step.label}
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5 text-center leading-tight truncate max-w-[110px]">
                  {status === 'active' ? `${vName} · ${mName}` : step.desc}
                </div>
              </div>

              {/* Connector line with data packet */}
              {i < steps.length - 1 && (
                <div className="relative flex-1 mx-1" style={{ minWidth: 40, height: 4 }}>
                  <div className={`absolute inset-0 rounded-full transition-colors duration-500 ${
                    getStatus(i + 1) !== 'pending' || status === 'active'
                      ? (isComplete ? 'bg-gradient-to-r from-amber-400 to-yellow-400' : 'bg-indigo-200')
                      : 'bg-gray-200'
                  }`} />
                  {status === 'active' && (
                    <div className="pl-packet w-3 h-3 rounded-full bg-indigo-500 shadow-lg shadow-indigo-300" />
                  )}
                  {status === 'done' && getStatus(i + 1) === 'active' && (
                    <div className="pl-packet w-3 h-3 rounded-full bg-indigo-500 shadow-lg shadow-indigo-300" />
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Status text */}
      {!isComplete && currentStep && (
        <div className="text-center mt-5">
          <span className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 rounded-full text-sm text-indigo-700 font-bold">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            {(() => {
              const { vName, mName } = getVendorModel(currentStep);
              const s = steps.find(x => x.id === currentStep);
              return `${vName} (${mName}) 正在${s?.desc || '处理'}...`;
            })()}
          </span>
        </div>
      )}
    </div>
  );
};

const AuthScreen = ({ onLogin, onRegister, dbUsers, isTestMode }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAction = async () => {
    setError('');
    if (!username || !password) return setError('请输入账号和密码');
    setLoading(true);
    try {
      if (isRegister) {
        const newUser = {
          id: `usr_${Date.now().toString().slice(-4)}`,
          username, password, role: 'user', name: username, roleDetail: 'user',
          plan: isTestMode ? 'pro' : 'free',
          status: 'active', balance: 0.0
        };
        const res = await fetch(`${API_BASE_URL}/auth/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newUser)
        });
        const data = await res.json();
        if (!res.ok) return setError(data.error || '注册失败');
        window.sessionStorage.setItem('token', data.token);
        onRegister(data.user);
        onLogin(data.user);
      } else {
        const res = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) return setError(data.error || '登录失败');
        window.sessionStorage.setItem('token', data.token);
        onLogin(data.user);
      }
    } catch (e) {
      setError('无法连接后端服务，请确保后端已启动（端口 3000）');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="fixed inset-0 bg-gray-50 flex items-center justify-center z-50 p-4">
      <div className="max-w-md w-full bg-white border border-gray-200 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
        {isTestMode && (
          <div className="absolute top-0 left-0 w-full bg-amber-100 text-amber-700 text-xs font-bold text-center py-1.5 border-b border-amber-200 animate-pulse">
            🧪 测试运行阶段：新用户注册直享 Pro 套餐特权
          </div>
        )}
        <div className="text-center mb-8 mt-6">
          <div className="inline-block px-4 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-full text-xl font-black mb-2 shadow-md">⟳ ZDF.AI</div>
          <h2 className="text-2xl font-bold text-gray-800">{isRegister ? '注册平台账号' : '登录系统门户'}</h2>
          <p className="text-sm text-gray-500 mt-2">AI 多智能体决策操作系统 · 四模型协同 · 可审计输出</p>
          {isRegister && (
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="p-2 bg-indigo-50 rounded-xl"><p className="text-xs font-black text-indigo-600">20 次/日</p><p className="text-[9px] text-gray-400">免费额度</p></div>
              <div className="p-2 bg-indigo-50 rounded-xl"><p className="text-xs font-black text-indigo-600">多模型</p><p className="text-[9px] text-gray-400">DeepSeek/Qwen/GPT</p></div>
              <div className="p-2 bg-indigo-50 rounded-xl"><p className="text-xs font-black text-indigo-600">四级流水线</p><p className="text-[9px] text-gray-400">生成→校核→审核→终审</p></div>
            </div>
          )}
        </div>
        <div className="space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 text-xs font-bold rounded-xl border border-red-100">{error}</div>}
          <div className="relative">
            <User className="absolute left-3 top-3 text-gray-400" size={20} />
            <input type="text" placeholder="请输入账号" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:border-indigo-500 outline-none transition-colors" onKeyDown={(e) => e.key === 'Enter' && handleAction()} />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-3 text-gray-400" size={20} />
            <input type="password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:border-indigo-500 outline-none transition-colors" onKeyDown={(e) => e.key === 'Enter' && handleAction()} />
          </div>
          <button onClick={handleAction} disabled={loading} className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition-colors disabled:opacity-60">{loading ? '验证中...' : (isRegister ? '立即注册并进入' : '进入系统')}</button>
        </div>
        <div className="mt-6 pt-6 border-t border-gray-100 text-center text-sm text-gray-500">
          {isRegister ? '已有账户？' : '还没有账户？'} 
          <button onClick={() => { setIsRegister(!isRegister); setError(''); }} className="text-indigo-600 font-bold ml-1 hover:underline">{isRegister ? '返回登录' : '免费注册'}</button>
        </div>
      </div>
    </div>
  );
};

const AdminApp = ({ auth, onLogout, dbUsers, setDbUsers, isTestMode, setIsTestMode, adminKeys, setAdminKeys, alertsConfig, setAlertsConfig, dbLogs, setDbLogs, vendors, setVendors, strategy, setStrategy, onSwitchToUser, adminTemplates, setAdminTemplates }) => {
  const [subTab, setSubTab] = useState('overview');
  
  const [showSelfCheck, setShowSelfCheck] = useState(true);
  const [checkSteps, setCheckSteps] = useState([
    { id: 'db', name: '本地数据库连通性', status: 'pending', msg: '' },
    { id: 'api', name: '平台 API 连通性与余额', status: 'pending', msg: '' },
    { id: 'storage', name: '存储卷健康状态', status: 'pending', msg: '' }
  ]);
  const [checkPhase, setCheckPhase] = useState('running');
  const [alertSent, setAlertSent] = useState(false);
  const [editingVendor, setEditingVendor] = useState(null);
  const [editTpl, setEditTpl] = useState(null);
  const [newTpl, setNewTpl] = useState({ title: '', prompt: '', category: '通用', plan: 'free' });
  const [vendorForm, setVendorForm] = useState({ id: '', name: '', region: 'CN', models: '' });
  const [usageStats, setUsageStats] = useState(null);
  const [trendTab, setTrendTab] = useState('tasks');
  const [logFilter, setLogFilter] = useState('all'); // 'all' | 'alert' | 'warn' | 'info'

  const addLog = (type, operator, action, detail) => {
    setDbLogs(prev => [{
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toLocaleString(),
      type, operator, action, detail
    }, ...prev]);
  };

  const handleExportLogs = () => {
    const headers = "时间,级别,操作人,动作,详情\n";
    const rows = dbLogs.map(l => `"${l.timestamp}","${l.type}","${l.operator}","${l.action}","${l.detail.replace(/"/g, '""')}"`).join('\n');
    const blob = new Blob(["\uFEFF" + headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ZDF_System_Logs_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
    addLog('info', auth.username, '导出日志', '管理员导出了全量运行日志');
  };

  useEffect(() => {
    let isMounted = true;
    const runCheck = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/admin/health-check`, {
          headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` }
        });
        if (!isMounted) return;
        if (res.ok) {
          const data = await res.json();
          (data.results || []).forEach(r => {
            setCheckSteps(prev => prev.map(s => s.id === r.id ? { ...s, status: r.status, msg: r.msg } : s));
          });
        } else {
          // 后端不可达时 fallback 到客户端检测
          setCheckSteps(prev => prev.map(s => s.id === 'db' ? { ...s, status: 'error', msg: '后端服务不可达' } : s));
          const hasValidKey = Object.values(adminKeys).some(k => k.status === 'success' && k.value.length > 5);
          setCheckSteps(prev => prev.map(s => s.id === 'api' ? { ...s, status: hasValidKey ? 'ok' : 'error', msg: hasValidKey ? '本地 Key 配置存在' : '未检测到有效 API Key' } : s));
          setCheckSteps(prev => prev.map(s => s.id === 'storage' ? { ...s, status: 'warn', msg: '无法检测（后端离线）' } : s));
        }
      } catch {
        if (!isMounted) return;
        setCheckSteps(prev => prev.map(s => ({ ...s, status: 'error', msg: '后端服务不可达' })));
      }
      if (isMounted) setCheckPhase('done');
    };
    runCheck();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (checkPhase === 'done') {
      const hasError = checkSteps.some(s => s.status === 'error');
      if (hasError) {
        const errorDetails = checkSteps.filter(s => s.status === 'error' || s.status === 'warn').map(s => `${s.name}: ${s.msg}`).join('\n');
        // 尝试通过后端发送 Webhook 告警
        fetch(`${API_BASE_URL}/admin/send-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
          body: JSON.stringify({ title: '系统自检异常告警', content: errorDetails }),
        }).then(r => r.json()).then(data => {
          const channels = (data.results || []).map(r => `${r.channel}(${r.ok ? 'OK' : 'FAIL'})`).join(', ');
          setAlertSent(true);
          addLog('alert', 'System', '自检异常告警', `${errorDetails}。Webhook: ${channels || '未配置'}`);
        }).catch(() => {
          setAlertSent(true);
          addLog('alert', 'System', '自检异常告警', `${errorDetails}。Webhook 发送失败`);
        });
      } else {
        setTimeout(() => setShowSelfCheck(false), 1500);
      }
    }
  }, [checkPhase, checkSteps]);

  // 获取实时使用统计
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/admin/usage-stats`, {
          headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` }
        });
        if (res.ok) setUsageStats(await res.json());
      } catch { /* ignore */ }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // 每 30 秒刷新
    return () => clearInterval(interval);
  }, []);

  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', roleDetail: 'operator' });
  const handleAddAdmin = () => {
    if (!newAdmin.username || !newAdmin.password) return alert("请填写账号密码");
    if (dbUsers.find(u => u.username === newAdmin.username)) return alert("账号已存在");
    setDbUsers(prev => [...prev, {
      id: `adm_${Date.now().toString().slice(-4)}`,
      username: newAdmin.username, password: newAdmin.password, 
      role: 'admin', name: newAdmin.username, roleDetail: newAdmin.roleDetail,
      plan: 'max', status: 'active', balance: 0.0
    }]);
    addLog('info', auth.username, '新增管理员', `创建了管理员账号 ${newAdmin.username} (${newAdmin.roleDetail})`);
    setNewAdmin({ username: '', password: '', roleDetail: 'operator' });
    alert("管理员账号创建成功！");
  };

  const toggleUserPlan = (userId) => {
    setDbUsers(prev => prev.map(u => {
      if (u.id === userId) {
        const next = u.plan === 'free' ? 'pro' : u.plan === 'pro' ? 'enterprise' : 'free';
        addLog('info', auth.username, '修改套餐', `将用户 ${u.username} 套餐修改为 ${next}`);
        return { ...u, plan: next };
      }
      return u;
    }));
  };

  const toggleUserStatus = (userId) => {
    setDbUsers(prev => prev.map(u => {
      if (u.id === userId && u.role !== 'admin') {
        const next = u.status === 'active' ? 'suspended' : 'active';
        addLog('warn', auth.username, '账号状态变更', `将用户 ${u.username} 状态变更为 ${next}`);
        return { ...u, status: next };
      }
      return u;
    }));
  };

  const handleKeyChange = (vendorId, value) => {
    setAdminKeys(prev => ({ ...prev, [vendorId]: { value, status: 'idle', msg: '' } }));
  };

  /**
   * 通过后端真实探测各厂商 Key（OpenAI 兼容 / Anthropic / Google 等）。
   * @param {string} vendorId
   */
  const handleTestKey = async (vendorId) => {
    const keyVal = adminKeys[vendorId]?.value || '';
    if (!keyVal.trim()) {
      return setAdminKeys((prev) => ({
        ...prev,
        [vendorId]: { ...prev[vendorId], status: 'error', msg: 'Key 不能为空' },
      }));
    }
    setAdminKeys((prev) => ({
      ...prev,
      [vendorId]: { ...prev[vendorId], status: 'testing', msg: '测试中...' },
    }));
    try {
      const res = await fetch(`${API_BASE_URL}/admin/test-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ vendorId, key: keyVal }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setAdminKeys((prev) => ({
          ...prev,
          [vendorId]: { ...prev[vendorId], status: 'success', msg: '测试通过' },
        }));
        addLog('info', auth.username, 'API 测试成功', `供应商 ${vendorId} Key 校验通过`);
      } else {
        const msg = (data.msg || '测试失败').slice(0, 120);
        setAdminKeys((prev) => ({
          ...prev,
          [vendorId]: { ...prev[vendorId], status: 'error', msg },
        }));
        addLog('warn', auth.username, 'API 测试失败', `供应商 ${vendorId}: ${msg}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setAdminKeys((prev) => ({
        ...prev,
        [vendorId]: { ...prev[vendorId], status: 'error', msg: '网络或服务不可用' },
      }));
      addLog('warn', auth.username, 'API 测试失败', err);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 text-gray-900 font-sans">
      {showSelfCheck && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[100] flex items-center justify-center">
          <div className="bg-white rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="p-6 bg-indigo-600 text-white flex items-center gap-3">
              <Server size={24} />
              <h2 className="text-xl font-bold">后台系统自检程序</h2>
            </div>
            <div className="p-8 space-y-6">
              {checkSteps.map(step => (
                <div key={step.id} className="flex items-start gap-4">
                  <div className="mt-1">
                    {step.status === 'pending' && <div className="w-5 h-5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"/>}
                    {step.status === 'ok' && <CheckCircle2 className="text-green-500" size={20} />}
                    {step.status === 'warn' && <AlertTriangle className="text-amber-500" size={20} />}
                    {step.status === 'error' && <AlertTriangle className="text-red-500" size={20} />}
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-800">{step.name}</h4>
                    <p className={`text-xs mt-1 ${step.status === 'error' ? 'text-red-500 font-medium' : step.status === 'warn' ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{step.msg || '正在校验中...'}</p>
                  </div>
                </div>
              ))}
              
              {checkPhase === 'done' && checkSteps.some(s => s.status === 'error') && (
                <div className="p-4 bg-red-50 rounded-xl border border-red-100 mt-4">
                  <p className="text-sm font-bold text-red-700 flex items-center gap-2 mb-2"><BellRing size={16} /> 触发管理员告警机制</p>
                  <div className="text-xs text-red-600 space-y-1">
                    <p>检测到核心配置异常，正在执行通知回调...</p>
                    {alertSent ? <p className="text-green-600 font-bold mt-2">✅ 告警已成功投递，详细记录已写入系统日志。</p> : <p className="text-gray-500 animate-pulse">正在调用通信接口...</p>}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end">
              <button onClick={() => setShowSelfCheck(false)} disabled={checkPhase !== 'done' || (!alertSent && checkSteps.some(s => s.status === 'error'))} className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-bold disabled:opacity-50">进入管理后台</button>
            </div>
          </div>
        </div>
      )}

      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col z-10 shadow-xl">
        <div className="h-16 flex items-center px-6 gap-3 bg-slate-950 border-b border-slate-800">
          <ShieldCheck className="text-indigo-500" size={24} />
          <span className="text-lg font-black text-white tracking-wider">ADMIN PORTAL</span>
        </div>
        <nav className="flex-1 py-6 px-4 space-y-2 overflow-y-auto">
          {[{id:'overview', icon: Activity, label: '数据看板', perm: 'admin.overview'},
            {id:'users', icon: Users, label: '用户管线', perm: 'admin.users'},
            {id:'apikeys', icon: Key, label: '系统接口配置', perm: 'admin.keys'},
            {id:'vendors', icon: Server, label: '厂商与模型管理', perm: 'admin.models'},
            {id:'admins', icon: UserCog, label: '管理员与权限', perm: 'admin.revoke'},
            {id:'logs', icon: ClipboardList, label: '运行与告警日志', perm: 'admin.logs'},
            {id:'settings', icon: Sliders, label: '全局与告警设置', perm: 'admin.settings'},
            {id:'templates', icon: BookOpen, label: 'Prompt 模板', perm: 'admin.settings'},
            {id:'upgrades', icon: Crown, label: '升级审批', perm: 'admin.users'},
            {id:'orders', icon: CreditCard, label: '订单管理', perm: 'admin.users'},
            {id:'workflow', icon: GitBranch, label: '工作流编排', perm: 'admin.settings'},
            {id:'sla', icon: Shield, label: 'SLA 保障', perm: 'admin.settings'},
            {id:'deploy', icon: Cloud, label: '私有化部署', perm: 'admin.settings'}
          ].filter(item => !item.perm || (auth.permissions || []).includes(item.perm)).map(item => (
            <button key={item.id} onClick={() => setSubTab(item.id)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${subTab === item.id ? 'bg-indigo-600 text-white shadow-lg' : 'hover:bg-slate-800'}`}>
              <item.icon size={18} /> <span className="font-bold text-sm">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-800">
          <button 
            onClick={onSwitchToUser} 
            className="w-full flex items-center justify-center gap-2 py-3 mb-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors shadow-md"
            title="回到前端用户界面"
          >
            <ArrowLeftRight size={16} /> 切换至用户工作台
          </button>
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-800 rounded-xl mb-3 mt-4">
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center font-bold text-white uppercase">{auth.name[0]}</div>
            <div className="flex-1 overflow-hidden">
              <div className="text-xs font-bold text-white truncate">{auth.name}</div>
              <div className="text-[10px] text-slate-400">{auth.roleDetail === 'super' ? 'Super Admin' : 'Operator'}</div>
            </div>
          </div>
          <button onClick={onLogout} className="w-full flex items-center justify-center gap-2 py-2 text-sm text-red-400 hover:bg-slate-800 rounded-lg transition-colors"><LogOut size={16} /> 彻底退出登录</button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-16 px-8 flex items-center justify-between border-b border-gray-200 bg-white shadow-sm z-10 sticky top-0">
          <h2 className="text-xl font-bold text-gray-800">
            {subTab === 'overview' && '数据中心'}
            {subTab === 'users' && '用户与订阅管理'}
            {subTab === 'apikeys' && '平台多模型接口配置'}
            {subTab === 'vendors' && '厂商与模型管理'}
            {subTab === 'admins' && '管理员人员配置'}
            {subTab === 'logs' && '系统运行审计日志'}
            {subTab === 'settings' && '全局控制与告警'}
            {subTab === 'templates' && 'Prompt 模板管理'}
            {subTab === 'upgrades' && '套餐升级审批'}
            {subTab === 'orders' && '订单与支付管理'}
            {subTab === 'workflow' && '工作流编排引擎'}
            {subTab === 'sla' && 'SLA 服务等级协议'}
            {subTab === 'deploy' && '私有化部署管理'}
          </h2>
          <div className="flex items-center gap-4 text-xs font-medium">
            <span className="flex items-center gap-1"><MonitorDot className="text-green-500" size={14}/> DB在线</span>
            <span className="px-2 py-1 bg-gray-100 rounded text-gray-600 border border-gray-200">{new Date().toLocaleDateString()}</span>
          </div>
        </header>

        <div className="p-8 pb-32">
          {subTab === 'overview' && (
            <div className="space-y-6">
              {/* 顶部统计卡片 */}
              <div className="grid grid-cols-4 gap-6">
                {[
                  { label: '总注册量', v: dbUsers.length, c: 'text-blue-600', bg: 'bg-blue-100' },
                  { label: '今日调用量', v: usageStats?.today?.totalTasks ?? 0, c: 'text-indigo-600', bg: 'bg-indigo-100' },
                  { label: '今日 Token', v: ((usageStats?.today?.totalTokensIn || 0) + (usageStats?.today?.totalTokensOut || 0)).toLocaleString(), c: 'text-emerald-600', bg: 'bg-emerald-100' },
                  { label: '今日成本 (USD)', v: `$${(usageStats?.today?.totalCost || 0).toFixed(4)}`, c: checkSteps.some(s=>s.status==='error')?'text-red-600':'text-green-600', bg: checkSteps.some(s=>s.status==='error')?'bg-red-100':'bg-green-100' }
                ].map((st, i) => (
                  <div key={i} className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${st.bg} ${st.c}`}><Database size={20} /></div>
                    <div><p className="text-xs text-gray-500 mb-1">{st.label}</p><p className="text-2xl font-black">{st.v}</p></div>
                  </div>
                ))}
              </div>

              {/* 7 日趋势图 (SVG 折线 + 面积图，支持 调用量/Token/成本 切换) */}
              {usageStats?.trend && (() => {
                const trend = usageStats.trend;
                const trendViews = {
                  tasks:  { label: '调用量',      getData: d => d.tasks, format: v => `${v}`, unit: '次' },
                  tokens: { label: 'Token 用量',  getData: d => (d.tokensIn || 0) + (d.tokensOut || 0), format: v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : `${v}`, unit: '' },
                  cost:   { label: '成本 (USD)',   getData: d => d.cost,  format: v => `$${v.toFixed(3)}`, unit: '' },
                };
                const view = trendViews[trendTab] || trendViews.tasks;
                const maxVal = Math.max(1, ...trend.map(d => view.getData(d)));
                const lineColor = trendTab === 'tasks' ? '#6366f1' : trendTab === 'tokens' ? '#10b981' : '#f59e0b';
                const W = 700, H = 150, PAD_TOP = 20, PAD_BOT = 24, CHART_H = H - PAD_TOP - PAD_BOT;
                const getX = i => trend.length > 1 ? 40 + i * ((W - 80) / (trend.length - 1)) : W / 2;
                const getY = d => PAD_TOP + CHART_H - (view.getData(d) / maxVal) * CHART_H;
                const linePts = trend.map((d, i) => `${getX(i)},${getY(d)}`).join(' ');
                const areaPts = `${getX(0)},${PAD_TOP + CHART_H} ${linePts} ${getX(trend.length - 1)},${PAD_TOP + CHART_H}`;
                return (
                  <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Activity size={16} className="text-indigo-500"/> 最近 7 天趋势</h3>
                      <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                        {Object.entries(trendViews).map(([key, v]) => (
                          <button key={key} onClick={() => setTrendTab(key)}
                            className={`px-3 py-1 text-[10px] font-bold rounded-lg transition-all ${trendTab === key ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
                            {v.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
                      <defs>
                        <linearGradient id={`areaGrad-${trendTab}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25"/>
                          <stop offset="100%" stopColor={lineColor} stopOpacity="0.02"/>
                        </linearGradient>
                      </defs>
                      {[0, 0.25, 0.5, 0.75, 1].map(p => {
                        const yVal = maxVal * p;
                        const label = trendTab === 'cost' ? `$${yVal.toFixed(yVal < 0.1 ? 3 : 2)}` : yVal >= 1000 ? `${(yVal/1000).toFixed(1)}k` : Math.round(yVal);
                        return (
                          <g key={p}>
                            <line x1="40" y1={PAD_TOP + CHART_H * (1 - p)} x2={W - 40} y2={PAD_TOP + CHART_H * (1 - p)} stroke="#f3f4f6" strokeWidth="1"/>
                            <text x="36" y={PAD_TOP + CHART_H * (1 - p) + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{label}</text>
                          </g>
                        );
                      })}
                      <polygon points={areaPts} fill={`url(#areaGrad-${trendTab})`}/>
                      <polyline points={linePts} fill="none" stroke={lineColor} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
                      {trend.map((d, i) => (
                        <g key={d.date}>
                          <circle cx={getX(i)} cy={getY(d)} r="4" fill="white" stroke={lineColor} strokeWidth="2"/>
                          <text x={getX(i)} y={getY(d) - 10} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#374151">{view.format(view.getData(d))}</text>
                          <text x={getX(i)} y={H - 2} textAnchor="middle" fontSize="9" fill="#9ca3af">{d.date.slice(5)}</text>
                        </g>
                      ))}
                    </svg>
                    {trendTab === 'tokens' && (
                      <div className="flex gap-6 mt-2 text-xs">
                        <span className="text-gray-500">7 日输入: <b className="text-emerald-600">{trend.reduce((s, d) => s + (d.tokensIn || 0), 0).toLocaleString()}</b></span>
                        <span className="text-gray-500">7 日输出: <b className="text-blue-600">{trend.reduce((s, d) => s + (d.tokensOut || 0), 0).toLocaleString()}</b></span>
                      </div>
                    )}
                    {trendTab === 'cost' && (
                      <div className="flex gap-6 mt-2 text-xs">
                        <span className="text-gray-500">7 日总成本: <b className="text-amber-600">${trend.reduce((s, d) => s + (d.cost || 0), 0).toFixed(4)}</b></span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 用户排行 + 超额预警 */}
              <div className="grid grid-cols-2 gap-6">
                {usageStats?.ranking && (
                  <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                    <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><Users size={16} className="text-indigo-500"/> 今日用量排行 <span className="text-[10px] text-gray-400 font-normal">Top 20</span></h3>
                    {usageStats.ranking.length === 0 ? <p className="text-xs text-gray-400">暂无用户使用记录</p> : (
                      <div className="overflow-hidden">
                        <div className="grid grid-cols-[28px_1fr_52px_64px_72px_64px] gap-1 text-[10px] font-bold text-gray-400 uppercase mb-2 px-1">
                          <span>#</span><span>用户</span><span>套餐</span><span className="text-right">调用</span><span className="text-right">Token</span><span className="text-right">成本</span>
                        </div>
                        <div className="space-y-1 max-h-80 overflow-y-auto">
                          {usageStats.ranking.slice(0, 20).map((u, i) => (
                            <div key={u.userId} className="grid grid-cols-[28px_1fr_52px_64px_72px_64px] gap-1 items-center text-xs py-1.5 px-1 rounded-lg hover:bg-gray-50">
                              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${i < 3 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{i+1}</span>
                              <span className="font-medium text-gray-700 truncate">{u.username}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold text-center ${u.plan === 'pro' ? 'bg-blue-50 text-blue-600' : u.plan === 'enterprise' ? 'bg-amber-50 text-amber-600' : 'bg-gray-50 text-gray-500'}`}>{u.plan}</span>
                              <span className="text-right font-bold text-indigo-600">{u.tasks}</span>
                              <span className="text-right text-gray-500">{((u.tokensIn || 0) + (u.tokensOut || 0)) >= 1000 ? `${(((u.tokensIn || 0) + (u.tokensOut || 0)) / 1000).toFixed(1)}k` : (u.tokensIn || 0) + (u.tokensOut || 0)}</span>
                              <span className="text-right font-bold text-emerald-600">${(u.cost || 0).toFixed(3)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 超额预警 */}
                <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                  <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><AlertTriangle size={16} className="text-amber-500"/> 超额预警</h3>
                  <div className="space-y-2">
                    {(() => {
                      const warnings = dbUsers.filter(u => u.role !== 'admin').map(u => {
                        const ud = usageStats?.ranking?.find(r => r.userId === u.id);
                        const limit = u.plan === 'free' ? 20 : u.plan === 'pro' ? 500 : -1;
                        if (limit > 0 && ud && ud.tasks >= limit * 0.8) {
                          return { ...u, tasks: ud.tasks, limit, pct: Math.round(ud.tasks / limit * 100) };
                        }
                        return null;
                      }).filter(Boolean);
                      if (warnings.length === 0) return <p className="text-xs text-gray-400">所有用户用量正常</p>;
                      return warnings.map(w => (
                        <div key={w.id} className={`p-3 rounded-xl border text-xs ${w.pct >= 100 ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-gray-700">{w.username}</span>
                            <span className={`font-bold ${w.pct >= 100 ? 'text-red-600' : 'text-amber-600'}`}>{w.pct}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-gray-200 rounded-full">
                            <div className={`h-full rounded-full ${w.pct >= 100 ? 'bg-red-500' : 'bg-amber-500'}`} style={{width: `${Math.min(100, w.pct)}%`}}/>
                          </div>
                          <span className="text-gray-500 mt-1 block">{w.tasks}/{w.limit} 次（{w.plan.toUpperCase()}）</span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>

              {/* 模型成本分布 (环形图 + 条形图) */}
              {usageStats?.modelBreakdown && usageStats.modelBreakdown.length > 0 && (() => {
                const data = usageStats.modelBreakdown;
                const total = data.reduce((s, d) => s + d.cost, 0);
                const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6'];
                return (
                  <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                    <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><PieChart size={16} className="text-indigo-500"/> 今日模型成本分布</h3>
                    <div className="flex gap-6">
                      {/* 环形图 */}
                      <div className="flex-shrink-0 flex items-center justify-center">
                        <svg width="150" height="150" viewBox="0 0 150 150">
                          {(() => {
                            if (total === 0) return <text x="75" y="78" textAnchor="middle" fontSize="11" fill="#9ca3af">暂无数据</text>;
                            const cx = 75, cy = 75, r = 58, inner = 36;
                            let cum = -Math.PI / 2;
                            return <>
                              {data.map((d, i) => {
                                const angle = Math.max(0.02, (d.cost / total) * Math.PI * 2);
                                const sa = cum; cum += angle;
                                const x1 = cx + r * Math.cos(sa), y1 = cy + r * Math.sin(sa);
                                const x2 = cx + r * Math.cos(sa + angle), y2 = cy + r * Math.sin(sa + angle);
                                const ix1 = cx + inner * Math.cos(sa + angle), iy1 = cy + inner * Math.sin(sa + angle);
                                const ix2 = cx + inner * Math.cos(sa), iy2 = cy + inner * Math.sin(sa);
                                const lg = angle > Math.PI ? 1 : 0;
                                return <path key={i} d={`M${x1},${y1} A${r},${r} 0 ${lg},1 ${x2},${y2} L${ix1},${iy1} A${inner},${inner} 0 ${lg},0 ${ix2},${iy2} Z`} fill={COLORS[i % COLORS.length]} opacity={0.85}/>;
                              })}
                              <text x={cx} y={cy - 4} textAnchor="middle" fontSize="13" fontWeight="bold" fill="#374151">${total.toFixed(2)}</text>
                              <text x={cx} y={cy + 11} textAnchor="middle" fontSize="9" fill="#9ca3af">总成本</text>
                            </>;
                          })()}
                        </svg>
                      </div>
                      {/* 图例 + 条形图 */}
                      <div className="flex-1 space-y-2 min-w-0">
                        {data.map((m, i) => {
                          const pct = total > 0 ? (m.cost / total * 100).toFixed(1) : '0';
                          return (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{backgroundColor: COLORS[i % COLORS.length]}}/>
                              <span className="w-28 font-medium text-gray-700 truncate">{m.vendor}/{m.model}</span>
                              <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                                <div className="h-full rounded-full" style={{width: `${Math.max(2, pct)}%`, backgroundColor: COLORS[i % COLORS.length]}}/>
                              </div>
                              <span className="text-gray-400 w-12 text-right">{m.calls} 次</span>
                              <span className="text-gray-400 w-10 text-right">{pct}%</span>
                              <span className="font-bold text-indigo-600 w-16 text-right">${m.cost.toFixed(4)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* 盈利分析面板 */}
              {usageStats?.revenue && (
                <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                  <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><DollarSign size={16} className="text-green-500"/> 盈利分析（本月）</h3>
                  <div className="grid grid-cols-4 gap-4 mb-6">
                    {[
                      { label: '预估月收入', value: `$${usageStats.revenue.estimatedMonthly}`, bg: 'bg-green-50', color: 'text-green-600', Icon: TrendingUp },
                      { label: '本月 API 成本', value: `$${usageStats.revenue.monthlyCost.toFixed(2)}`, bg: 'bg-red-50', color: 'text-red-500', Icon: Database },
                      { label: '预估利润', value: `$${usageStats.revenue.monthlyProfit}`, bg: usageStats.revenue.monthlyProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50', color: usageStats.revenue.monthlyProfit >= 0 ? 'text-emerald-600' : 'text-red-600', Icon: DollarSign },
                      { label: '利润率', value: `${usageStats.revenue.margin.toFixed(1)}%`, bg: 'bg-indigo-50', color: 'text-indigo-600', Icon: PieChart },
                    ].map((card, i) => (
                      <div key={i} className={`${card.bg} rounded-2xl p-4`}>
                        <div className="flex items-center gap-2 mb-2">
                          <card.Icon size={14} className={card.color}/>
                          <span className="text-[10px] font-bold text-gray-500 uppercase">{card.label}</span>
                        </div>
                        <p className={`text-xl font-black ${card.color}`}>{card.value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    {/* 用户构成 */}
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 mb-3 uppercase">用户构成</h4>
                      <div className="space-y-2">
                        {Object.entries(usageStats.revenue.planCounts).map(([plan, count]) => {
                          const tot = Object.values(usageStats.revenue.planCounts).reduce((s, v) => s + v, 0);
                          const pct = tot > 0 ? (count / tot * 100).toFixed(0) : '0';
                          const clr = { free: '#9ca3af', pro: '#6366f1', enterprise: '#f59e0b' }[plan] || '#ccc';
                          return (
                            <div key={plan} className="flex items-center gap-2 text-sm">
                              <div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: clr}}/>
                              <span className="text-xs font-medium text-gray-700 w-20 uppercase">{plan}</span>
                              <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                                <div className="h-full rounded-full" style={{width: `${pct}%`, backgroundColor: clr}}/>
                              </div>
                              <span className="text-xs font-bold text-gray-600 w-12 text-right">{count} 人</span>
                              <span className="text-[10px] text-gray-400 w-8 text-right">{pct}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* 收入来源 */}
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 mb-3 uppercase">收入来源</h4>
                      <div className="space-y-2">
                        {Object.entries(usageStats.revenue.breakdown).filter(([, v]) => v > 0).length === 0
                          ? <p className="text-xs text-gray-400">暂无付费用户</p>
                          : Object.entries(usageStats.revenue.breakdown).filter(([, v]) => v > 0).map(([plan, amount]) => {
                            const tot = usageStats.revenue.estimatedMonthly;
                            const pct = tot > 0 ? (amount / tot * 100).toFixed(0) : '0';
                            const clr = { free: '#9ca3af', pro: '#6366f1', enterprise: '#f59e0b' }[plan] || '#ccc';
                            return (
                              <div key={plan} className="flex items-center gap-2 text-sm">
                                <div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: clr}}/>
                                <span className="text-xs font-medium text-gray-700 w-20 uppercase">{plan}</span>
                                <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                                  <div className="h-full rounded-full" style={{width: `${pct}%`, backgroundColor: clr}}/>
                                </div>
                                <span className="text-xs font-bold text-gray-600 w-14 text-right">${amount}</span>
                                <span className="text-[10px] text-gray-400 w-8 text-right">{pct}%</span>
                              </div>
                            );
                          })
                        }
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-6 text-xs text-gray-500">
                    <span>本月调用: <b className="text-gray-700">{(usageStats.revenue.monthlyTasks || 0).toLocaleString()}</b> 次</span>
                    <span>本月 Token: <b className="text-gray-700">{((usageStats.revenue.monthlyTokensIn || 0) + (usageStats.revenue.monthlyTokensOut || 0)).toLocaleString()}</b></span>
                    <span>付费用户: <b className="text-indigo-600">{(usageStats.revenue.planCounts?.pro || 0) + (usageStats.revenue.planCounts?.enterprise || 0)}</b> 人</span>
                  </div>
                </div>
              )}

              {/* 并发监控 */}
              <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><Zap size={16} className="text-amber-500"/> 实时并发监控</h3>
                {(() => {
                  const concurrent = usageStats?.concurrency;
                  const activeUsers = concurrent?.active ? Object.entries(concurrent.active) : [];
                  const totalActive = concurrent?.queueLength || 0;
                  return (
                    <div>
                      <div className="flex items-center gap-4 mb-4">
                        <div className="px-4 py-2 bg-indigo-50 rounded-xl">
                          <span className="text-xs text-gray-500">活跃请求</span>
                          <p className="text-xl font-black text-indigo-600">{totalActive}</p>
                        </div>
                        <div className="px-4 py-2 bg-gray-50 rounded-xl">
                          <span className="text-xs text-gray-500">活跃用户</span>
                          <p className="text-xl font-black text-gray-700">{activeUsers.length}</p>
                        </div>
                      </div>
                      {activeUsers.length > 0 ? (
                        <div className="space-y-2">
                          {activeUsers.map(([uid, count]) => {
                            const u = dbUsers.find(u => u.id === uid);
                            return (
                              <div key={uid} className="flex items-center gap-2 text-sm p-2 bg-gray-50 rounded-xl">
                                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                                <span className="font-medium text-gray-700">{u?.username || uid}</span>
                                <span className="text-xs text-gray-400">({u?.plan || 'free'})</span>
                                <span className="ml-auto text-xs font-bold text-indigo-600">{count} 个并发请求</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : <p className="text-xs text-gray-400">当前无活跃请求</p>}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {subTab === 'users' && (
            <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                  <tr><th className="px-6 py-4">账号</th><th className="px-6 py-4">角色</th><th className="px-6 py-4">套餐额度</th><th className="px-6 py-4">状态</th><th className="px-6 py-4">操作</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {dbUsers.filter(u => u.role !== 'admin').map(u => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-bold">{u.username}</td>
                      <td className="px-6 py-4 text-xs font-mono text-gray-500">普通用户</td>
                      <td className="px-6 py-4"><span className={`px-2 py-1 rounded text-xs font-bold border ${u.plan==='max'?'bg-amber-50 text-amber-600 border-amber-200':u.plan==='pro'?'bg-blue-50 text-blue-600 border-blue-200':'bg-gray-50 text-gray-600 border-gray-200'}`}>{u.plan.toUpperCase()}</span></td>
                      <td className="px-6 py-4"><span className={`flex items-center gap-1.5 text-xs font-bold ${u.status==='active'?'text-green-600':'text-red-500'}`}><div className={`w-1.5 h-1.5 rounded-full ${u.status==='active'?'bg-green-600':'bg-red-500'}`}></div>{u.status==='active'?'正常':'已封禁'}</span></td>
                      <td className="px-6 py-4 flex gap-3">
                        <button className="text-xs font-bold text-indigo-600 hover:underline disabled:opacity-30" onClick={() => toggleUserPlan(u.id)}>变配</button>
                        <button className={`text-xs font-bold ${u.status==='active'?'text-red-500':'text-green-600'} hover:underline disabled:opacity-30`} onClick={() => toggleUserStatus(u.id)}>{u.status==='active'?'封禁':'解封'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {subTab === 'admins' && (
            <div className="space-y-6 max-w-5xl">
              <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm flex items-start gap-6">
                <div className="flex-1 space-y-4">
                  <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><Plus size={18} className="text-indigo-600"/> 创建后台管理人员</h3>
                  <div className="flex gap-4">
                    <input type="text" placeholder="登录账号" className="px-4 py-2 border border-gray-200 rounded-xl outline-none focus:border-indigo-500 flex-1 text-sm" value={newAdmin.username} onChange={e=>setNewAdmin({...newAdmin, username: e.target.value})} />
                    <input type="password" placeholder="初始密码" className="px-4 py-2 border border-gray-200 rounded-xl outline-none focus:border-indigo-500 flex-1 text-sm" value={newAdmin.password} onChange={e=>setNewAdmin({...newAdmin, password: e.target.value})} />
                    <select className="px-4 py-2 border border-gray-200 rounded-xl outline-none focus:border-indigo-500 text-sm bg-white" value={newAdmin.roleDetail} onChange={e=>setNewAdmin({...newAdmin, roleDetail: e.target.value})}>
                      <option value="super">超级管理员 (所有权限)</option>
                      <option value="operator">平台运营 (仅查看和管理用户)</option>
                    </select>
                    <button onClick={handleAddAdmin} className="px-6 py-2 bg-indigo-600 text-white font-bold text-sm rounded-xl hover:bg-indigo-700 shadow-sm transition-colors">添加账号</button>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                    <tr><th className="px-6 py-4">管理账号</th><th className="px-6 py-4">权限级别</th><th className="px-6 py-4">状态</th><th className="px-6 py-4">操作</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {dbUsers.filter(u => u.role === 'admin').map(u => (
                      <tr key={u.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 font-bold">{u.username} {u.username === auth.username && <span className="ml-2 px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] rounded-full">当前</span>}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded text-xs font-bold border ${u.roleDetail==='super'?'bg-amber-50 text-amber-600 border-amber-200':'bg-blue-50 text-blue-600 border-blue-200'}`}>
                            {u.roleDetail === 'super' ? '超级管理员' : '平台运营'}
                          </span>
                        </td>
                        <td className="px-6 py-4"><span className="text-green-600 font-bold text-xs flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-green-600"></div>正常</span></td>
                        <td className="px-6 py-4">
                          <button
                            className={`text-xs font-bold hover:underline ${u.username === auth.username ? 'text-gray-300 cursor-not-allowed' : 'text-red-500'}`}
                            disabled={u.username === auth.username}
                            title={u.username === auth.username ? '不能撤销自己的权限' : '将该管理员降级为普通用户'}
                            onClick={() => {
                              if (!confirm(`确定撤销「${u.username}」的管理员权限？该账号将变为普通用户。`)) return;
                              setDbUsers(prev => prev.map(x => x.id === u.id ? { ...x, role: 'user', roleDetail: 'user', plan: 'free' } : x));
                              addLog('warn', auth.username, '撤销管理员', `撤销了 ${u.username} 的管理员权限`);
                            }}
                          >撤销权限</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {subTab === 'logs' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-gray-200 shadow-sm">
                <div className="flex gap-2 text-sm">
                  {[{k:'all',l:'全部日志'},{k:'alert',l:'告警'},{k:'warn',l:'警告'},{k:'info',l:'操作'}].map(f => (
                    <button key={f.k} onClick={() => setLogFilter(f.k)} className={`px-3 py-1.5 rounded-lg font-bold border transition-colors ${logFilter === f.k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'}`}>{f.l}</button>
                  ))}
                </div>
                <button onClick={handleExportLogs} className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 font-bold text-sm rounded-lg hover:bg-indigo-100 transition-colors">
                  <Download size={16} /> 导出日志 (CSV)
                </button>
              </div>

              <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                    <tr><th className="px-6 py-4">发生时间</th><th className="px-6 py-4">级别</th><th className="px-6 py-4">操作者</th><th className="px-6 py-4">动作</th><th className="px-6 py-4">详细信息</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(() => { const filtered = logFilter === 'all' ? dbLogs : dbLogs.filter(l => l.type === logFilter); return filtered.length === 0 ? (
                      <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-400">暂无{logFilter === 'all' ? '任何' : logFilter}系统日志</td></tr>
                    ) : (
                      filtered.map(l => (
                        <tr key={l.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 text-xs font-mono text-gray-500">{l.timestamp}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${l.type==='alert'?'bg-red-100 text-red-700':l.type==='warn'?'bg-amber-100 text-amber-700':'bg-gray-100 text-gray-600'}`}>
                              {l.type}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-xs font-bold text-gray-700">{l.operator}</td>
                          <td className="px-6 py-4 text-xs font-bold">{l.action}</td>
                          <td className="px-6 py-4 text-xs text-gray-600 max-w-md truncate" title={l.detail}>{l.detail}</td>
                        </tr>
                      ))
                    ); })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {subTab === 'apikeys' && (
            <div className="space-y-4 max-w-4xl">
               <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-start gap-2 mb-6">
                 <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
                 <p>为保障数据安全，以下所有配置将<strong>直接写入您的 Node.js 后端本地数据库（如 backend/data/*.json 或 MySQL）</strong>，绝不泄露在前端代码或浏览器中。保证您的云端资产绝对安全。</p>
               </div>
              {vendors.map(v => {
                const kSt = adminKeys[v.id] || { value: '', status: 'idle', msg: '' };
                const keyHints = { openai: 'sk-... (OpenAI Dashboard)', anthropic: 'sk-ant-... (Anthropic Console)', google: 'AIza... (Google AI Studio)', deepseek: 'sk-... (DeepSeek 开放平台)', alibaba: 'sk-... (阿里云百炼)', zhipu: '... (智谱 开放平台)', doubao: '火山方舟控制台 → API Key 管理（非火山引擎 AccessKey）', moonshot: 'sk-... (Moonshot 开放平台)', ollama: '本地模型无需 Key', vllm: '本地模型无需 Key' };
                const hint = keyHints[v.id] || '填写 API Key';
                return (
                  <div key={v.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 w-1/3">
                        <div className="w-10 h-10 bg-gray-50 border border-gray-100 rounded-lg flex items-center justify-center"><Key size={16} className="text-gray-400"/></div>
                        <div><h4 className="font-bold text-gray-800 text-sm">{v.name}</h4><p className="text-[10px] text-gray-500">{v.region}</p></div>
                      </div>
                      <div className="flex-1 flex items-center gap-2">
                        <input type="password" placeholder={hint} className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-indigo-500" value={kSt.value} onChange={(e) => handleKeyChange(v.id, e.target.value)} />
                        <button onClick={() => handleTestKey(v.id)} disabled={kSt.status==='testing'||!kSt.value} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 font-bold text-sm rounded-lg transition-colors">{kSt.status==='testing'?'测试中…':'测试'}</button>
                        <button onClick={() => addLog('info', auth.username, '保存API', `更新了 ${v.name} 的系统级 API Key`)} disabled={kSt.status!=='success'} className={`px-4 py-2 font-bold text-sm rounded-lg transition-colors border ${kSt.status==='success'?'bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-700':'bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed'}`}>保存写入</button>
                      </div>
                    </div>
                    {kSt.msg && (
                      <p className={`mt-2 ml-1 text-xs font-medium ${kSt.status==='success'?'text-green-600':kSt.status==='error'?'text-red-500':'text-gray-400'}`}>
                        {kSt.status==='success'?'✓ ':kSt.status==='error'?'✗ ':''}{kSt.msg}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {subTab === 'vendors' && (
            <div className="max-w-4xl space-y-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">管理平台支持的 AI 厂商及其可用模型列表，修改后将实时同步至所有用户的模型选择下拉框。</p>
                <button onClick={() => { setEditingVendor('__new__'); setVendorForm({ id: '', name: '', region: 'CN', models: '' }); }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow"><Plus size={16}/> 添加厂商</button>
              </div>

              {editingVendor && (
                <div className="bg-white border-2 border-indigo-300 rounded-xl p-6 shadow-md">
                  <h4 className="font-bold text-gray-800 mb-4 flex items-center gap-2"><Server size={18} className="text-indigo-500"/> {editingVendor === '__new__' ? '新增厂商' : `编辑: ${editingVendor.name}`}</h4>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-600 mb-1">厂商 ID（唯一标识，小写英文）</label>
                      <input className="w-full text-sm p-2.5 border border-gray-300 rounded-lg" placeholder="例: openai" value={vendorForm.id} onChange={e => setVendorForm(p => ({...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '')}))} disabled={editingVendor !== '__new__'} />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-600 mb-1">显示名称</label>
                      <input className="w-full text-sm p-2.5 border border-gray-300 rounded-lg" placeholder="例: OpenAI" value={vendorForm.name} onChange={e => setVendorForm(p => ({...p, name: e.target.value}))} />
                    </div>
                  </div>
                  <div className="mb-4">
                    <label className="block text-xs font-bold text-gray-600 mb-1">区域</label>
                    <select className="w-full text-sm p-2.5 border border-gray-300 rounded-lg bg-white" value={vendorForm.region} onChange={e => setVendorForm(p => ({...p, region: e.target.value}))}>
                      <option value="US">US（海外）</option>
                      <option value="CN">CN（国内）</option>
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block text-xs font-bold text-gray-600 mb-1">模型列表（每行一个模型名，或用英文逗号分隔）</label>
                    <textarea className="w-full text-sm p-2.5 border border-gray-300 rounded-lg font-mono" rows={4} placeholder="gpt-4.1&#10;gpt-4.1-mini&#10;gpt-4o" value={vendorForm.models} onChange={e => setVendorForm(p => ({...p, models: e.target.value}))} />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => {
                      const modelsArr = vendorForm.models.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
                      if (!vendorForm.id || !vendorForm.name || modelsArr.length === 0) { alert('请填写完整的厂商 ID、名称和至少一个模型'); return; }
                      const newV = { id: vendorForm.id, name: vendorForm.name, region: vendorForm.region, models: modelsArr };
                      if (editingVendor === '__new__') {
                        if (vendors.some(v => v.id === vendorForm.id)) { alert('厂商 ID 已存在'); return; }
                        setVendors(prev => [...prev, newV]);
                        addLog('info', auth.username, '厂商配置', `新增厂商 ${newV.name}（${modelsArr.length} 个模型）`);
                      } else {
                        setVendors(prev => prev.map(v => v.id === editingVendor.id ? newV : v));
                        addLog('info', auth.username, '厂商配置', `编辑厂商 ${newV.name}（${modelsArr.length} 个模型）`);
                      }
                      setEditingVendor(null);
                    }} className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-bold text-sm hover:bg-indigo-700 transition-colors flex items-center gap-2"><Save size={14}/> 保存</button>
                    <button onClick={() => setEditingVendor(null)} className="px-5 py-2 bg-gray-200 text-gray-700 rounded-lg font-bold text-sm hover:bg-gray-300 transition-colors">取消</button>
                  </div>
                </div>
              )}

              {vendors.map(v => (
                <div key={v.id} className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <Server size={18} className="text-indigo-500"/>
                      <h4 className="font-bold text-gray-800">{v.name}</h4>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${v.region === 'US' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{v.region}</span>
                      <span className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded">ID: {v.id}</span>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { setEditingVendor(v); setVendorForm({ id: v.id, name: v.name, region: v.region, models: v.models.join('\n') }); }} className="px-3 py-1.5 text-xs font-bold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">编辑</button>
                      <button onClick={() => { if (vendors.length <= 1) { alert('至少保留一个厂商'); return; } if (!confirm(`确定删除厂商「${v.name}」？删除后不可恢复。`)) return; setVendors(prev => prev.filter(x => x.id !== v.id)); addLog('warn', auth.username, '厂商配置', `删除厂商 ${v.name}`); }} className="px-3 py-1.5 text-xs font-bold text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors">删除</button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {v.models.map(m => (
                      <span key={m} className="text-xs px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-lg font-mono">{m}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {subTab === 'settings' && (
            <div className="max-w-4xl space-y-8">
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-6 flex items-center gap-2"><Sliders className="text-indigo-600"/> 系统运行模式</h3>
                <div className={`p-6 rounded-2xl border-2 transition-all flex items-center justify-between ${isTestMode ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'}`}>
                  <div>
                    <h4 className={`font-bold text-lg mb-1 ${isTestMode ? 'text-amber-800' : 'text-gray-800'}`}>{isTestMode ? '🧪 开放测试阶段' : '🚀 生产收费阶段'}</h4>
                    <p className="text-sm text-gray-500">{isTestMode ? '新用户注册即可无缝登入并获得免费调度权限，不拦截支付。' : '新用户注册受限，调度将执行严密计费校验。'}</p>
                  </div>
                  <button onClick={() => { setIsTestMode(!isTestMode); addLog('warn', auth.username, '系统模式切换', `将运行模式切换为了: ${!isTestMode ? '测试阶段' : '生产收费'}`); }} className={`px-6 py-3 rounded-xl font-bold transition-all ${isTestMode ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                    {isTestMode ? '结束测试，切生产' : '开启测试运行阶段'}
                  </button>
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-6 flex items-center gap-2"><ShieldCheck className="text-indigo-600"/> 终审策略</h3>
                <p className="text-sm text-gray-500 mb-4">配置四级流水线的终审输出策略，该设置对所有用户生效。</p>
                <div className="grid grid-cols-2 gap-3">
                  {STRATEGIES.map(s => (
                    <button key={s.id} onClick={() => { setStrategy(s.id); addLog('info', auth.username, '策略变更', `终审策略设为「${s.name}」`); }} className={`p-4 rounded-xl border-2 text-left transition-all ${strategy === s.id ? 'border-indigo-500 bg-indigo-50 shadow-md' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                      <div className={`text-sm font-bold mb-1 ${strategy === s.id ? 'text-indigo-700' : 'text-gray-800'}`}>{strategy === s.id && '✓ '}{s.name}</div>
                      <div className="text-xs text-gray-500">{s.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-2 flex items-center gap-2"><BellRing className="text-indigo-600"/> 异常告警渠道配置</h3>
                <p className="text-sm text-gray-500 mb-6">配置当系统自检不通过或运行中发生崩溃时的推送通道信息。该信息仅本地存储。</p>
                
                <div className="space-y-6">
                  <div className="p-5 bg-gray-50 border border-gray-200 rounded-xl">
                    <h4 className="font-bold text-sm text-gray-700 flex items-center gap-2 mb-4"><Mail size={16}/> SMTP 邮箱网关</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <input type="text" value={alertsConfig.smtpServer || ''} onChange={e=>setAlertsConfig({...alertsConfig, smtpServer: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="SMTP 服务器 (如 smtp.exmail.qq.com)" />
                      <input type="text" value={alertsConfig.smtpPort || ''} onChange={e=>setAlertsConfig({...alertsConfig, smtpPort: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="端口 (如 465)" />
                      <input type="email" value={alertsConfig.email || ''} onChange={e=>setAlertsConfig({...alertsConfig, email: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="接收/发件邮箱" />
                      <input type="password" value={alertsConfig.emailPwd || ''} onChange={e=>setAlertsConfig({...alertsConfig, emailPwd: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="邮箱授权码" />
                    </div>
                  </div>

                  <div className="p-5 bg-gray-50 border border-gray-200 rounded-xl">
                    <h4 className="font-bold text-sm text-gray-700 flex items-center gap-2 mb-4"><Smartphone size={16}/> 云服务短信通道</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <select value={alertsConfig.smsProvider || 'aliyun'} onChange={e=>setAlertsConfig({...alertsConfig, smsProvider: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                        <option value="aliyun">阿里云短信</option>
                        <option value="tencent">腾讯云 SMS</option>
                      </select>
                      <input type="tel" value={alertsConfig.phone || ''} onChange={e=>setAlertsConfig({...alertsConfig, phone: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="接收告警手机号" />
                      <input type="password" value={alertsConfig.smsAppKey || ''} onChange={e=>setAlertsConfig({...alertsConfig, smsAppKey: e.target.value})} className="col-span-2 p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="AccessKeyId:AccessKeySecret（冒号分隔）" />
                      <input type="text" value={alertsConfig.smsSign || ''} onChange={e=>setAlertsConfig({...alertsConfig, smsSign: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="短信签名（如 ZDF.AI）" />
                      <input type="text" value={alertsConfig.smsTemplate || ''} onChange={e=>setAlertsConfig({...alertsConfig, smsTemplate: e.target.value})} className="p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="模板编号（如 SMS_123456）" />
                    </div>
                  </div>

                  <div className="p-5 bg-gray-50 border border-gray-200 rounded-xl">
                    <h4 className="font-bold text-sm text-gray-700 flex items-center gap-2 mb-4"><MessageSquare size={16}/> 企业微信 / 钉钉 Webhook</h4>
                    <div className="space-y-3">
                      <input type="text" value={alertsConfig.webhookWechat || ''} onChange={e=>setAlertsConfig({...alertsConfig, webhookWechat: e.target.value})} className="w-full p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="企业微信 Webhook: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
                      <input type="text" value={alertsConfig.webhookDingtalk || ''} onChange={e=>setAlertsConfig({...alertsConfig, webhookDingtalk: e.target.value})} className="w-full p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="钉钉 Webhook: https://oapi.dingtalk.com/robot/send?access_token=..." />
                    </div>
                  </div>

                  <div className="pt-2 flex gap-3 justify-end">
                    <button onClick={async () => {
                      try {
                        const r = await fetch(`${API_BASE_URL}/admin/send-alert`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                          body: JSON.stringify({ title: 'Webhook 测试', content: '这是一条来自 ZDF.AI 管理后台的测试告警。如果收到说明 Webhook 配置正确。' }),
                        });
                        const data = await r.json();
                        if (data.results?.length > 0) {
                          const summary = data.results.map(r => `${r.channel}: ${r.ok ? 'OK' : r.msg}`).join('\n');
                          alert('Webhook 测试结果:\n' + summary);
                        } else { alert(data.error || '未配置 Webhook URL'); }
                      } catch { alert('发送失败，请检查后端是否在线'); }
                    }} className="flex items-center gap-2 px-5 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl shadow-md transition-colors"><BellRing size={16}/> 测试 Webhook</button>
                    <button onClick={async () => {
                      try {
                        await fetch(`${API_BASE_URL}/admin/settings`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                          body: JSON.stringify({ alertsConfig }),
                        });
                        addLog('info', auth.username, '修改告警配置', '保存了最新的告警通信渠道参数');
                        alert('告警集成配置已保存！');
                      } catch { alert('保存失败'); }
                    }} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition-colors"><Save size={16}/> 保存集成配置</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {subTab === 'templates' && (
            <div className="max-w-5xl space-y-6">
              {/* 添加 / 编辑表单 */}
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-4 flex items-center gap-2">
                  <BookOpen className="text-indigo-600" size={20}/> {editTpl ? '编辑模板' : '新增模板'}
                </h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-600 mb-1">模板标题</label>
                    <input value={editTpl ? editTpl.title : newTpl.title} onChange={e => editTpl ? setEditTpl({...editTpl, title: e.target.value}) : setNewTpl({...newTpl, title: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="如：商业报告生成"/>
                  </div>
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-gray-600 mb-1">分类</label>
                      <select value={editTpl ? editTpl.category : newTpl.category} onChange={e => editTpl ? setEditTpl({...editTpl, category: e.target.value}) : setNewTpl({...newTpl, category: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        {['通用','写作','分析','编程','翻译','决策','创意','企业'].map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-gray-600 mb-1">最低套餐</label>
                      <select value={editTpl ? editTpl.plan : newTpl.plan} onChange={e => editTpl ? setEditTpl({...editTpl, plan: e.target.value}) : setNewTpl({...newTpl, plan: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        <option value="free">Free</option>
                        <option value="pro">Pro</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-bold text-gray-600 mb-1">Prompt 内容 <span className="text-gray-400 font-normal">（用 {'{input}'} 表示用户输入占位）</span></label>
                  <textarea value={editTpl ? editTpl.prompt : newTpl.prompt} onChange={e => editTpl ? setEditTpl({...editTpl, prompt: e.target.value}) : setNewTpl({...newTpl, prompt: e.target.value})} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" placeholder="请根据以下内容...&#10;{input}"/>
                </div>
                <div className="flex gap-3">
                  <button onClick={async () => {
                    const tpl = editTpl || newTpl;
                    if (!tpl.title || !tpl.prompt) { alert('请填写标题和 Prompt 内容'); return; }
                    try {
                      const r = await fetch(`${API_BASE_URL}/admin/prompt-templates`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                        body: JSON.stringify(tpl)
                      });
                      const d = await r.json();
                      if (d.ok && d.template) {
                        setAdminTemplates(prev => {
                          const idx = prev.findIndex(t => t.id === d.template.id);
                          return idx >= 0 ? prev.map((t,i) => i === idx ? d.template : t) : [...prev, d.template];
                        });
                        addLog('info', auth.username, editTpl ? '编辑模板' : '新增模板', `模板: ${tpl.title}`);
                        setEditTpl(null);
                        setNewTpl({ title: '', prompt: '', category: '通用', plan: 'free' });
                      }
                    } catch { alert('保存失败，请检查网络'); }
                  }} className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700">
                    {editTpl ? '更新模板' : '添加模板'}
                  </button>
                  {editTpl && <button onClick={() => setEditTpl(null)} className="px-5 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-bold hover:bg-gray-300">取消编辑</button>}
                </div>
              </div>

              {/* 模板列表 */}
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-4">已有模板 ({adminTemplates.length})</h3>
                {adminTemplates.length === 0 ? (
                  <p className="text-sm text-gray-400 py-8 text-center">暂无 Prompt 模板，请在上方添加</p>
                ) : (
                  <div className="space-y-3">
                    {adminTemplates.map(tpl => (
                      <div key={tpl.id} className="flex items-start gap-4 p-4 border border-gray-100 rounded-2xl hover:bg-gray-50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-gray-800 text-sm">{tpl.title}</span>
                            <span className="px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-bold">{tpl.category}</span>
                            <span className={`px-2 py-0.5 text-[10px] rounded-full font-bold ${tpl.plan === 'free' ? 'bg-green-100 text-green-700' : tpl.plan === 'pro' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>{tpl.plan}</span>
                          </div>
                          <p className="text-xs text-gray-500 truncate">{tpl.prompt.slice(0, 120)}...</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => setEditTpl({...tpl})} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg font-bold text-gray-600">编辑</button>
                          <button onClick={async () => {
                            if (!confirm(`确认删除模板「${tpl.title}」？`)) return;
                            try {
                              await fetch(`${API_BASE_URL}/admin/prompt-templates/${tpl.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } });
                              setAdminTemplates(prev => prev.filter(t => t.id !== tpl.id));
                              addLog('warn', auth.username, '删除模板', `删除模板: ${tpl.title}`);
                            } catch { alert('删除失败'); }
                          }} className="px-3 py-1.5 text-xs bg-red-50 hover:bg-red-100 rounded-lg font-bold text-red-600">删除</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {subTab === 'upgrades' && (
            <div className="max-w-5xl space-y-6">
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-4 flex items-center gap-2">
                  <Crown className="text-amber-500" size={20}/> 套餐升级审批
                </h3>
                {(() => {
                  const [upgradeList, setUpgradeList] = React.useState([]);
                  const [upgradeLoading, setUpgradeLoading] = React.useState(true);
                  React.useEffect(() => {
                    fetch(`${API_BASE_URL}/admin/upgrade-requests`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
                      .then(r => r.ok ? r.json() : null)
                      .then(d => { if (d?.requests) setUpgradeList(d.requests.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''))); })
                      .catch(() => {})
                      .finally(() => setUpgradeLoading(false));
                  }, []);
                  const handleReview = async (id, action) => {
                    const note = action === 'reject' ? (prompt('拒绝原因（可选）：') || '') : '';
                    try {
                      const r = await fetch(`${API_BASE_URL}/admin/upgrade-requests/${id}/review`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                        body: JSON.stringify({ action, note }),
                      });
                      const d = await r.json();
                      if (d.ok) {
                        setUpgradeList(prev => prev.map(x => x.id === id ? d.request : x));
                        addLog('info', auth.username, action === 'approve' ? '批准升级' : '拒绝升级', `用户 ${d.request.username}: ${d.request.fromPlan} → ${d.request.toPlan}`);
                      } else { alert(d.error || '操作失败'); }
                    } catch { alert('网络错误'); }
                  };
                  if (upgradeLoading) return <p className="text-sm text-gray-400 py-4">加载中...</p>;
                  const pending = upgradeList.filter(r => r.status === 'pending');
                  const processed = upgradeList.filter(r => r.status !== 'pending');
                  return (
                    <div className="space-y-6">
                      <div>
                        <h4 className="font-bold text-gray-700 text-sm mb-3">待审核 ({pending.length})</h4>
                        {pending.length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">暂无待审核的升级申请</p> : (
                          <div className="space-y-3">
                            {pending.map(r => (
                              <div key={r.id} className="flex items-center gap-4 p-4 border-2 border-amber-200 bg-amber-50 rounded-2xl">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="font-bold text-gray-800">{r.username}</span>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 font-bold">{r.fromPlan}</span>
                                    <ArrowRight size={14} className="text-gray-400"/>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-bold">{r.toPlan}</span>
                                  </div>
                                  {r.message && <p className="text-xs text-gray-500 mt-1">{r.message}</p>}
                                  <p className="text-[10px] text-gray-400 mt-1">{new Date(r.createdAt).toLocaleString()}</p>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => handleReview(r.id, 'approve')} className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-xl hover:bg-green-700">批准</button>
                                  <button onClick={() => handleReview(r.id, 'reject')} className="px-4 py-2 bg-red-500 text-white text-xs font-bold rounded-xl hover:bg-red-600">拒绝</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {processed.length > 0 && (
                        <div>
                          <h4 className="font-bold text-gray-700 text-sm mb-3">历史记录 ({processed.length})</h4>
                          <div className="space-y-2">
                            {processed.slice(0, 20).map(r => (
                              <div key={r.id} className="flex items-center gap-4 p-3 border border-gray-100 rounded-xl text-sm">
                                <span className="font-bold text-gray-700 w-24 truncate">{r.username}</span>
                                <span className="text-xs text-gray-500">{r.fromPlan} → {r.toPlan}</span>
                                <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold ${r.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                  {r.status === 'approved' ? '已批准' : '已拒绝'}
                                </span>
                                <span className="text-[10px] text-gray-400">{new Date(r.reviewedAt || r.createdAt).toLocaleDateString()}</span>
                                {r.reviewNote && <span className="text-xs text-gray-400 truncate max-w-[120px]" title={r.reviewNote}>{r.reviewNote}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {subTab === 'orders' && (
            <div className="max-w-5xl space-y-6">
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-4 flex items-center gap-2">
                  <CreditCard className="text-indigo-600" size={20}/> 订单与支付管理
                </h3>
                {(() => {
                  const [orderList, setOrderList] = React.useState([]);
                  const [orderLoading, setOrderLoading] = React.useState(true);
                  React.useEffect(() => {
                    fetch(`${API_BASE_URL}/admin/orders`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
                      .then(r => r.ok ? r.json() : null)
                      .then(d => { if (d?.orders) setOrderList(d.orders); })
                      .catch(() => {})
                      .finally(() => setOrderLoading(false));
                  }, []);
                  if (orderLoading) return <p className="text-sm text-gray-400 py-4">加载中...</p>;
                  if (orderList.length === 0) return <p className="text-sm text-gray-400 py-8 text-center">暂无订单记录</p>;
                  const paid = orderList.filter(o => o.status === 'paid');
                  const pending = orderList.filter(o => o.status === 'pending');
                  const totalRevenue = paid.reduce((s, o) => s + (o.amount || 0), 0);
                  return (
                    <div className="space-y-6">
                      <div className="grid grid-cols-4 gap-4">
                        <div className="p-4 bg-green-50 rounded-xl border border-green-200 text-center">
                          <div className="text-2xl font-black text-green-700">{paid.length}</div>
                          <div className="text-xs text-green-600 font-bold">已支付</div>
                        </div>
                        <div className="p-4 bg-yellow-50 rounded-xl border border-yellow-200 text-center">
                          <div className="text-2xl font-black text-yellow-700">{pending.length}</div>
                          <div className="text-xs text-yellow-600 font-bold">待支付</div>
                        </div>
                        <div className="p-4 bg-indigo-50 rounded-xl border border-indigo-200 text-center">
                          <div className="text-2xl font-black text-indigo-700">{orderList.length}</div>
                          <div className="text-xs text-indigo-600 font-bold">总订单</div>
                        </div>
                        <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 text-center">
                          <div className="text-lg font-black text-emerald-700">{paid.some(o => o.currency === 'eur') ? `€${(totalRevenue/100).toFixed(0)}` : `¥${(totalRevenue/100).toFixed(0)}`}</div>
                          <div className="text-xs text-emerald-600 font-bold">总收入</div>
                        </div>
                      </div>
                      <div className="overflow-hidden rounded-xl border border-gray-200">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">订单号</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">用户</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">套餐</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">金额</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">渠道</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">状态</th>
                              <th className="px-4 py-3 text-left font-bold text-gray-600">时间</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orderList.slice(0, 50).map(o => (
                              <tr key={o.id} className="border-t border-gray-100 hover:bg-gray-50">
                                <td className="px-4 py-3 font-mono text-xs text-gray-500">{o.id.slice(0, 16)}...</td>
                                <td className="px-4 py-3 font-bold text-gray-700">{o.username || o.userId}</td>
                                <td className="px-4 py-3"><span className="px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-bold">{o.plan}</span></td>
                                <td className="px-4 py-3 font-mono">{o.currency === 'eur' ? '€' : '¥'}{(o.amount / 100).toFixed(2)}</td>
                                <td className="px-4 py-3"><span className={`px-2 py-0.5 text-[10px] rounded-full font-bold ${o.provider === 'stripe' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{o.provider}</span></td>
                                <td className="px-4 py-3"><span className={`px-2 py-0.5 text-[10px] rounded-full font-bold ${o.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{o.status === 'paid' ? '已支付' : '待支付'}</span></td>
                                <td className="px-4 py-3 text-xs text-gray-400">{new Date(o.paidAt || o.createdAt).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {subTab === 'workflow' && (
            <div className="max-w-4xl space-y-6">
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-2 flex items-center gap-2"><GitBranch className="text-indigo-600" size={20}/> 工作流编排引擎</h3>
                <p className="text-sm text-gray-500 mb-6">可视化配置 AI 多步骤工作流，支持条件分支、循环、并行节点，将复杂业务流程转化为自动化流水线。</p>
                <div className="grid grid-cols-3 gap-4 mb-6">
                  {[
                    { title: '顺序流水线', desc: 'A → B → C → D 依次执行，上一步输出作为下一步输入', status: '已内置' },
                    { title: '条件分支', desc: '根据中间结果动态选择后续路径（如置信度 < 0.8 走人工审核）', status: '规划中' },
                    { title: '并行节点', desc: '多个模型同时运行同一任务，结果合并投票', status: '规划中' },
                    { title: '循环迭代', desc: '不满足质量阈值时自动重试，最多 N 轮', status: '规划中' },
                    { title: '人工审批节点', desc: '在流水线中插入人工审批环节，支持超时自动放行', status: '规划中' },
                    { title: '外部 API 调用', desc: '在流程中调用第三方 REST API 获取实时数据', status: '规划中' },
                  ].map((f, i) => (
                    <div key={i} className={`p-4 rounded-2xl border-2 ${f.status === '已内置' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-bold text-sm text-gray-800">{f.title}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${f.status === '已内置' ? 'bg-green-200 text-green-700' : 'bg-gray-200 text-gray-500'}`}>{f.status}</span>
                      </div>
                      <p className="text-xs text-gray-500">{f.desc}</p>
                    </div>
                  ))}
                </div>
                <div className="p-6 border-2 border-dashed border-indigo-200 rounded-2xl bg-indigo-50/50 text-center">
                  <GitBranch className="mx-auto text-indigo-300 mb-3" size={40} />
                  <p className="text-sm font-bold text-indigo-600 mb-1">可视化工作流编辑器</p>
                  <p className="text-xs text-indigo-400">拖拽节点构建自定义 AI 工作流 — Enterprise 专属功能，即将上线</p>
                </div>
                {(() => {
                  const [wfList, setWfList] = React.useState([]);
                  const [newName, setNewName] = React.useState('');
                  const [newSteps, setNewSteps] = React.useState('');
                  const [creating, setCreating] = React.useState(false);
                  const tkn = window.sessionStorage.getItem('token') || '';
                  const hdrs = { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' };
                  React.useEffect(() => {
                    fetch(`${API_BASE_URL}/admin/workflows`, { headers: hdrs })
                      .then(r => r.ok ? r.json() : null).then(d => { if (d?.workflows) setWfList(d.workflows); }).catch(() => {});
                  }, []);
                  const handleCreate = async () => {
                    if (!newName.trim() || !newSteps.trim()) return;
                    setCreating(true);
                    const steps = newSteps.split('\n').filter(Boolean).map((line, i) => {
                      const [role, ...rest] = line.split(':');
                      return { id: String.fromCharCode(65 + i), role: role.trim(), systemPrompt: '', inputTemplate: rest.join(':').trim() || '{input}' };
                    });
                    try {
                      const r = await fetch(`${API_BASE_URL}/admin/workflows`, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: newName.trim(), steps }) });
                      if (r.ok) { const d = await r.json(); setWfList(prev => [...prev, d.workflow]); setNewName(''); setNewSteps(''); }
                    } catch {}
                    setCreating(false);
                  };
                  const handleDelete = async (id) => {
                    try {
                      const r = await fetch(`${API_BASE_URL}/admin/workflows/${id}`, { method: 'DELETE', headers: hdrs });
                      if (r.ok) setWfList(prev => prev.filter(w => w.id !== id));
                    } catch {}
                  };
                  return (
                <div className="mt-6 bg-gray-50 rounded-2xl border border-gray-200 p-6">
                  <h4 className="font-bold text-sm text-gray-800 mb-3">工作流配置 ({wfList.length})</h4>
                  <div className="space-y-3">
                    {wfList.map((wf) => (
                      <div key={wf.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
                        <span className={`w-2 h-2 rounded-full ${wf.active !== false ? 'bg-green-500' : 'bg-gray-300'}`}/>
                        <span className="font-bold text-sm text-gray-700 w-48">{wf.name}</span>
                        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
                          {wf.steps.map((s, j) => (
                            <React.Fragment key={j}>
                              {j > 0 && <ArrowRight size={12} className="text-gray-300 shrink-0"/>}
                              <span className="text-[10px] px-2 py-1 bg-indigo-100 text-indigo-700 rounded-full font-bold whitespace-nowrap">{s.role}</span>
                            </React.Fragment>
                          ))}
                        </div>
                        {wf.builtin ? <span className="text-[9px] px-2 py-0.5 bg-gray-100 text-gray-400 rounded-full">内置</span>
                          : <button onClick={() => handleDelete(wf.id)} className="text-red-400 hover:text-red-600 text-xs">删除</button>}
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 p-4 bg-white rounded-xl border border-gray-200">
                    <h5 className="font-bold text-xs text-gray-600 mb-2">创建自定义工作流</h5>
                    <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="工作流名称" className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg mb-2"/>
                    <textarea value={newSteps} onChange={e => setNewSteps(e.target.value)} placeholder={"每行一个步骤，格式: 角色:输入模板\n例:\n生成者:{input}\n校核者:校核以下内容:\\n{A}"} rows={3} className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg mb-2 font-mono"/>
                    <button onClick={handleCreate} disabled={creating || !newName.trim()} className="px-4 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                      {creating ? '创建中...' : '创建工作流'}
                    </button>
                  </div>
                </div>
                  );
                })()}
              </div>
            </div>
          )}

          {subTab === 'sla' && (
            <div className="max-w-4xl space-y-6">
              {(() => {
                const [slaData, setSlaData] = React.useState(null);
                const tkn = window.sessionStorage.getItem('token') || '';
                React.useEffect(() => {
                  fetch(`${API_BASE_URL}/admin/sla`, { headers: { Authorization: `Bearer ${tkn}` } })
                    .then(r => r.ok ? r.json() : null).then(d => { if (d) setSlaData(d); }).catch(() => {});
                }, []);
                const avail = slaData?.availability ?? '—';
                const rt = slaData?.responseTime || {};
                const aiRt = slaData?.aiResponseTime || {};
                const up = slaData?.uptime || {};
                return (<>
              {slaData && (
                <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm">
                  <div className="grid grid-cols-4 gap-4">
                    <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl p-4 border border-green-200 text-center">
                      <p className="text-2xl font-black text-green-600">{avail}%</p>
                      <p className="text-[10px] text-green-500 font-bold mt-1">可用性</p>
                    </div>
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border border-blue-200 text-center">
                      <p className="text-2xl font-black text-blue-600">{rt.avg || 0}<span className="text-xs">ms</span></p>
                      <p className="text-[10px] text-blue-500 font-bold mt-1">API P95: {rt.p95 || 0}ms</p>
                    </div>
                    <div className="bg-gradient-to-br from-purple-50 to-violet-50 rounded-2xl p-4 border border-purple-200 text-center">
                      <p className="text-2xl font-black text-purple-600">{aiRt.avg || 0}<span className="text-xs">ms</span></p>
                      <p className="text-[10px] text-purple-500 font-bold mt-1">AI P95: {aiRt.p95 || 0}ms</p>
                    </div>
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-200 text-center">
                      <p className="text-2xl font-black text-amber-600">{up.hours || 0}<span className="text-xs">h</span></p>
                      <p className="text-[10px] text-amber-500 font-bold mt-1">连续运行</p>
                    </div>
                  </div>
                </div>
              )}
              </>);
              })()}
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-2 flex items-center gap-2"><Shield className="text-indigo-600" size={20}/> SLA 服务等级协议</h3>
                <p className="text-sm text-gray-500 mb-6">为企业客户提供可量化的服务保障承诺，包含可用性、响应时间、数据安全等核心指标。</p>
                <div className="space-y-4">
                  {[
                    { metric: '平台可用性', target: '99.9%', current: '统计中...', desc: '每月允许最大停机时间 43 分钟' },
                    { metric: 'API 平均响应时间', target: '\u003C 2s (P95)', current: '统计中...', desc: '从请求发出到首 Token 返回的延迟' },
                    { metric: '数据保留期', target: '永久', current: 'Enterprise', desc: '企业版历史记录与审计日志永久保留' },
                    { metric: '故障恢复时间 (RTO)', target: '\u003C 1h', current: '—', desc: '发生重大故障后恢复服务的目标时间' },
                    { metric: '数据恢复点 (RPO)', target: '\u003C 15min', current: '—', desc: '发生故障时最大可接受的数据丢失时间窗口' },
                    { metric: '专属技术支持', target: '7×24h', current: '—', desc: '企业客户拥有专属客户成功经理与工程师团队' },
                  ].map((s, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-200">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-gray-800">{s.metric}</span>
                          <span className="text-[10px] px-2 py-0.5 bg-indigo-100 text-indigo-600 rounded-full font-bold">目标: {s.target}</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{s.desc}</p>
                      </div>
                      <span className="text-sm font-mono text-gray-500 ml-4">{s.current}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-base font-black text-gray-800 mb-4">SLA 违约赔偿机制</h3>
                <div className="overflow-hidden rounded-xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left font-bold text-gray-600">月可用性</th><th className="px-4 py-3 text-left font-bold text-gray-600">服务等级</th><th className="px-4 py-3 text-left font-bold text-gray-600">赔偿方案</th></tr></thead>
                    <tbody>
                      <tr className="border-t border-gray-100"><td className="px-4 py-3 text-green-600 font-bold">≥ 99.9%</td><td className="px-4 py-3">达标</td><td className="px-4 py-3 text-gray-500">—</td></tr>
                      <tr className="border-t border-gray-100"><td className="px-4 py-3 text-amber-600 font-bold">99.0% ~ 99.9%</td><td className="px-4 py-3">轻微违约</td><td className="px-4 py-3 text-gray-500">延长 10% 服务期</td></tr>
                      <tr className="border-t border-gray-100"><td className="px-4 py-3 text-red-600 font-bold">{'\u003C 99.0%'}</td><td className="px-4 py-3">严重违约</td><td className="px-4 py-3 text-gray-500">延长 30% 服务期 + 专项优化</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-400 mt-4">* SLA 协议在签署企业服务合同后正式生效。以上为标准条款，可根据客户需求定制。</p>
              </div>
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-base font-black text-gray-800 mb-4">实时系统健康状态</h3>
                {(() => {
                  const [healthData, setHealthData] = React.useState(null);
                  const [checking, setChecking] = React.useState(false);
                  const runCheck = async () => {
                    setChecking(true);
                    try {
                      const r = await fetch(`${API_BASE_URL}/admin/health-check`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } });
                      if (r.ok) setHealthData(await r.json());
                    } catch {}
                    setChecking(false);
                  };
                  return (
                    <div>
                      <button onClick={runCheck} disabled={checking} className="mb-4 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-50">
                        {checking ? '检测中...' : '运行系统自检'}
                      </button>
                      {healthData?.results && (
                        <div className="space-y-2">
                          {healthData.results.map((r, i) => (
                            <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                              <span className={`w-2.5 h-2.5 rounded-full ${r.status === 'ok' ? 'bg-green-500' : r.status === 'warn' ? 'bg-amber-500' : 'bg-red-500'}`}/>
                              <span className="font-bold text-sm text-gray-700 uppercase w-16">{r.id}</span>
                              <span className="text-xs text-gray-500 flex-1">{r.msg}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {subTab === 'deploy' && (
            <div className="max-w-4xl space-y-6">
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-lg font-black text-gray-800 mb-2 flex items-center gap-2"><Cloud className="text-indigo-600" size={20}/> 私有化部署</h3>
                <p className="text-sm text-gray-500 mb-6">将 ZDF.AI 完整部署到企业内网或指定云环境，数据不出域，满足合规与安全要求。</p>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  {[
                    { title: '容器化部署', desc: '提供 Docker / K8s Helm Chart，一键部署到企业容器平台', icon: '📦' },
                    { title: '本地模型支持', desc: '对接企业自有大模型（如 LLaMA、ChatGLM 本地版），数据零外泄', icon: '🔒' },
                    { title: '企业知识库', desc: '私有向量数据库，支持 Milvus / Weaviate / PgVector 对接', icon: '🗄️' },
                    { title: 'LDAP/SSO 集成', desc: '对接企业 Active Directory、SAML 2.0、OAuth 2.0 单点登录', icon: '🔑' },
                    { title: '审计合规', desc: '所有操作记录加密存储，满足 GDPR、等保三级等合规要求', icon: '📋' },
                    { title: '高可用架构', desc: '多节点负载均衡 + 自动故障转移，支持跨 AZ 容灾部署', icon: '🏗️' },
                  ].map((f, i) => (
                    <div key={i} className="p-5 bg-gray-50 border border-gray-200 rounded-2xl">
                      <div className="text-2xl mb-2">{f.icon}</div>
                      <h4 className="font-bold text-sm text-gray-800 mb-1">{f.title}</h4>
                      <p className="text-xs text-gray-500">{f.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-base font-black text-gray-800 mb-4">部署架构参考</h3>
                <div className="bg-gray-50 rounded-2xl border border-gray-200 p-6 font-mono text-xs text-gray-600 leading-relaxed whitespace-pre">{`┌─────────────────────────────────────────────────┐
│                 企业内网 / VPC                      │
│                                                     │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│   │  Nginx   │──▶│ ZDF.AI   │──▶│ 本地模型  │      │
│   │  网关    │   │ Backend  │   │ LLaMA等  │      │
│   └──────────┘   └────┬─────┘   └──────────┘      │
│                       │                             │
│          ┌────────────┴────────────┐                │
│          ▼                         ▼                │
│   ┌──────────┐            ┌──────────┐             │
│   │  SQLite  │            │  Vector  │             │
│   │ / PgSQL  │            │   DB     │             │
│   └──────────┘            └──────────┘             │
│                                                     │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│   │  LDAP    │   │  审计日志 │   │  对象存储 │      │
│   │  / SSO   │   │  加密归档 │   │  MinIO   │      │
│   └──────────┘   └──────────┘   └──────────┘      │
└─────────────────────────────────────────────────┘`}</div>
              </div>
              <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm">
                <h3 className="text-base font-black text-gray-800 mb-4">部署前检查清单</h3>
                {(() => {
                  const items = [
                    { id: 'env', label: '服务器环境准备', desc: 'Node.js 18+ / Docker 运行环境、2C4G+ 配置', done: false },
                    { id: 'net', label: '网络策略配置', desc: '开放 80/443 端口、配置反向代理 (Nginx)、SSL 证书', done: false },
                    { id: 'db', label: '数据持久化方案', desc: '确定 SQLite / PostgreSQL、备份策略、数据目录挂载', done: false },
                    { id: 'key', label: 'AI 模型 API Key', desc: '至少配置一个 LLM 厂商密钥（或对接本地模型 API）', done: false },
                    { id: 'auth', label: '认证体系对接', desc: '确定使用内置账号体系还是对接 LDAP/SSO', done: false },
                    { id: 'cors', label: 'CORS 与安全设置', desc: '配置 CORS_ORIGINS 环境变量、设置 JWT_SECRET', done: false },
                    { id: 'log', label: '日志与监控', desc: '配置审计日志归档、接入 Prometheus/Grafana 监控', done: false },
                    { id: 'test', label: '验收测试', desc: '健康检查通过、端到端流水线测试、压力测试', done: false },
                  ];
                  const [checklist, setChecklist] = React.useState(items.map(i => ({ ...i })));
                  const doneCount = checklist.filter(c => c.done).length;
                  return (
                    <div>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="flex-1 bg-gray-200 rounded-full h-2">
                          <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${(doneCount / checklist.length) * 100}%` }}/>
                        </div>
                        <span className="text-xs font-bold text-gray-500">{doneCount}/{checklist.length}</span>
                      </div>
                      <div className="space-y-2">
                        {checklist.map((item, idx) => (
                          <label key={item.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 cursor-pointer hover:bg-gray-100 transition-colors">
                            <input type="checkbox" checked={item.done} onChange={() => setChecklist(prev => prev.map((c, i) => i === idx ? { ...c, done: !c.done } : c))} className="mt-0.5 accent-green-600"/>
                            <div className="flex-1">
                              <span className={`font-bold text-sm ${item.done ? 'text-green-700 line-through' : 'text-gray-800'}`}>{item.label}</span>
                              <p className="text-xs text-gray-400">{item.desc}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="p-6 border-2 border-dashed border-indigo-200 rounded-2xl bg-indigo-50/50 text-center">
                <Cloud className="mx-auto text-indigo-300 mb-3" size={40} />
                <p className="text-sm font-bold text-indigo-600 mb-1">需要私有化部署？</p>
                <p className="text-xs text-indigo-400">请联系我们的企业销售团队获取定制化部署方案与报价：enterprise@zdf.ai</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

// --- 密码修改组件 ---
const PasswordChangeForm = () => {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const handleSubmit = async () => {
    setMsg('');
    if (!oldPw || !newPw) return setMsg('请填写旧密码和新密码');
    if (newPw.length < 6) return setMsg('新密码至少 6 位');
    try {
      const res = await fetch(`${API_BASE_URL}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (data.ok) { setOk(true); setMsg('密码修改成功'); setOldPw(''); setNewPw(''); }
      else setMsg(data.error || '修改失败');
    } catch { setMsg('网络错误，请检查后端是否运行'); }
  };
  return (
    <div className="space-y-4 max-w-sm">
      <input type="password" placeholder="当前密码" className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-indigo-500" value={oldPw} onChange={e => setOldPw(e.target.value)} />
      <input type="password" placeholder="新密码（至少 6 位）" className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-indigo-500" value={newPw} onChange={e => setNewPw(e.target.value)} />
      {msg && <p className={`text-xs font-bold ${ok ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
      <button onClick={handleSubmit} className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 transition-colors">修改密码</button>
    </div>
  );
};

const ApiKeyManager = ({ plan }) => {
  const [keys, setKeys] = useState([]);
  const [allowed, setAllowed] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(true);
  const token = window.sessionStorage.getItem('token') || '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchKeys = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/user/api-keys`, { headers });
      const data = await res.json();
      if (data.ok) { setKeys(data.keys || []); setAllowed(data.allowed !== false); }
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchKeys(); }, []);

  const createKey = async () => {
    const res = await fetch(`${API_BASE_URL}/user/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: newKeyName }) });
    const data = await res.json();
    if (data.ok) { setNewKey(data.apiKey); setNewKeyName(''); fetchKeys(); }
    else alert(data.error || '创建失败');
  };

  const deleteKey = async (keyPrefix) => {
    if (!confirm('确定删除此 API Key？')) return;
    await fetch(`${API_BASE_URL}/user/api-keys/${keyPrefix}`, { method: 'DELETE', headers });
    fetchKeys();
  };

  if (loading) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-gray-100">
        <h3 className="font-bold text-gray-800 flex items-center gap-2"><Key size={18} className="text-indigo-500"/> API Key 管理</h3>
      </div>
      <div className="p-6">
        {!allowed ? (
          <p className="text-sm text-gray-500">API 访问需要 Pro 或以上套餐。<span className="text-indigo-600 font-bold">请联系管理员升级。</span></p>
        ) : (
          <div className="space-y-4">
            {newKey && (
              <div className="p-4 bg-green-50 border border-green-200 rounded-xl">
                <p className="text-xs font-bold text-green-700 mb-1">新 Key 已创建（仅显示一次，请妥善保存）:</p>
                <code className="text-xs bg-green-100 px-2 py-1 rounded select-all break-all">{newKey}</code>
                <button onClick={() => { navigator.clipboard?.writeText(newKey); }} className="ml-2 text-xs text-green-600 underline">复制</button>
              </div>
            )}
            <div className="flex gap-2">
              <input type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="Key 名称（可选）" className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-indigo-500" />
              <button onClick={createKey} className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 flex items-center gap-1"><Plus size={14} /> 创建 Key</button>
            </div>
            {keys.length > 0 ? (
              <div className="space-y-2">
                {keys.map(k => (
                  <div key={k.key} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl text-sm">
                    <div>
                      <span className="font-bold text-gray-700">{k.name}</span>
                      <code className="ml-2 text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">{k.key}</code>
                      <span className="ml-2 text-[10px] text-gray-400">{k.lastUsed ? `最后使用: ${new Date(k.lastUsed).toLocaleDateString()}` : '未使用'}</span>
                    </div>
                    <button onClick={() => deleteKey(k.key.split('...')[0])} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-gray-400">暂无 API Key，点击"创建 Key"生成</p>}
            <div className="mt-4 p-4 bg-gray-50 rounded-xl">
              <p className="text-xs font-bold text-gray-600 mb-2">API 使用示例:</p>
              <code className="text-[11px] text-gray-500 block whitespace-pre">{`curl -X POST ${window.location.origin}/api/ai/generate \\
  -H "Authorization: Bearer zdf_ak_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"你的问题","dispatch":{"vendor":"deepseek","model":"deepseek-chat"}}'`}</code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- 模块 3：前端用户工作台 ---
const UserApp = ({ auth, onLogout, isTestMode, dbKeys, onSwitchToAdmin, onUpdateAuth, dbUsers, vendors, strategy }) => {
  const [activeTab, setActiveTab] = useState('dispatch'); 
  const [showAdminAuth, setShowAdminAuth] = useState(false);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAuthError, setAdminAuthError] = useState('');

  const [configs, setConfigs] = useState({
    A: { vendor: 'deepseek', model: 'deepseek-v4-pro', mode: 'platform', key: '' },
    B: { vendor: 'alibaba', model: 'qwen-max', mode: 'platform', key: '' },
    C: { vendor: 'anthropic', model: 'claude-sonnet-4-6', mode: 'platform', key: '' },
    D: { vendor: 'openai', model: 'gpt-4.1', mode: 'platform', key: '' },
  });
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [results, setResults] = useState({ A: "", B: "", C: "", D: "", final: "" });
  const [showComplete, setShowComplete] = useState(false);
  const [scores, setScores] = useState({ A: 0, B: 0, C: 0, D: 0 });
  const [history, setHistory] = useState([]);
  const [resultTab, setResultTab] = useState('final');
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [historySearch, setHistorySearch] = useState('');
  const todayKey = `zdf_tasks_${auth.id}_${new Date().toDateString()}`;
  const creditKey = `zdf_credits_${auth.id}_${new Date().toDateString()}`;
  const [dailyTasksUsed, setDailyTasksUsed] = useState(() => parseInt(sessionStorage.getItem(todayKey) || '0', 10));
  const [creditsUsed, setCreditsUsed] = useState(() => parseInt(sessionStorage.getItem(creditKey) || '0', 10));
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [tplCategory, setTplCategory] = useState('all');
  const [useRag, setUseRag] = useState(false);
  const [ragDocs, setRagDocs] = useState([]);
  const [ragStorage, setRagStorage] = useState({ usedBytes: 0, quotaMB: -1 });
  const [ragUploading, setRagUploading] = useState(false);
  const ragFileRef = useRef(null);
  const [userUsageData, setUserUsageData] = useState(null);
  const [editName, setEditName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [showUpgradeForm, setShowUpgradeForm] = useState(false);
  const [upgradeTarget, setUpgradeTarget] = useState('pro');
  const [upgradeMsg, setUpgradeMsg] = useState('');
  const [upgradeSubmitting, setUpgradeSubmitting] = useState(false);
  const [myUpgradeRequests, setMyUpgradeRequests] = useState([]);
  const [upgradePrompt, setUpgradePrompt] = useState(null);

  const fetchRagDocs = () => {
    fetch(`${API_BASE_URL}/rag/docs`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.docs) { setRagDocs(d.docs); if (d.storage) setRagStorage(d.storage); } })
      .catch(() => {});
  };

  useEffect(() => {
    fetch(`${API_BASE_URL}/prompt-templates`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.templates) setTemplates(d.templates); })
      .catch(() => {});
    fetchRagDocs();
    // 获取用户使用数据 (趋势图 + 同步今日计数器)
    fetch(`${API_BASE_URL}/user/usage`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setUserUsageData(d);
          if (d.today) {
            setDailyTasksUsed(d.today.tasks || 0);
            setCreditsUsed(d.today.credits || 0);
            sessionStorage.setItem(todayKey, String(d.today.tasks || 0));
            sessionStorage.setItem(creditKey, String(d.today.credits || 0));
          }
        }
      })
      .catch(() => {});
    fetch(`${API_BASE_URL}/user/upgrade-requests`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.requests) setMyUpgradeRequests(d.requests); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API_BASE_URL}/user/history`, { headers: { 'Authorization': `Bearer ${window.sessionStorage.getItem('token')}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if(data?.history) setHistory(data.history); })
      .catch(() => console.warn("无法连接到后端加载历史记录"));
  }, []);

  useEffect(() => {
    if (showComplete) {
      const timer = setTimeout(() => setShowComplete(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [showComplete]);

  const RoleConfigUser = ({ role, config, onUpdate }) => {
    const currentVendor = vendors.find(v => v.id === config.vendor) || vendors[0];
    return (
      <div className="p-4 border-b border-gray-100 last:border-0 hover:bg-gray-50">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded">{role.icon}</div>
          <div><h4 className="text-sm font-bold text-gray-800">{role.id} · {role.name}</h4></div>
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            <select className="w-1/2 text-xs p-2 border rounded bg-white" value={config.vendor} onChange={(e) => { const vendor = vendors.find(v => v.id === e.target.value); onUpdate(role.id, { vendor: e.target.value, model: vendor.models[0] }); }}>
              <optgroup label="海外厂商">{vendors.filter(v => v.region === 'US').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup>
              <optgroup label="国内厂商">{vendors.filter(v => v.region === 'CN').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup>
              {vendors.some(v => v.region === 'LOCAL') && <optgroup label="本地模型">{vendors.filter(v => v.region === 'LOCAL').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup>}
            </select>
            <select className="w-1/2 text-[11px] p-2 border rounded bg-white" value={config.model} onChange={(e) => onUpdate(role.id, { model: e.target.value })}>{currentVendor.models.map(m => <option key={m} value={m}>{m}</option>)}</select>
          </div>
          <select className="w-full text-xs p-2 border rounded bg-white" value={config.mode} onChange={(e) => onUpdate(role.id, { mode: e.target.value })}>
            <option value="platform">⚡ 平台内置 API</option>
            <option value="self">🔑 自带 API Key</option>
          </select>
          {config.mode === 'self' && <input type="password" placeholder="输入 API Key" className="w-full text-xs p-2 border rounded" value={config.key} onChange={(e) => onUpdate(role.id, { key: e.target.value })} />}
        </div>
      </div>
    );
  };

  /** 计算各步骤质量分 (0-100) */
  const calcScores = (r) => {
    const lenScore = (t) => Math.min(100, Math.max(20, Math.round(Math.log(Math.max(1, t.length)) * 10)));
    const overlap = (a, b) => {
      if (!a || !b) return 0;
      const wa = new Set(a.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean));
      const wb = new Set(b.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean));
      let shared = 0; wa.forEach(w => { if (wb.has(w)) shared++; });
      return wa.size > 0 ? shared / wa.size : 0;
    };
    const sa = lenScore(r.A || '');
    const sb = r.B ? Math.min(100, Math.round(lenScore(r.B) * 0.6 + overlap(r.A, r.B) * 40)) : 0;
    const sc = r.C ? Math.min(100, Math.round(lenScore(r.C) * 0.5 + (1 - overlap(r.B, r.C)) * 30 + 20)) : 0;
    const sd = r.D ? Math.min(100, Math.round(lenScore(r.D) * 0.4 + overlap(r.A, r.D) * 30 + 30)) : 0;
    return { A: sa, B: sb, C: sc, D: sd };
  };

  const handleDownload = async (format) => {
    if (!results.final) return;
    const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
    if (!limits.canExport) {
      setUpgradePrompt({ title: '导出需要 Pro 版', desc: '升级到 Pro 即可导出 Word / PDF / HTML 等格式，随时保存和分享 AI 输出结果。', feature: 'export' });
      return;
    }
    const token = window.sessionStorage.getItem('token') || '';
    // 服务端导出（PDF / DOCX）
    if (format === 'pdf' || format === 'doc') {
      const endpoint = format === 'pdf' ? 'user/export-pdf' : 'user/export-docx';
      const ext = format === 'pdf' ? 'pdf' : 'docx';
      try {
        const r = await fetch(`${API_BASE_URL}/${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || '导出失败'); return; }
        const blob = await r.blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ZDF_${Date.now()}.${ext}`; a.click(); URL.revokeObjectURL(a.href);
      } catch { alert('导出失败，请检查网络'); }
      return;
    }
    const text = results.final;
    const ts = new Date().toLocaleString();
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const htmlTpl = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ZDF.AI 输出</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;line-height:1.8;color:#222}h1{font-size:20px}p.ts{color:#888;font-size:13px}pre{white-space:pre-wrap;word-break:break-word}@media print{body{margin:0}}</style></head><body><h1>ZDF.AI 输出</h1><p class="ts">${ts}</p><hr><pre>${esc(text)}</pre></body></html>`;
    const configs = {
      txt:  { content: text,     mime: 'text/plain',         ext: 'txt' },
      md:   { content: text,     mime: 'text/markdown',      ext: 'md'  },
      html: { content: htmlTpl,  mime: 'text/html',          ext: 'html'},
    };
    const cfg = configs[format];
    if (!cfg) return;
    const blob = new Blob([cfg.content], { type: cfg.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ZDF_${Date.now()}.${cfg.ext}`;
    a.click(); URL.revokeObjectURL(url);
  };
  const handleShare = () => { navigator.clipboard.writeText(results.final); alert("已复制纯净结果！"); };

  const handleFileChange = (e) => {
    Array.from(e.target.files).forEach(file => {
      const isImage = file.type.startsWith('image/');
      const isText = ['text/plain','text/csv','text/markdown'].includes(file.type) || /\.(txt|csv|md)$/i.test(file.name);
      const reader = new FileReader();
      if (isImage) {
        reader.onload = (ev) => setAttachments(prev => [...prev, { id: Date.now()+Math.random(), name: file.name, type: file.type, isImage: true, data: ev.target.result.split(',')[1] }]);
        reader.readAsDataURL(file);
      } else if (isText) {
        reader.onload = (ev) => setAttachments(prev => [...prev, { id: Date.now()+Math.random(), name: file.name, type: file.type, isImage: false, isText: true, data: ev.target.result }]);
        reader.readAsText(file);
      } else {
        setAttachments(prev => [...prev, { id: Date.now()+Math.random(), name: file.name, type: file.type, isImage: false, isText: false, data: null }]);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * 将当前角色面板上的厂商/模型打包给后端，用于多模型路由。
   * @param {'A'|'B'|'C'|'D'} roleId
   */
  const buildDispatch = (roleId) => {
    const c = configs[roleId];
    return {
      roleId,
      vendor: c.vendor,
      model: c.model,
      mode: c.mode,
      ...(c.mode === 'self' && c.key ? { selfKey: c.key } : {}),
    };
  };

  const runPipeline = async () => {
    if (!question.trim() && attachments.length === 0) return;
    const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
    if (limits.dailyTasks > 0 && dailyTasksUsed >= limits.dailyTasks) {
      setUpgradePrompt({ title: '今日任务已达上限', desc: `您已使用 ${limits.dailyTasks} 次任务额度。升级到 Pro 可获取每日 500 次任务、RAG 知识库、文件导出等专业能力。`, feature: 'tasks' });
      return;
    }
    setIsRunning(true);
    setShowComplete(false);
    setResultTab('final');
    const newResults = { A: '', B: '', C: '', D: '', final: '' };

    try {
      setCurrentStep('A');
      const ragExtra = useRag ? { useRag: true, creditCost: CREDIT_COSTS.rag } : { creditCost: 0 };
      newResults.A = await callGemini(question, '直接回答用户问题。', attachments, buildDispatch('A'), ragExtra);
      setResults({ ...newResults });

      setCurrentStep('B');
      newResults.B = await callGemini(
        `问题: ${question}\n初稿:\n${newResults.A}\n任务: 事实校核。`,
        '你是一个严格的事实校核员。',
        attachments,
        buildDispatch('B'),
        { creditCost: 0 },
      );
      setResults({ ...newResults });

      setCurrentStep('C');
      newResults.C = await callGemini(
        `校核稿:\n${newResults.B}\n任务: 润色。`,
        '你是一个专业的审核专家。',
        attachments,
        buildDispatch('C'),
        { creditCost: 0 },
      );
      setResults({ ...newResults });

      setCurrentStep('D');
      const resD = await callGemini(
        `原始问题: ${question}\n\n阶段A（生成者）输出:\n${newResults.A}\n\n阶段B（校核者）输出:\n${newResults.B}\n\n阶段C（审核者）输出:\n${newResults.C}\n\n任务: 作为终审者，根据策略输出最终纯文本结果。`,
        '',
        attachments,
        buildDispatch('D'),
        { strategy, creditCost: CREDIT_COSTS.pipeline },
      );
      newResults.D = stripMarkdown(resD);
      newResults.final = newResults.D;
      setShowComplete(true);
      setScores(calcScores(newResults));

      setResults({ ...newResults });
      const histEntry = {
        id: Date.now(),
        question,
        answer: newResults.D,
        timestamp: new Date().toLocaleTimeString(),
        strategyName: STRATEGIES.find((s) => s.id === strategy).name,
      };
      setHistory((prev) => [histEntry, ...prev]);
      // 从后端重新获取准确的使用量计数
      try {
        const usageRes = await fetch(`${API_BASE_URL}/user/usage`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } });
        if (usageRes.ok) {
          const ud = await usageRes.json();
          if (ud.today) {
            setDailyTasksUsed(ud.today.tasks || 0);
            setCreditsUsed(ud.today.credits || 0);
            sessionStorage.setItem(todayKey, String(ud.today.tasks || 0));
            sessionStorage.setItem(creditKey, String(ud.today.credits || 0));
          }
        }
      } catch { /* 回退: 保持当前本地值 */ }
      fetch(`${API_BASE_URL}/user/history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ entry: histEntry }),
      }).catch(() => console.warn('写入服务端历史失败'));
    } catch (err) {
      if (err?.message?.startsWith('__UPGRADE__:')) {
        const msg = err.message.replace('__UPGRADE__:', '');
        setUpgradePrompt({ title: '需要升级套餐', desc: msg || '当前套餐不支持此功能，升级后即可使用。', feature: 'model' });
      } else {
        console.error(err);
      }
    } finally {
      setIsRunning(false);
      setCurrentStep(null);
    }
  };

  const handleAdminAuth = async () => {
    setAdminAuthError('');
    if (!adminUsername || !adminPassword) {
      setAdminAuthError('请输入管理员账号和密码');
      return;
    }
    try {
      const r = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsername, password: adminPassword }),
      });
      const data = await r.json();
      if (!r.ok) { setAdminAuthError(data.error || '认证失败'); return; }
      if (data.user?.role !== 'admin') { setAdminAuthError('该账号不是管理员'); return; }
      window.sessionStorage.setItem('token', data.token);
      setShowAdminAuth(false);
      onSwitchToAdmin(data.user);
    } catch {
      setAdminAuthError('无法连接后端服务，请检查网络');
    }
  };

  const attemptSwitchToAdmin = () => {
    if (auth.originalRole === 'admin') {
      onSwitchToAdmin({ ...auth, role: 'admin' });
    } else {
      setShowAdminAuth(true);
    }
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans overflow-hidden">
      
      {showAdminAuth && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl p-8">
            <div className="text-center mb-6">
              <ShieldCheck className="mx-auto text-indigo-600 mb-2" size={32} />
              <h2 className="text-xl font-bold text-gray-800">安全提权验证</h2>
              <p className="text-xs text-gray-500 mt-1">进入后台需验证高权限账号</p>
            </div>
            
            <div className="space-y-4">
              {adminAuthError && <div className="text-xs font-bold text-red-600 bg-red-50 p-2 rounded-lg text-center">{adminAuthError}</div>}
              <input type="text" placeholder="管理员账号" value={adminUsername} onChange={e=>setAdminUsername(e.target.value)} className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-indigo-500 text-sm" onKeyDown={e=>e.key==='Enter'&&handleAdminAuth()}/>
              <input type="password" placeholder="管理员密码" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)} className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-indigo-500 text-sm" onKeyDown={e=>e.key==='Enter'&&handleAdminAuth()}/>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowAdminAuth(false)} className="flex-1 py-3 bg-gray-100 text-gray-700 font-bold rounded-xl hover:bg-gray-200 transition-colors">取消</button>
                <button onClick={handleAdminAuth} className="flex-1 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-md transition-colors">验证并进入</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {upgradePrompt && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4" onClick={() => setUpgradePrompt(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-6 text-white text-center">
              <Crown size={36} className="mx-auto mb-2 opacity-90"/>
              <h3 className="text-xl font-black">{upgradePrompt.title}</h3>
              <p className="text-sm text-amber-100 mt-2">{upgradePrompt.desc}</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                {[
                  { label: '500 次/日', sub: '任务额度', icon: '🚀' },
                  { label: 'RAG 知识库', sub: '文档增强', icon: '📚' },
                  { label: '导出分享', sub: 'Word/PDF', icon: '📄' },
                ].map(f => (
                  <div key={f.label} className="p-3 bg-gray-50 rounded-xl">
                    <div className="text-lg mb-1">{f.icon}</div>
                    <div className="text-xs font-black text-gray-700">{f.label}</div>
                    <div className="text-[10px] text-gray-400">{f.sub}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setUpgradePrompt(null); setActiveTab('profile'); setShowUpgradeForm(true); setUpgradeTarget('pro'); }}
                  className="flex-1 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-black rounded-xl shadow-lg hover:shadow-xl transition-all text-sm">
                  升级 Pro · ¥199/月
                </button>
                <button onClick={() => setUpgradePrompt(null)} className="px-5 py-3 bg-gray-100 text-gray-500 font-bold rounded-xl hover:bg-gray-200 text-sm">
                  稍后
                </button>
              </div>
              <p className="text-[10px] text-gray-400 text-center">7 天免费试用 · 随时取消 · 即刻生效</p>
            </div>
          </div>
        </div>
      )}

      <aside className="w-16 flex flex-col items-center py-6 bg-indigo-900 text-indigo-100 gap-8 z-20">
        <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-indigo-900 font-black">⟳</div>
        <nav className="flex flex-col gap-6 w-full px-2">
          <button onClick={() => setActiveTab('dispatch')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'dispatch' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="调度中心"><Activity size={22} /></button>
          <button onClick={() => setActiveTab('history')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'history' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="历史记录"><Clock size={22} /></button>
          <button onClick={() => setActiveTab('profile')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'profile' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="账户设置"><Settings size={22} /></button>
          <button onClick={() => setActiveTab('rag')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'rag' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="知识库"><Database size={22} /></button>

          <div className="w-8 h-[1px] bg-indigo-800 mx-auto my-2"></div>
          
          <button 
            onClick={attemptSwitchToAdmin} 
            className="w-full py-3 flex justify-center rounded-xl transition-all hover:bg-indigo-800 text-amber-300" 
            title="进入管理控制台 (需要密码)"
          >
            <ShieldCheck size={22} />
          </button>
        </nav>
        <button onClick={onLogout} className="mt-auto p-3 hover:text-red-300 transition-colors" title="退出账号"><LogOut size={24} /></button>
      </aside>

      {activeTab === 'dispatch' && (
        <>
          <aside className="w-80 bg-white border-r border-gray-200 flex flex-col overflow-y-auto z-10">
            <div className="p-4 border-b border-gray-100"><h2 className="font-bold flex items-center gap-2"><Zap size={18} className="text-amber-500" /> 调度设置</h2></div>
            <div className="flex-1 flex flex-col">
              {ROLES.map(role => <RoleConfigUser key={role.id} role={role} config={configs[role.id]} onUpdate={(id, part) => setConfigs(p => ({ ...p, [id]: { ...p[id], ...part } }))} />)}
            </div>
            <div className="p-4 bg-gray-50 border-t border-gray-100">
              <label className="text-xs font-bold text-gray-400 block mb-1">终审策略</label>
              <div className="text-sm font-bold text-indigo-600">{(STRATEGIES.find(s => s.id === strategy) || STRATEGIES[0]).name}</div>
            </div>
          </aside>

          <main className="flex-1 flex flex-col relative">
            <header className="h-14 px-6 flex items-center justify-between border-b border-gray-200 bg-white">
              <span className="text-xs font-bold text-gray-600 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500"></span>在线计算网络</span>
              <div className="flex items-center gap-3">
                {(() => {
                  const lim = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
                  if (lim.dailyTasks <= 0) return null;
                  const pct = Math.min(100, Math.round(dailyTasksUsed / lim.dailyTasks * 100));
                  return (
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-400' : 'bg-green-400'}`} style={{ width: `${pct}%` }}/>
                      </div>
                      <span className={`text-[10px] font-bold ${pct >= 90 ? 'text-red-500' : 'text-gray-400'}`}>{dailyTasksUsed}/{lim.dailyTasks}</span>
                    </div>
                  );
                })()}
                <span className="px-2 py-1 bg-indigo-50 text-indigo-600 text-xs font-bold rounded uppercase border border-indigo-100">{auth.plan} 会员</span>
                {auth.plan === 'free' && (
                  <button onClick={() => { setActiveTab('profile'); setShowUpgradeForm(true); setUpgradeTarget('pro'); }}
                    className="px-2.5 py-1 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-black rounded-lg shadow hover:shadow-md transition-all">
                    升级 Pro
                  </button>
                )}
                <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs">{auth.name[0]}</div>
              </div>
            </header>
            
            <div className="flex-1 p-6 overflow-y-auto pb-32">
              {!isRunning && !results.A && auth.plan === 'free' && (
                <div className="max-w-4xl mx-auto mb-6">
                  <div className="bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center"><Crown size={20} className="text-amber-500"/></div>
                      <div>
                        <p className="font-bold text-sm text-gray-800">升级 Pro 解锁完整能力</p>
                        <p className="text-xs text-gray-500 mt-0.5">500 次/日 · Claude/GPT-4o 全模型 · RAG 知识库 · 文件导出 · API 接口</p>
                      </div>
                    </div>
                    <button onClick={() => { setActiveTab('profile'); setShowUpgradeForm(true); setUpgradeTarget('pro'); }}
                      className="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-black rounded-xl shadow hover:shadow-md transition-all whitespace-nowrap">
                      ¥199/月 起
                    </button>
                  </div>
                </div>
              )}
              { (isRunning || results.A) && (
                <div className="max-w-4xl mx-auto">
                  <div className="bg-white border border-gray-200 rounded-3xl shadow-lg overflow-hidden">
                    <div className="flex border-b border-gray-100 bg-gray-50">
                      <button onClick={()=>setResultTab('final')} className={`px-6 py-4 text-sm font-bold ${resultTab==='final'?'border-b-2 border-indigo-600 text-indigo-600':'text-gray-500'}`}>最终结果</button>
                      <button onClick={()=>setResultTab('steps')} className={`px-6 py-4 text-sm font-bold ${resultTab==='steps'?'border-b-2 border-indigo-600 text-indigo-600':'text-gray-500'}`}>推理过程</button>
                    </div>
                    <div className="p-8">
                      {isRunning && !results.final && <PipelineAnimation currentStep={currentStep} configs={configs} results={results} vendors={vendors} isComplete={false} />}
                      {showComplete && results.final && resultTab==='final' && <PipelineAnimation currentStep={null} configs={configs} results={results} vendors={vendors} isComplete={true} />}
                      {results.final && resultTab==='final' && (
                        <div className="text-gray-800 leading-relaxed whitespace-pre-wrap">{results.final}
                          <div className="mt-8 pt-4 border-t border-gray-100 flex flex-wrap gap-2">
                            <button onClick={()=>handleDownload('doc')} className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded text-xs font-bold"><Download size={14} className="inline mr-1"/>Word</button>
                            <button onClick={()=>handleDownload('txt')} className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded text-xs font-bold"><Download size={14} className="inline mr-1"/>TXT</button>
                            <button onClick={()=>handleDownload('md')} className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded text-xs font-bold"><Download size={14} className="inline mr-1"/>Markdown</button>
                            <button onClick={()=>handleDownload('html')} className="px-3 py-1.5 bg-green-50 text-green-700 rounded text-xs font-bold"><Download size={14} className="inline mr-1"/>网页</button>
                            <button onClick={()=>handleDownload('pdf')} className="px-3 py-1.5 bg-red-50 text-red-600 rounded text-xs font-bold"><Download size={14} className="inline mr-1"/>PDF</button>
                            <button onClick={handleShare} className="px-3 py-1.5 bg-gray-50 text-gray-600 rounded text-xs font-bold"><Share2 size={14} className="inline mr-1"/>复制</button>
                          </div>
                        </div>
                      )}
                      {results.final && resultTab==='steps' && (
                        <div className="space-y-4">
                          {ROLES.map(r => (
                            <div key={r.id} className="p-4 bg-gray-50 rounded-lg text-sm text-gray-700">
                              <div className="flex items-center justify-between mb-2">
                                <strong className="text-gray-800">{r.id} · {r.name}</strong>
                                {scores[r.id] > 0 && (
                                  <div className="flex items-center gap-2">
                                    <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full transition-all ${scores[r.id] >= 80 ? 'bg-green-500' : scores[r.id] >= 50 ? 'bg-amber-500' : 'bg-red-400'}`} style={{width: `${scores[r.id]}%`}} />
                                    </div>
                                    <span className={`text-xs font-bold ${scores[r.id] >= 80 ? 'text-green-600' : scores[r.id] >= 50 ? 'text-amber-600' : 'text-red-500'}`}>{scores[r.id]}分</span>
                                  </div>
                                )}
                              </div>
                              <div className="whitespace-pre-wrap">{results[r.id]}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
              <div className="max-w-4xl mx-auto bg-white border border-gray-300 rounded-3xl shadow-lg focus-within:border-indigo-500 overflow-hidden flex flex-col">
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-4 pt-3">
                    {attachments.map(att => (
                      <span key={att.id} className="flex items-center gap-1 px-2 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-medium border border-indigo-100 max-w-[200px]">
                        {att.isImage ? <Image size={12} className="shrink-0"/> : <FileText size={12} className="shrink-0"/>}
                        <span className="truncate">{att.name}</span>
                        <button onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} className="ml-1 text-indigo-300 hover:text-red-500 shrink-0"><X size={11}/></button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea placeholder="按 Enter 发送，Shift+Enter 换行" className="w-full h-24 p-4 outline-none resize-none" value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!isRunning)runPipeline();}}}/>
                <div className="flex justify-between items-center bg-gray-50 p-2 pl-4 border-t border-gray-100">
                  <div className="flex items-center gap-1">
                    <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.md" multiple/>
                    <button onClick={()=>fileInputRef.current?.click()} className="p-2 text-gray-500 hover:text-indigo-600" title="上传文件"><Paperclip size={18}/></button>
                    <button onClick={()=>setShowTemplates(!showTemplates)} className={`p-2 ${showTemplates ? 'text-indigo-600' : 'text-gray-500'} hover:text-indigo-600`} title="Prompt 模板库"><BookOpen size={18}/></button>
                    {(PLAN_LIMITS[auth.plan] || {}).canRag && ragDocs.length > 0 ? (
                      <button onClick={()=>setUseRag(!useRag)} className={`px-2 py-1 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors ${useRag ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300' : 'text-gray-400 hover:text-indigo-500'}`} title="启用知识库增强">
                        <Database size={14}/> RAG {useRag ? 'ON' : 'OFF'}
                      </button>
                    ) : auth.plan === 'free' ? (
                      <button onClick={() => setUpgradePrompt({ title: 'RAG 知识库需要 Pro 版', desc: '上传您的文档，AI 将自动检索相关内容来增强回答质量。升级 Pro 立即解锁。', feature: 'rag' })}
                        className="px-2 py-1 rounded-lg text-xs font-bold flex items-center gap-1 text-gray-300 hover:text-amber-500 transition-colors" title="RAG 知识库 (Pro)">
                        <Lock size={12}/> <Database size={14}/> RAG
                      </button>
                    ) : null}
                  </div>
                  <button onClick={runPipeline} disabled={isRunning} className="px-5 py-2 bg-indigo-600 text-white rounded-xl font-bold flex items-center gap-2 disabled:opacity-50"><Send size={14}/> 发送</button>
                </div>
                {showTemplates && (
                  <div className="border-t border-gray-100 bg-gray-50 p-4 max-h-64 overflow-y-auto">
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-xs font-bold text-gray-500">模板分类:</span>
                      {['all', ...new Set(templates.map(t => t.category))].map(cat => (
                        <button key={cat} onClick={() => setTplCategory(cat)} className={`px-2 py-0.5 text-xs rounded-full ${tplCategory === cat ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>{cat === 'all' ? '全部' : cat}</button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {templates.filter(t => tplCategory === 'all' || t.category === tplCategory).map(tpl => (
                        <button key={tpl.id} onClick={() => { setQuestion(tpl.prompt.replace('{input}', '')); setShowTemplates(false); }} className="text-left p-3 bg-white rounded-xl border border-gray-200 hover:border-indigo-300 hover:shadow-sm transition-all">
                          <div className="font-bold text-sm text-gray-800">{tpl.title}</div>
                          <div className="text-xs text-gray-500 mt-0.5">{tpl.desc}</div>
                          <span className={`mt-1 inline-block text-[10px] px-1.5 py-0.5 rounded-full ${tpl.plan === 'free' ? 'bg-gray-100 text-gray-600' : tpl.plan === 'pro' ? 'bg-indigo-100 text-indigo-600' : 'bg-purple-100 text-purple-600'}`}>{tpl.plan}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
        </>
      )}

      {activeTab === 'history' && (
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧列表 */}
          <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-bold flex items-center gap-2 mb-3"><Clock size={18} className="text-indigo-500"/> 历史记录 <span className="ml-auto text-xs text-gray-400 font-normal">{history.length} 条</span></h2>
              <input
                type="text"
                placeholder="搜索问题…"
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
                if (limits.historyDays > 0) return (
                  <div className="mx-3 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                    Free 版仅保留 {limits.historyDays} 天记录 · <span className="font-bold cursor-pointer underline" onClick={() => setActiveTab('profile')}>升级套餐</span>
                  </div>
                );
              })()}
              {history.length === 0 && (
                <div className="text-center text-gray-400 text-sm py-16">暂无历史记录</div>
              )}
              {history
                .filter(h => {
                  const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
                  if (limits.historyDays < 0) return true;
                  return (Date.now() - h.id) < limits.historyDays * 86400000;
                })
                .filter(h => !historySearch || h.question.toLowerCase().includes(historySearch.toLowerCase()))
                .map(h => (
                  <button
                    key={h.id}
                    onClick={() => setSelectedHistoryId(h.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${selectedHistoryId === h.id ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : 'hover:bg-gray-50'}`}
                  >
                    <p className="text-sm font-medium text-gray-800 line-clamp-2 mb-1">{h.question}</p>
                    <div className="flex items-center gap-2 text-[10px] text-gray-400">
                      <Clock size={10}/>{h.timestamp}
                      <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">{h.strategyName}</span>
                    </div>
                  </button>
                ))
              }
            </div>
          </div>

          {/* 右侧详情 */}
          <div className="flex-1 overflow-y-auto p-8">
            {!selectedHistoryId ? (
              <div className="h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <Clock size={40} className="mx-auto mb-3 opacity-30"/>
                  <p className="text-sm">选择左侧记录查看详情</p>
                </div>
              </div>
            ) : (() => {
              const item = history.find(h => h.id === selectedHistoryId);
              if (!item) return null;
              return (
                <div className="max-w-3xl mx-auto">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Clock size={12}/>{item.timestamp}
                      <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded font-medium">{item.strategyName}</span>
                    </div>
                    <button
                      onClick={() => { setQuestion(item.question); setActiveTab('dispatch'); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors"
                    >
                      <ArrowRight size={12}/> 重新提问
                    </button>
                  </div>
                  <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-5 mb-6">
                    <p className="text-xs font-bold text-indigo-400 mb-2">问题</p>
                    <p className="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">{item.question}</p>
                  </div>
                  <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 mb-3">答案</p>
                    <div className="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">{item.answer}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {activeTab === 'profile' && (() => {
        const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
        const currentPlan = PLANS.find(p => p.id === auth.plan) || PLANS[0];
        const taskPct = limits.dailyTasks > 0 ? Math.min(100, Math.round(dailyTasksUsed / limits.dailyTasks * 100)) : 0;
        const visibleHistory = history.filter(h => limits.historyDays < 0 || (Date.now() - h.id) < limits.historyDays * 86400000);
        return (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-4xl mx-auto space-y-8">
              <h2 className="text-2xl font-black text-gray-800">用户中心</h2>

              {/* 当前套餐卡片 */}
              <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 rounded-3xl p-6 text-white shadow-lg">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-indigo-200 text-xs font-bold uppercase tracking-wider mb-1">当前套餐</p>
                    <h3 className="text-2xl font-black">{currentPlan.name}</h3>
                    <p className="text-indigo-200 text-sm mt-0.5">{currentPlan.price} · {currentPlan.priceEn}</p>
                  </div>
                  <Crown size={40} className="text-indigo-300 opacity-60"/>
                </div>
                <div className="grid grid-cols-4 gap-4 mt-4">
                  {[
                    { label: '今日任务', value: `${dailyTasksUsed}${limits.dailyTasks > 0 ? ` / ${limits.dailyTasks}` : ' / ∞'}`, sub: limits.dailyTasks > 0 ? `${taskPct}%` : '无限制' },
                    { label: 'Credits 已用', value: creditsUsed, sub: `${PIPELINE_CREDITS} Credits/次` },
                    { label: '历史记录', value: `${visibleHistory.length} 条`, sub: limits.historyDays > 0 ? `保留 ${limits.historyDays} 天` : '永久保留' },
                    { label: '导出权限', value: limits.canExport ? '✓ 开启' : '✗ 不可用', sub: limits.canExport ? 'Word/PDF/HTML' : '需升级 Pro' },
                  ].map(stat => (
                    <div key={stat.label} className="bg-white/10 rounded-2xl p-3 backdrop-blur-sm">
                      <p className="text-indigo-200 text-[10px] font-bold uppercase mb-1">{stat.label}</p>
                      <p className="text-white text-lg font-black">{stat.value}</p>
                      <p className="text-indigo-300 text-[10px] mt-0.5">{stat.sub}</p>
                    </div>
                  ))}
                </div>
                {limits.dailyTasks > 0 && (
                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-indigo-200 mb-1">
                      <span>今日任务进度</span><span>{dailyTasksUsed}/{limits.dailyTasks}</span>
                    </div>
                    <div className="w-full bg-white/20 rounded-full h-1.5">
                      <div className="bg-white rounded-full h-1.5 transition-all" style={{ width: `${taskPct}%` }}/>
                    </div>
                  </div>
                )}
              </div>

              {/* 用量预警 */}
              {limits.dailyTasks > 0 && taskPct >= 80 && (
                <div className={`p-4 rounded-2xl border-2 flex items-center gap-3 ${taskPct >= 100 ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'}`}>
                  <AlertTriangle size={20} className={taskPct >= 100 ? 'text-red-500' : 'text-amber-500'} />
                  <div>
                    <p className={`text-sm font-bold ${taskPct >= 100 ? 'text-red-700' : 'text-amber-700'}`}>
                      {taskPct >= 100 ? '今日任务已达上限！' : `今日任务已使用 ${taskPct}%，即将达到上限`}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {taskPct >= 100 ? '请升级到 Pro 版获取更多任务额度，或等待明日重置。' : `已使用 ${dailyTasksUsed}/${limits.dailyTasks} 次，建议合理规划剩余用量。`}
                    </p>
                  </div>
                </div>
              )}

              {/* 个人资料编辑 */}
              <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <h3 className="font-bold text-gray-800 flex items-center gap-2"><UserCog size={18} className="text-indigo-500"/> 个人资料</h3>
                </div>
                <div className="p-6 space-y-4">
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-500 w-20">用户名</span>
                    <span className="text-sm font-bold text-gray-700">{auth.username}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-500 w-20">显示昵称</span>
                    {editingName ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input value={editName} onChange={e => setEditName(e.target.value)} maxLength={50}
                          className="flex-1 px-3 py-1.5 border rounded-xl text-sm focus:ring-2 focus:ring-indigo-300 outline-none" autoFocus />
                        <button onClick={async () => {
                          if (!editName.trim()) return;
                          try {
                            const r = await fetch(`${API_BASE_URL}/user/profile`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                              body: JSON.stringify({ name: editName.trim() }),
                            });
                            if (r.ok) { onUpdateAuth({ ...auth, name: editName.trim() }); setEditingName(false); }
                          } catch {}
                        }} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700">
                          <Save size={14}/>
                        </button>
                        <button onClick={() => setEditingName(false)} className="px-3 py-1.5 bg-gray-200 text-gray-600 text-xs font-bold rounded-xl hover:bg-gray-300">取消</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-700">{auth.name}</span>
                        <button onClick={() => { setEditName(auth.name || ''); setEditingName(true); }}
                          className="px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded-lg">编辑</button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-500 w-20">套餐</span>
                    <span className="text-sm font-bold text-gray-700">{currentPlan.name}</span>
                  </div>
                </div>
              </div>

              {/* 7日使用趋势 */}
              {userUsageData?.allDays && (
                <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-gray-100">
                    <h3 className="font-bold text-gray-800 flex items-center gap-2"><Activity size={18} className="text-indigo-500"/> 最近 7 天使用趋势</h3>
                  </div>
                  <div className="p-6">
                    <div className="flex items-end gap-2 h-28">
                      {(() => {
                        const days = [];
                        for (let i = 6; i >= 0; i--) {
                          const d = new Date(); d.setDate(d.getDate() - i);
                          const dk = d.toISOString().slice(0, 10);
                          const dd = userUsageData.allDays[dk] || { tasks: 0, credits: 0, tokens: { input: 0, output: 0 } };
                          days.push({ date: dk, ...dd });
                        }
                        const maxT = Math.max(1, ...days.map(x => x.tasks));
                        return days.map(d => {
                          const pct = Math.max(4, (d.tasks / maxT) * 100);
                          return (
                            <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                              <span className="text-[10px] font-bold text-gray-600">{d.tasks}</span>
                              <div className="w-full bg-indigo-100 rounded-t-lg relative" style={{height: `${pct}%`}}>
                                <div className="absolute inset-0 bg-indigo-500 rounded-t-lg opacity-80"/>
                              </div>
                              <span className="text-[10px] text-gray-400">{d.date.slice(5)}</span>
                              <span className="text-[9px] text-gray-400">{((d.tokens?.input || 0) + (d.tokens?.output || 0)).toLocaleString()} tok</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {/* 历史记录导出 */}
              {history.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-gray-100">
                    <h3 className="font-bold text-gray-800 flex items-center gap-2"><Download size={18} className="text-indigo-500"/> 历史记录导出</h3>
                  </div>
                  <div className="p-6 flex items-center gap-4">
                    <p className="text-sm text-gray-500 flex-1">共 {history.length} 条对话记录，可导出为 CSV 或 JSON 格式</p>
                    <button onClick={async () => {
                      try {
                        const r = await fetch(`${API_BASE_URL}/user/export-history?format=csv`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } });
                        if (!r.ok) { const d = await r.json().catch(()=>({})); alert(d.error || '导出失败'); return; }
                        const blob = await r.blob();
                        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zdf_history.csv'; a.click(); URL.revokeObjectURL(a.href);
                      } catch { alert('导出失败，请检查网络'); }
                    }} className="px-4 py-2 bg-emerald-600 text-white text-sm font-bold rounded-xl hover:bg-emerald-700 flex items-center gap-1.5"><Download size={14}/> CSV</button>
                    <button onClick={async () => {
                      try {
                        const r = await fetch(`${API_BASE_URL}/user/export-history?format=json`, { headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } });
                        if (!r.ok) { const d = await r.json().catch(()=>({})); alert(d.error || '导出失败'); return; }
                        const blob = await r.blob();
                        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zdf_history.json'; a.click(); URL.revokeObjectURL(a.href);
                      } catch { alert('导出失败，请检查网络'); }
                    }} className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 flex items-center gap-1.5"><Download size={14}/> JSON</button>
                  </div>
                </div>
              )}

              {/* 套餐升级 + 支付 */}
              {auth.plan !== 'enterprise' && (
                <div className="bg-gradient-to-r from-amber-50 to-orange-50 border-2 border-amber-200 rounded-3xl overflow-hidden">
                  <div className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-black text-gray-800 flex items-center gap-2"><Crown size={20} className="text-amber-500"/> 升级套餐</h3>
                        <p className="text-sm text-gray-500 mt-1">
                          {auth.plan === 'free' ? '解锁 500 次/日任务、RAG 知识库、API 接口、导出功能等专业能力' : '升级到 Enterprise 版，获取无限任务、私有化部署、SLA 支持'}
                        </p>
                      </div>
                      {!showUpgradeForm && !myUpgradeRequests.some(r => r.status === 'pending') && (
                        <button onClick={() => { setUpgradeTarget(auth.plan === 'free' ? 'pro' : 'enterprise'); setShowUpgradeForm(true); }}
                          className="px-6 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-2xl shadow-lg hover:shadow-xl transition-all flex items-center gap-2">
                          <ArrowRight size={16}/> 升级
                        </button>
                      )}
                      {myUpgradeRequests.some(r => r.status === 'pending') && (
                        <span className="px-4 py-2 bg-yellow-100 text-yellow-700 text-sm font-bold rounded-xl">升级申请审核中...</span>
                      )}
                    </div>
                    {showUpgradeForm && (
                      <div className="mt-4 p-4 bg-white rounded-2xl border border-amber-200 space-y-4">
                        <div>
                          <label className="text-xs font-bold text-gray-500 mb-2 block">选择套餐</label>
                          <div className="flex gap-3">
                            {auth.plan === 'free' && (
                              <button onClick={() => setUpgradeTarget('pro')}
                                className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${upgradeTarget === 'pro' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                                <div className="font-black text-gray-800">Pro 专业版</div>
                                <div className="text-xs text-gray-500 mt-1">500 次/日 · RAG · API · 导出</div>
                                <div className="flex gap-2 mt-2">
                                  <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-bold">¥199/月</span>
                                  <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-bold">€29/月</span>
                                </div>
                              </button>
                            )}
                            <button onClick={() => setUpgradeTarget('enterprise')}
                              className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${upgradeTarget === 'enterprise' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                              <div className="font-black text-gray-800">Enterprise 企业版</div>
                              <div className="text-xs text-gray-500 mt-1">无限任务 · 私有化部署 · SLA</div>
                              <div className="mt-2"><span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full font-bold">定制报价</span></div>
                            </button>
                          </div>
                        </div>

                        {upgradeTarget === 'pro' && (
                          <div>
                            <label className="text-xs font-bold text-gray-500 mb-2 block">选择支付方式</label>
                            <div className="grid grid-cols-2 gap-3">
                              <button disabled={upgradeSubmitting} onClick={async () => {
                                setUpgradeSubmitting(true);
                                try {
                                  const r = await fetch(`${API_BASE_URL}/payment/stripe/create-checkout`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                                    body: JSON.stringify({ plan: 'pro' }),
                                  });
                                  const d = await r.json();
                                  if (d.url) { window.location.href = d.url; }
                                  else { alert(d.error || 'Stripe 暂未配置，请联系管理员'); }
                                } catch { alert('网络错误'); }
                                setUpgradeSubmitting(false);
                              }} className="p-3 border-2 border-indigo-200 rounded-xl hover:bg-indigo-50 transition-all disabled:opacity-50">
                                <div className="font-bold text-sm text-indigo-700">Stripe 信用卡</div>
                                <div className="text-[10px] text-gray-400 mt-0.5">Visa / Mastercard / €29/月</div>
                              </button>
                              <button disabled={upgradeSubmitting} onClick={async () => {
                                setUpgradeSubmitting(true);
                                try {
                                  const r = await fetch(`${API_BASE_URL}/payment/alipay/create-order`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                                    body: JSON.stringify({ plan: 'pro' }),
                                  });
                                  const d = await r.json();
                                  if (d.formHtml) {
                                    const w = window.open('', '_blank');
                                    if (w) { w.document.write(d.formHtml); w.document.close(); }
                                    else { alert('请允许弹窗以完成支付宝支付'); }
                                  } else { alert(d.error || '支付宝暂未配置，请联系管理员'); }
                                } catch { alert('网络错误'); }
                                setUpgradeSubmitting(false);
                              }} className="p-3 border-2 border-blue-200 rounded-xl hover:bg-blue-50 transition-all disabled:opacity-50">
                                <div className="font-bold text-sm text-blue-700">支付宝</div>
                                <div className="text-[10px] text-gray-400 mt-0.5">Alipay / ¥199/月</div>
                              </button>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-2 text-center">支付成功后套餐将自动升级 · 支持随时取消</p>
                          </div>
                        )}

                        {upgradeTarget === 'enterprise' && (
                          <div className="space-y-3">
                            <div>
                              <label className="text-xs font-bold text-gray-500 mb-1 block">留言（公司信息、联系方式等）</label>
                              <textarea value={upgradeMsg} onChange={e => setUpgradeMsg(e.target.value)} maxLength={500} rows={2} placeholder="例如：公司名称、联系方式、使用场景..."
                                className="w-full px-3 py-2 border rounded-xl text-sm focus:ring-2 focus:ring-amber-300 outline-none resize-none"/>
                            </div>
                            <button disabled={upgradeSubmitting} onClick={async () => {
                              setUpgradeSubmitting(true);
                              try {
                                const r = await fetch(`${API_BASE_URL}/user/upgrade-request`, {
                                  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
                                  body: JSON.stringify({ toPlan: 'enterprise', message: upgradeMsg }),
                                });
                                const d = await r.json();
                                if (d.ok) {
                                  setMyUpgradeRequests(prev => [d.request, ...prev]);
                                  setShowUpgradeForm(false); setUpgradeMsg('');
                                  alert('企业版升级申请已提交，我们的团队将尽快联系您');
                                } else { alert(d.error || '提交失败'); }
                              } catch { alert('网络错误，请重试'); }
                              setUpgradeSubmitting(false);
                            }} className="w-full px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-bold rounded-xl hover:shadow-lg disabled:opacity-50">
                              {upgradeSubmitting ? '提交中...' : '提交企业版咨询申请'}
                            </button>
                          </div>
                        )}

                        <div className="flex justify-end">
                          <button onClick={() => { setShowUpgradeForm(false); setUpgradeMsg(''); }} className="px-4 py-2 text-gray-500 text-sm font-bold hover:text-gray-700">取消</button>
                        </div>
                      </div>
                    )}
                  </div>
                  {myUpgradeRequests.length > 0 && (
                    <div className="px-6 pb-4">
                      <p className="text-xs font-bold text-gray-500 mb-2">升级记录</p>
                      <div className="space-y-2">
                        {myUpgradeRequests.slice(0, 5).map(r => (
                          <div key={r.id} className="flex items-center gap-3 text-xs bg-white/80 rounded-xl px-3 py-2 border border-amber-100">
                            <span className="text-gray-400">{new Date(r.createdAt).toLocaleDateString()}</span>
                            <span className="font-bold text-gray-700">{r.fromPlan} → {r.toPlan}</span>
                            <span className={`ml-auto px-2 py-0.5 rounded-full font-bold ${r.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : r.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {r.status === 'pending' ? '审核中' : r.status === 'approved' ? '已通过' : '已拒绝'}
                            </span>
                            {r.reviewNote && <span className="text-gray-400 truncate max-w-[150px]" title={r.reviewNote}>{r.reviewNote}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 套餐对比表 */}
              <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <h3 className="font-bold text-gray-800 flex items-center gap-2"><CreditCard size={18} className="text-indigo-500"/> 套餐对比</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="text-left px-6 py-3 text-xs font-bold text-gray-500 uppercase w-1/4">功能</th>
                        {PLANS.map(p => (
                          <th key={p.id} className={`px-6 py-3 text-center text-xs font-bold uppercase ${auth.plan === p.id ? 'text-indigo-600 bg-indigo-50' : 'text-gray-500'}`}>
                            {p.name.split(' ')[0]}
                            {auth.plan === p.id && <span className="ml-1 text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">当前</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {[
                        ['每日任务', '20 次', '500 次', '无限'],
                        ['并发数', '1', '5', '50+'],
                        ['上下文长度', '32K', '256K', '无限'],
                        ['历史记录', '7 天', '永久', '永久'],
                        ['导出 (Word/PDF)', '✗', '✓', '✓'],
                        ['API 接口', '✗', '✓', '✓'],
                        ['RAG 知识库', '✗', '基础版', '企业版'],
                        ['价格', '免费', '199~399 RMB/月', '联系我们'],
                      ].map(([feature, ...vals]) => (
                        <tr key={feature} className="hover:bg-gray-50">
                          <td className="px-6 py-3 text-gray-600 font-medium">{feature}</td>
                          {vals.map((v, i) => (
                            <td key={i} className={`px-6 py-3 text-center font-medium ${auth.plan === PLANS[i]?.id ? 'bg-indigo-50/50 text-indigo-700' : v === '✗' ? 'text-gray-300' : v === '✓' ? 'text-green-600' : 'text-gray-700'}`}>{v}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="p-4 bg-gray-50 border-t border-gray-100 text-center">
                  <p className="text-xs text-gray-400">套餐升级请联系管理员 · Enterprise 版支持私有化部署与定制 SLA</p>
                </div>
              </div>

              {/* 修改密码 */}
              <div className="bg-white border border-gray-200 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <h3 className="font-bold text-gray-800 flex items-center gap-2"><Lock size={18} className="text-indigo-500"/> 修改密码</h3>
                </div>
                <div className="p-6">
                  <PasswordChangeForm />
                </div>
              </div>

              {/* API Key 管理 */}
              <ApiKeyManager plan={auth.plan} />
            </div>
          </div>
        );
      })()}

      {activeTab === 'rag' && (() => {
        const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
        if (!limits.canRag) {
          return (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center p-8 max-w-md">
                <div className="w-16 h-16 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Database size={32} className="text-indigo-500" />
                </div>
                <h3 className="text-xl font-black text-gray-800 mb-2">RAG 智能知识库</h3>
                <p className="text-sm text-gray-500 mb-6">上传文档后，AI 自动检索并引用相关内容，回答质量提升 300%。支持 PDF、Word、Markdown 等格式。</p>
                <div className="grid grid-cols-3 gap-3 mb-6 text-center">
                  <div className="p-3 bg-indigo-50 rounded-xl"><p className="text-lg font-black text-indigo-600">10GB</p><p className="text-[10px] text-gray-400">存储空间</p></div>
                  <div className="p-3 bg-indigo-50 rounded-xl"><p className="text-lg font-black text-indigo-600">7+</p><p className="text-[10px] text-gray-400">文件格式</p></div>
                  <div className="p-3 bg-indigo-50 rounded-xl"><p className="text-lg font-black text-indigo-600">0.1s</p><p className="text-[10px] text-gray-400">向量检索</p></div>
                </div>
                <button onClick={() => { setActiveTab('profile'); setShowUpgradeForm(true); setUpgradeTarget('pro'); }}
                  className="px-8 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-black rounded-xl shadow-lg hover:shadow-xl transition-all">
                  升级 Pro · ¥199/月 解锁知识库
                </button>
                <p className="text-[10px] text-gray-400 mt-3">Enterprise 版还支持组织级共享知识库</p>
              </div>
            </div>
          );
        }

        const handleRagUpload = async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setRagUploading(true);
          try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API_BASE_URL}/rag/upload`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
              body: formData,
            });
            const data = await res.json();
            if (data.ok) {
              fetchRagDocs();
            } else {
              alert(data.error || '上传失败');
            }
          } catch {
            alert('上传失败，请检查网络连接');
          }
          setRagUploading(false);
          if (ragFileRef.current) ragFileRef.current.value = '';
        };

        const handleRagDelete = async (docId) => {
          if (!confirm('确定删除该文档？向量索引将一并清除。')) return;
          try {
            const res = await fetch(`${API_BASE_URL}/rag/docs/${docId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` },
            });
            if (res.ok) fetchRagDocs();
          } catch {}
        };

        return (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black text-gray-800 flex items-center gap-2"><Database size={24} className="text-indigo-500"/> 知识库管理</h2>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400">{ragDocs.length} 篇文档 · {(ragStorage.usedBytes / 1024 / 1024).toFixed(1)}MB{ragStorage.quotaMB > 0 ? ` / ${ragStorage.quotaMB >= 1024 ? (ragStorage.quotaMB / 1024).toFixed(0) + 'GB' : ragStorage.quotaMB + 'MB'}` : ' / 无限'}</span>
                  <input type="file" ref={ragFileRef} onChange={handleRagUpload} className="hidden" accept=".txt,.md,.csv,.json,.log,.xml,.html,.htm" />
                  <button onClick={() => ragFileRef.current?.click()} disabled={ragUploading} className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl flex items-center gap-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                    <Upload size={16} /> {ragUploading ? '上传中...' : '上传文档'}
                  </button>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-sm text-blue-700">
                <p className="font-bold mb-1">使用说明</p>
                <p>上传文本文件后，系统自动进行分块和向量化。在调度中心发送问题时，开启 <span className="font-mono bg-blue-100 px-1 rounded">RAG</span> 按钮，AI 将自动从知识库检索相关内容增强回答。</p>
                <p className="mt-1 text-xs text-blue-500">支持格式：.txt .md .csv .json .log .xml .html · 单文件最大 20MB</p>
              </div>

              {(() => {
                const [orgs, setOrgs] = React.useState([]);
                const [newOrgName, setNewOrgName] = React.useState('');
                const [selectedOrg, setSelectedOrg] = React.useState(null);
                const [orgDocs, setOrgDocs] = React.useState([]);
                const [orgMembers, setOrgMembers] = React.useState([]);
                const [addMember, setAddMember] = React.useState('');
                const tkn = window.sessionStorage.getItem('token') || '';
                const hdrs = { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' };
                React.useEffect(() => {
                  fetch(`${API_BASE_URL}/user/orgs`, { headers: { Authorization: `Bearer ${tkn}` } })
                    .then(r => r.ok ? r.json() : null).then(d => { if (d?.orgs) setOrgs(d.orgs); }).catch(() => {});
                }, []);
                const createOrg = async () => {
                  if (!newOrgName.trim()) return;
                  try {
                    const r = await fetch(`${API_BASE_URL}/user/orgs`, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: newOrgName.trim() }) });
                    if (r.ok) { const d = await r.json(); setOrgs(prev => [...prev, d.org]); setNewOrgName(''); }
                    else { const d = await r.json(); alert(d.error || '创建失败'); }
                  } catch {}
                };
                const selectOrg = async (org) => {
                  setSelectedOrg(org);
                  try {
                    const [docsR, memR] = await Promise.all([
                      fetch(`${API_BASE_URL}/orgs/${org.id}/rag/docs`, { headers: { Authorization: `Bearer ${tkn}` } }),
                      fetch(`${API_BASE_URL}/orgs/${org.id}/members`, { headers: { Authorization: `Bearer ${tkn}` } }),
                    ]);
                    if (docsR.ok) { const d = await docsR.json(); setOrgDocs(d.docs || []); }
                    if (memR.ok) { const d = await memR.json(); setOrgMembers(d.members || []); }
                  } catch {}
                };
                const doAddMember = async () => {
                  if (!addMember.trim() || !selectedOrg) return;
                  try {
                    const r = await fetch(`${API_BASE_URL}/orgs/${selectedOrg.id}/members`, { method: 'POST', headers: hdrs, body: JSON.stringify({ username: addMember.trim() }) });
                    if (r.ok) { setAddMember(''); selectOrg(selectedOrg); }
                    else { const d = await r.json(); alert(d.error || '添加失败'); }
                  } catch {}
                };
                return (auth.plan !== 'free' && (
                  <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
                    <h3 className="font-bold text-gray-800 flex items-center gap-2"><Users size={18} className="text-indigo-500"/> 组织知识库（多租户）</h3>
                    <div className="flex gap-2">
                      {orgs.map(o => (
                        <button key={o.id} onClick={() => selectOrg(o)} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${selectedOrg?.id === o.id ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                          {o.name} ({o.memberCount})
                        </button>
                      ))}
                      <div className="flex gap-1">
                        <input value={newOrgName} onChange={e => setNewOrgName(e.target.value)} placeholder="新建组织..." className="px-2 py-1 text-xs border border-gray-200 rounded-lg w-28"/>
                        <button onClick={createOrg} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">创建</button>
                      </div>
                    </div>
                    {selectedOrg && (
                      <div className="space-y-3 border-t border-gray-100 pt-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-500">成员 ({orgMembers.length}):</span>
                          {orgMembers.map(m => (
                            <span key={m.userId} className="text-[10px] px-2 py-0.5 bg-gray-100 rounded-full">{m.username || m.name} ({m.role})</span>
                          ))}
                          {['owner', 'admin'].includes(selectedOrg.role) && (
                            <div className="flex gap-1 ml-2">
                              <input value={addMember} onChange={e => setAddMember(e.target.value)} placeholder="用户名" className="px-2 py-0.5 text-[10px] border border-gray-200 rounded w-20"/>
                              <button onClick={doAddMember} className="px-2 py-0.5 text-[10px] bg-indigo-500 text-white rounded hover:bg-indigo-600">添加</button>
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">{orgDocs.length} 篇组织文档 — 所有成员的 RAG 查询自动包含组织文档</div>
                        {orgDocs.map(doc => (
                          <div key={doc.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                            <FileText size={14} className="text-indigo-400"/>
                            <span className="text-xs font-bold text-gray-700">{doc.originalName}</span>
                            <span className="text-[10px] text-gray-400">{doc.chunks} 块</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ));
              })()}

              {ragDocs.length === 0 ? (
                <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center">
                  <FileText size={40} className="mx-auto text-gray-200 mb-3" />
                  <p className="text-gray-400 text-sm">暂无文档，点击"上传文档"开始构建知识库</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {ragDocs.map(doc => (
                    <div key={doc.id} className="bg-white border border-gray-200 rounded-2xl p-4 flex items-center justify-between hover:shadow-sm transition-shadow">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                          <FileText size={18} className="text-indigo-500" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-gray-800 text-sm truncate">{doc.originalName}</p>
                          <p className="text-xs text-gray-400">{doc.chunks} 个分块 · {new Date(doc.createdAt).toLocaleString()}</p>
                        </div>
                      </div>
                      <button onClick={() => handleRagDelete(doc.id)} className="p-2 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0" title="删除文档">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// --- 应用入口 (统一出口) ---
export default function App() {
  const [dbUsers, setDbUsers] = useState([]);
  const [isTestMode, setIsTestMode] = useState(true);
  const [adminKeys, setAdminKeys] = useState({});
  const [alertsConfig, setAlertsConfig] = useState({ email: '', phone: '', wechat: '', smtpServer: '', smtpPort: '', emailPwd: '', smsProvider: 'aliyun', smsAppKey: '', smsSign: 'ZDF.AI', smsTemplate: '', webhookWechat: '', webhookDingtalk: '' });
  const [dbLogs, setDbLogs] = useState([]);
  const [vendors, setVendors] = useState(FALLBACK_VENDORS);
  const [strategy, setStrategy] = useState('fusion');
  const [adminTemplates, setAdminTemplates] = useState([]);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  const [auth, setAuth] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSystemData = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/system-data`, {
           headers: { 'Authorization': `Bearer ${window.sessionStorage.getItem('token') || ''}` }
        });
        if (response.ok) {
          const data = await response.json();
          if (data.users) setDbUsers(data.users);
          if (data.isTestMode !== undefined) setIsTestMode(data.isTestMode);
          if (data.keys) setAdminKeys(data.keys);
          if (data.alerts) setAlertsConfig(data.alerts);
          if (data.logs) setDbLogs(data.logs);
          if (data.strategy) setStrategy(data.strategy);
          if (Array.isArray(data.vendors) && data.vendors.length > 0) setVendors(data.vendors);
          if (Array.isArray(data.promptTemplates)) setAdminTemplates(data.promptTemplates);
        } else {
          throw new Error("后端接口未就绪");
        }
      } catch (e) {
        console.warn("未能连接到后端服务 (Port 3000)，等待用户登录后重试");
      } finally {
        setIsLoading(false);
      }
    };
    fetchSystemData();

    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      setPaymentSuccess(true);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('payment') === 'cancel') {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const syncToDatabase = async (endpoint, payload) => {
    try {
      await fetch(`${API_BASE_URL}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window.sessionStorage.getItem('token') || ''}` },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn(`数据同步至后端 /${endpoint} 失败，请检查 Node.js 后端状态。`);
    }
  };

  // 防抖同步：避免快速连续变更发大量请求
  const syncTimers = useRef({});
  const debouncedSync = useCallback((endpoint, payload, delay = 800) => {
    if (syncTimers.current[endpoint]) clearTimeout(syncTimers.current[endpoint]);
    syncTimers.current[endpoint] = setTimeout(() => syncToDatabase(endpoint, payload), delay);
  }, []);
  useEffect(() => { if (!isLoading && Object.keys(adminKeys).length > 0) debouncedSync('admin/keys', adminKeys); }, [adminKeys, isLoading]);
  useEffect(() => { if (!isLoading) debouncedSync('admin/settings', { isTestMode, strategy, alertsConfig }); }, [isTestMode, strategy, alertsConfig, isLoading]);
  useEffect(() => { if (!isLoading && dbUsers.length > 0) debouncedSync('admin/users', dbUsers); }, [dbUsers, isLoading]);
  useEffect(() => { if (!isLoading && dbLogs.length > 0) debouncedSync('admin/logs', dbLogs, 2000); }, [dbLogs, isLoading]);
  useEffect(() => { if (!isLoading && vendors.length > 0) debouncedSync('admin/vendors', vendors); }, [vendors, isLoading]);

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center bg-gray-50"><div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div></div>;
  }

  const handleLogout = () => {
    fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` } }).catch(() => {});
    window.sessionStorage.removeItem('token');
    setAuth(null);
  };

  const paymentBanner = paymentSuccess && (
    <div className="fixed top-0 left-0 right-0 z-[200] flex justify-center p-4 pointer-events-none">
      <div className="bg-emerald-600 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 pointer-events-auto animate-bounce">
        <CheckCircle2 size={20}/>
        <span className="font-bold text-sm">支付成功！套餐已升级，请重新登录以刷新权限。</span>
        <button onClick={() => setPaymentSuccess(false)} className="ml-2 p-1 hover:bg-emerald-700 rounded-lg transition-colors"><X size={16}/></button>
      </div>
    </div>
  );

  if (!auth) {
    return (
      <>
        {paymentBanner}
        <AuthScreen
          onLogin={(user) => {
            setPaymentSuccess(false);
            setAuth(user);
          }}
          onRegister={(u) => {
            setDbUsers(p => [...p, u]);
          }}
          dbUsers={dbUsers}
          isTestMode={isTestMode}
        />
      </>
    );
  }

  // 完全的页面/布局路由隔离
  if (auth.role === 'admin') {
    return (
      <AdminApp 
        auth={auth} 
        onLogout={handleLogout} 
        dbUsers={dbUsers} 
        setDbUsers={setDbUsers} 
        isTestMode={isTestMode} 
        setIsTestMode={setIsTestMode} 
        adminKeys={adminKeys} 
        setAdminKeys={setAdminKeys} 
        alertsConfig={alertsConfig} 
        setAlertsConfig={setAlertsConfig} 
        dbLogs={dbLogs}
        setDbLogs={setDbLogs}
        vendors={vendors}
        setVendors={setVendors}
        strategy={strategy}
        setStrategy={setStrategy}
        onSwitchToUser={() => setAuth({ ...auth, role: 'user', originalRole: 'admin' })}
        adminTemplates={adminTemplates}
        setAdminTemplates={setAdminTemplates}
      />
    );
  } else {
    return (
      <UserApp
        auth={auth}
        onLogout={handleLogout}
        isTestMode={isTestMode}
        dbKeys={adminKeys}
        dbUsers={dbUsers}
        vendors={vendors}
        strategy={strategy}
        onSwitchToAdmin={(adminUser) => setAuth(adminUser)}
        onUpdateAuth={(updated) => setAuth(updated)}
      />
    );
  }
}
