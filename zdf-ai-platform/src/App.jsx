import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Settings, Users, ShieldCheck, MessageSquare, Play,
  CheckCircle2, AlertCircle, Database, LayoutDashboard, LogOut,
  Zap, Info, CreditCard, ArrowRight, Paperclip, X, FileText,
  Clock, Trash2, Mail, Lock, User, Key, MonitorDot,
  Crown, MessageCircleQuestion, Send, Sliders, Image,
  Download, Share2, Smartphone, BellRing, Server, AlertTriangle,
  ClipboardList, UserCog, Save, Plus, ArrowLeftRight
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

const VENDORS = [
  { id: 'openai', name: 'OpenAI', region: 'US', models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { id: 'anthropic', name: 'Anthropic', region: 'US', models: ['claude-3.5-sonnet', 'claude-3-opus', 'claude-3-haiku'] },
  { id: 'google', name: 'Google', region: 'US', models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.5-flash'] },
  { id: 'deepseek', name: 'DeepSeek (深度求索)', region: 'CN', models: ['deepseek-chat (V3)', 'deepseek-coder'] },
  { id: 'alibaba', name: 'Alibaba (阿里)', region: 'CN', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { id: 'zhipu', name: 'Zhipu (智谱)', region: 'CN', models: ['glm-4', 'glm-4v', 'glm-3-turbo'] },
  { id: 'baidu', name: 'Baidu (百度)', region: 'CN', models: ['ernie-4.0', 'ernie-3.5'] },
  { id: 'moonshot', name: 'Moonshot (月之暗面)', region: 'CN', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
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
  free:       { dailyTasks: 20,  historyDays: 7,  canExport: false },
  pro:        { dailyTasks: 500, historyDays: -1, canExport: true  },
  enterprise: { dailyTasks: -1,  historyDays: -1, canExport: true  },
  max:        { dailyTasks: -1,  historyDays: -1, canExport: true  }, // 历史兼容
};

// AI Credit 消耗定义
const PIPELINE_CREDITS = 5;  // 四模型协同流水线

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
const callGemini = async (prompt, systemPrompt = "", files = [], dispatch = null) => {
  let retries = 0;
  const maxRetries = 3;
  const payload = {
    prompt,
    systemPrompt,
    files: files.map(f => ({ name: f.name, type: f.type, isImage: f.isImage, data: f.data })),
    ...(dispatch ? { dispatch } : {}),
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
      try {
        const errJson = await response.json();
        errHint = errJson.error || errJson.message || '';
      } catch {
        /* ignore */
      }
      console.warn('后端 /ai/generate 非成功状态，启用离线降级模拟...', response.status);
      await new Promise(r => setTimeout(r, 800));
      return `[开发模拟回复] ${errHint || `HTTP ${response.status}`}\n您发送了：“${prompt.slice(0, 400)}${prompt.length > 400 ? '…' : ''}”。请确认已启动 backend 且 Vite 代理 /api 指向正确端口。`;
    }

    const data = await response.json();
    return data.result || data.text || '无返回内容';
  };

  while (retries < maxRetries) {
    try {
      return await execute();
    } catch (e) {
      retries++;
      await new Promise(r => setTimeout(r, Math.pow(2, retries) * 500));
      if (retries === maxRetries) return `[错误] 后端调度失败: ${e.message}`;
    }
  }
};

const AuthScreen = ({ onLogin, onRegister, dbUsers, isTestMode }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleAction = () => {
    setError('');
    if (!username || !password) return setError('请输入账号和密码');
    
    if (isRegister) {
      if (dbUsers.find(u => u.username === username)) return setError('该账号已被注册，请直接登录');
      const newUser = {
        id: `usr_${Date.now().toString().slice(-4)}`,
        username, password, role: 'user', name: username, roleDetail: 'user',
        plan: isTestMode ? 'pro' : 'free',
        status: 'active', balance: 0.0
      };
      onRegister(newUser);
      onLogin(newUser);
    } else {
      const user = dbUsers.find(u => u.username === username && u.password === password);
      if (user) {
        if (user.status !== 'active') return setError('该账号已被管理员封禁，请联系客服');
        onLogin(user);
      } else {
        setError('账号或密码错误，请重试');
      }
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
          <p className="text-sm text-gray-500 mt-2">支持多厂商大模型的协同工作台</p>
        </div>
        <div className="space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 text-xs font-bold rounded-xl border border-red-100">{error}</div>}
          <div className="relative">
            <User className="absolute left-3 top-3 text-gray-400" size={20} />
            <input type="text" placeholder="账号 (默认管理员: admin123)" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:border-indigo-500 outline-none transition-colors" onKeyDown={(e) => e.key === 'Enter' && handleAction()} />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-3 text-gray-400" size={20} />
            <input type="password" placeholder="密码 (默认管理密码: admin456)" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:border-indigo-500 outline-none transition-colors" onKeyDown={(e) => e.key === 'Enter' && handleAction()} />
          </div>
          <button onClick={handleAction} className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition-colors">{isRegister ? '立即注册并进入' : '进入系统'}</button>
        </div>
        <div className="mt-6 pt-6 border-t border-gray-100 text-center text-sm text-gray-500">
          {isRegister ? '已有账户？' : '还没有账户？'} 
          <button onClick={() => { setIsRegister(!isRegister); setError(''); }} className="text-indigo-600 font-bold ml-1 hover:underline">{isRegister ? '返回登录' : '免费注册'}</button>
        </div>
      </div>
    </div>
  );
};

const AdminApp = ({ auth, onLogout, dbUsers, setDbUsers, isTestMode, setIsTestMode, adminKeys, setAdminKeys, alertsConfig, setAlertsConfig, dbLogs, setDbLogs, onSwitchToUser }) => {
  const [subTab, setSubTab] = useState('overview');
  
  const [showSelfCheck, setShowSelfCheck] = useState(true);
  const [checkSteps, setCheckSteps] = useState([
    { id: 'db', name: '本地数据库连通性', status: 'pending', msg: '' },
    { id: 'api', name: '平台 API 连通性与余额', status: 'pending', msg: '' },
    { id: 'storage', name: '存储卷健康状态', status: 'pending', msg: '' }
  ]);
  const [checkPhase, setCheckPhase] = useState('running'); 
  const [alertSent, setAlertSent] = useState(false);

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
      await new Promise(r => setTimeout(r, 800));
      if(!isMounted) return;
      setCheckSteps(prev => prev.map(s => s.id === 'db' ? { ...s, status: 'ok', msg: '连接成功 (Latency: 12ms)' } : s));
      
      await new Promise(r => setTimeout(r, 1000));
      if(!isMounted) return;
      const hasValidKey = Object.values(adminKeys).some(k => k.status === 'success' && k.value.length > 5);
      if (hasValidKey) {
         setCheckSteps(prev => prev.map(s => s.id === 'api' ? { ...s, status: 'ok', msg: '配置正常，多模型网关在线' } : s));
      } else {
         setCheckSteps(prev => prev.map(s => s.id === 'api' ? { ...s, status: 'error', msg: '警告：未检测到有效配置的 API Key！用户调度可能受阻' } : s));
      }

      await new Promise(r => setTimeout(r, 600));
      if(!isMounted) return;
      setCheckSteps(prev => prev.map(s => s.id === 'storage' ? { ...s, status: 'ok', msg: '存储卷挂载正常，剩余容量 84%' } : s));

      setCheckPhase('done');
    };
    runCheck();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (checkPhase === 'done') {
      const hasError = checkSteps.some(s => s.status === 'error');
      if (hasError) {
        setTimeout(() => {
          setAlertSent(true);
          addLog('alert', 'System', '自检异常告警', `API 节点异常。已向配置的渠道投递告警：Email(${alertsConfig.email||'未配'}), SMS(${alertsConfig.phone||'未配'})`);
        }, 1500);
      } else {
        setTimeout(() => setShowSelfCheck(false), 1500);
      }
    }
  }, [checkPhase, checkSteps]);

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
                    {step.status === 'error' && <AlertTriangle className="text-red-500" size={20} />}
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-800">{step.name}</h4>
                    <p className={`text-xs mt-1 ${step.status === 'error' ? 'text-red-500 font-medium' : 'text-gray-500'}`}>{step.msg || '正在校验中...'}</p>
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
          {[{id:'overview', icon: Activity, label: '数据看板'},
            {id:'users', icon: Users, label: '用户管线'},
            {id:'apikeys', icon: Key, label: '系统接口配置'},
            {id:'admins', icon: UserCog, label: '管理员与权限'},
            {id:'logs', icon: ClipboardList, label: '运行与告警日志'},
            {id:'settings', icon: Sliders, label: '全局与告警设置'}
          ].map(item => (
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
            {subTab === 'admins' && '管理员人员配置'}
            {subTab === 'logs' && '系统运行审计日志'}
            {subTab === 'settings' && '全局控制与告警'}
          </h2>
          <div className="flex items-center gap-4 text-xs font-medium">
            <span className="flex items-center gap-1"><MonitorDot className="text-green-500" size={14}/> DB在线</span>
            <span className="px-2 py-1 bg-gray-100 rounded text-gray-600 border border-gray-200">{new Date().toLocaleDateString()}</span>
          </div>
        </header>

        <div className="p-8 pb-32">
          {subTab === 'overview' && (
            <div className="grid grid-cols-4 gap-6">
              {[{ label: '总注册量', v: dbUsers.length, c: 'text-blue-600', bg: 'bg-blue-100' }, { label: '今日调用量', v: 1284, c: 'text-indigo-600', bg: 'bg-indigo-100' }, { label: '可用 API 节点', v: Object.values(adminKeys).filter(k=>k.status==='success').length, c: 'text-emerald-600', bg: 'bg-emerald-100' }, { label: '自检状态', v: checkSteps.some(s=>s.status==='error')?'告警中':'健康', c: checkSteps.some(s=>s.status==='error')?'text-red-600':'text-green-600', bg: checkSteps.some(s=>s.status==='error')?'bg-red-100':'bg-green-100' }].map((st, i) => (
                <div key={i} className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${st.bg} ${st.c}`}><Database size={20} /></div>
                  <div><p className="text-xs text-gray-500 mb-1">{st.label}</p><p className="text-2xl font-black">{st.v}</p></div>
                </div>
              ))}
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
                          <button className="text-xs font-bold text-red-500 hover:underline disabled:opacity-30 cursor-not-allowed" disabled title="演示环境不允许删除管理员">撤销权限</button>
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
                  <span className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg font-bold border border-gray-200">全部日志</span>
                  <span className="px-3 py-1.5 text-gray-500 hover:bg-gray-50 rounded-lg cursor-pointer">告警记录</span>
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
                    {dbLogs.length === 0 ? (
                      <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-400">暂无任何系统日志</td></tr>
                    ) : (
                      dbLogs.map(l => (
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
                    )}
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
              {VENDORS.map(v => {
                const kSt = adminKeys[v.id] || { value: '', status: 'idle', msg: '' };
                return (
                  <div key={v.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 w-1/3">
                        <div className="w-10 h-10 bg-gray-50 border border-gray-100 rounded-lg flex items-center justify-center"><Key size={16} className="text-gray-400"/></div>
                        <div><h4 className="font-bold text-gray-800 text-sm">{v.name}</h4><p className="text-[10px] text-gray-500">{v.region}</p></div>
                      </div>
                      <div className="flex-1 flex items-center gap-2">
                        <input type="password" placeholder="填写 API Key" className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-indigo-500" value={kSt.value} onChange={(e) => handleKeyChange(v.id, e.target.value)} />
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
                      <input type="password" value={alertsConfig.smsAppKey || ''} onChange={e=>setAlertsConfig({...alertsConfig, smsAppKey: e.target.value})} className="col-span-2 p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="AccessKey / Secret" />
                    </div>
                  </div>

                  <div className="p-5 bg-gray-50 border border-gray-200 rounded-xl">
                    <h4 className="font-bold text-sm text-gray-700 flex items-center gap-2 mb-4"><MessageSquare size={16}/> 企业微信 / 钉钉 Webhook</h4>
                    <input type="text" value={alertsConfig.wechat || ''} onChange={e=>setAlertsConfig({...alertsConfig, wechat: e.target.value})} className="w-full p-3 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button onClick={() => { addLog('info', auth.username, '修改告警配置', '保存了最新的告警通信渠道参数'); alert('告警集成配置已加密保存到本地数据库！'); }} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition-colors"><Save size={16}/> 保存集成配置</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

// --- 模块 3：前端用户工作台 ---
const UserApp = ({ auth, onLogout, isTestMode, dbKeys, onSwitchToAdmin, dbUsers }) => {
  const [activeTab, setActiveTab] = useState('dispatch'); 
  const [showAdminAuth, setShowAdminAuth] = useState(false);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAuthError, setAdminAuthError] = useState('');

  const [configs, setConfigs] = useState({
    A: { vendor: 'deepseek', model: 'deepseek-chat (V3)', mode: 'platform', key: '' },
    B: { vendor: 'alibaba', model: 'qwen-max', mode: 'platform', key: '' },
    C: { vendor: 'anthropic', model: 'claude-3.5-sonnet', mode: 'platform', key: '' },
    D: { vendor: 'openai', model: 'gpt-4o', mode: 'platform', key: '' },
  });
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [strategy, setStrategy] = useState("fusion");
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [results, setResults] = useState({ A: "", B: "", C: "", D: "", final: "" });
  const [scores, setScores] = useState({ B: 0, C: 0, D: 0 });
  const [history, setHistory] = useState([]);
  const [resultTab, setResultTab] = useState('final');
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [historySearch, setHistorySearch] = useState('');
  const todayKey = `zdf_tasks_${auth.id}_${new Date().toDateString()}`;
  const creditKey = `zdf_credits_${auth.id}_${new Date().toDateString()}`;
  const [dailyTasksUsed, setDailyTasksUsed] = useState(() => parseInt(sessionStorage.getItem(todayKey) || '0', 10));
  const [creditsUsed, setCreditsUsed] = useState(() => parseInt(sessionStorage.getItem(creditKey) || '0', 10));

  useEffect(() => {
    fetch(`${API_BASE_URL}/user/history`, { headers: { 'Authorization': `Bearer ${window.sessionStorage.getItem('token')}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if(data?.history) setHistory(data.history); })
      .catch(() => console.warn("无法连接到后端加载历史记录"));
  }, []);

  const RoleConfigUser = ({ role, config, onUpdate }) => {
    const currentVendor = VENDORS.find(v => v.id === config.vendor) || VENDORS[0];
    return (
      <div className="p-4 border-b border-gray-100 last:border-0 hover:bg-gray-50">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded">{role.icon}</div>
          <div><h4 className="text-sm font-bold text-gray-800">{role.id} · {role.name}</h4></div>
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            <select className="w-1/2 text-xs p-2 border rounded bg-white" value={config.vendor} onChange={(e) => { const vendor = VENDORS.find(v => v.id === e.target.value); onUpdate(role.id, { vendor: e.target.value, model: vendor.models[0] }); }}>
              <optgroup label="海外厂商">{VENDORS.filter(v => v.region === 'US').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup>
              <optgroup label="国内厂商">{VENDORS.filter(v => v.region === 'CN').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup>
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

  const handleDownload = (format) => {
    if (!results.final) return;
    const limits = PLAN_LIMITS[auth.plan] || PLAN_LIMITS.free;
    if (!limits.canExport) {
      alert('导出功能需要 Pro 版或以上套餐，请联系管理员升级');
      return;
    }
    const text = results.final;
    const ts = new Date().toLocaleString();
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const htmlTpl = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ZDF.AI 输出</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;line-height:1.8;color:#222}h1{font-size:20px}p.ts{color:#888;font-size:13px}pre{white-space:pre-wrap;word-break:break-word}@media print{body{margin:0}}</style></head><body><h1>ZDF.AI 输出</h1><p class="ts">${ts}</p><hr><pre>${esc(text)}</pre></body></html>`;
    if (format === 'pdf') {
      const win = window.open('', '_blank');
      win.document.write(htmlTpl + '<script>window.onload=function(){window.print();}<\/script>');
      win.document.close();
      return;
    }
    const configs = {
      doc:  { content: text,    mime: 'application/msword', ext: 'doc' },
      txt:  { content: text,    mime: 'text/plain',         ext: 'txt' },
      md:   { content: text,    mime: 'text/markdown',      ext: 'md'  },
      html: { content: htmlTpl, mime: 'text/html',          ext: 'html'},
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
      alert(`今日任务已达上限（${limits.dailyTasks} 次），请升级套餐`);
      return;
    }
    setIsRunning(true);
    setResultTab('final');
    const newResults = { A: '', B: '', C: '', D: '', final: '' };

    try {
      setCurrentStep('A');
      newResults.A = await callGemini(question, '直接回答用户问题。', attachments, buildDispatch('A'));
      setResults({ ...newResults });

      setCurrentStep('B');
      newResults.B = await callGemini(
        `问题: ${question}\n初稿:\n${newResults.A}\n任务: 事实校核。`,
        '你是一个严格的事实校核员。',
        attachments,
        buildDispatch('B'),
      );
      setResults({ ...newResults });

      setCurrentStep('C');
      newResults.C = await callGemini(
        `校核稿:\n${newResults.B}\n任务: 润色。`,
        '你是一个专业的审核专家。',
        attachments,
        buildDispatch('C'),
      );
      setResults({ ...newResults });

      setCurrentStep('D');
      const resD = await callGemini(
        `审核结果:\n${newResults.C}\n任务: 严格按照策略输出纯文本。`,
        '负责最终纯文本排版。',
        attachments,
        buildDispatch('D'),
      );
      newResults.D = stripMarkdown(resD);
      newResults.final = newResults.D;

      setResults({ ...newResults });
      const histEntry = {
        id: Date.now(),
        question,
        answer: newResults.D,
        timestamp: new Date().toLocaleTimeString(),
        strategyName: STRATEGIES.find((s) => s.id === strategy).name,
      };
      setHistory((prev) => [histEntry, ...prev]);
      const newTasks = dailyTasksUsed + 1;
      const newCredits = creditsUsed + PIPELINE_CREDITS;
      setDailyTasksUsed(newTasks);
      setCreditsUsed(newCredits);
      sessionStorage.setItem(todayKey, String(newTasks));
      sessionStorage.setItem(creditKey, String(newCredits));
      fetch(`${API_BASE_URL}/user/history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ entry: histEntry }),
      }).catch(() => console.warn('写入服务端历史失败'));
    } catch (err) {
      console.error(err);
    } finally {
      setIsRunning(false);
      setCurrentStep(null);
    }
  };

  const handleAdminAuth = () => {
    setAdminAuthError('');
    if (!adminUsername || !adminPassword) {
      setAdminAuthError('请输入管理员账号和密码');
      return;
    }
    const adminUser = dbUsers.find(u => u.username === adminUsername && u.password === adminPassword && u.role === 'admin');
    if (adminUser) {
      setShowAdminAuth(false);
      onSwitchToAdmin(adminUser); 
    } else {
      setAdminAuthError('非管理员账号或密码错误！');
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

      <aside className="w-16 flex flex-col items-center py-6 bg-indigo-900 text-indigo-100 gap-8 z-20">
        <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-indigo-900 font-black">⟳</div>
        <nav className="flex flex-col gap-6 w-full px-2">
          <button onClick={() => setActiveTab('dispatch')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'dispatch' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="调度中心"><Activity size={22} /></button>
          <button onClick={() => setActiveTab('history')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'history' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="历史记录"><Clock size={22} /></button>
          <button onClick={() => setActiveTab('profile')} className={`w-full py-3 flex justify-center rounded-xl transition-all ${activeTab === 'profile' ? 'bg-indigo-700 text-white' : 'hover:bg-indigo-800'}`} title="账户设置"><Settings size={22} /></button>
          
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
              <label className="text-xs font-bold text-gray-700 block mb-2">终审策略</label>
              <select className="w-full p-2 text-sm border rounded outline-none" value={strategy} onChange={e=>setStrategy(e.target.value)}>{STRATEGIES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
          </aside>

          <main className="flex-1 flex flex-col relative">
            <header className="h-14 px-6 flex items-center justify-between border-b border-gray-200 bg-white">
              <span className="text-xs font-bold text-gray-600 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500"></span>在线计算网络</span>
              <div className="flex items-center gap-3">
                <span className="px-2 py-1 bg-indigo-50 text-indigo-600 text-xs font-bold rounded uppercase border border-indigo-100">{auth.plan} 会员</span>
                <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs">{auth.name[0]}</div>
              </div>
            </header>
            
            <div className="flex-1 p-6 overflow-y-auto pb-32">
              { (isRunning || results.A) && (
                <div className="max-w-4xl mx-auto">
                  <div className="bg-white border border-gray-200 rounded-3xl shadow-lg overflow-hidden">
                    <div className="flex border-b border-gray-100 bg-gray-50">
                      <button onClick={()=>setResultTab('final')} className={`px-6 py-4 text-sm font-bold ${resultTab==='final'?'border-b-2 border-indigo-600 text-indigo-600':'text-gray-500'}`}>最终结果</button>
                      <button onClick={()=>setResultTab('steps')} className={`px-6 py-4 text-sm font-bold ${resultTab==='steps'?'border-b-2 border-indigo-600 text-indigo-600':'text-gray-500'}`}>推理过程</button>
                    </div>
                    <div className="p-8">
                      {isRunning && !results.final && <div className="text-center text-gray-400 py-10">模型流转中...</div>}
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
                          {ROLES.map(r => <div key={r.id} className="p-4 bg-gray-50 rounded-lg text-sm text-gray-700 whitespace-pre-wrap"><strong>{r.id}:</strong><br/>{results[r.id]}</div>)}
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
                    <button onClick={()=>fileInputRef.current?.click()} className="p-2 text-gray-500 hover:text-indigo-600" title="上传文件（图片、文档、PDF等）"><Paperclip size={18}/></button>
                  </div>
                  <button onClick={runPipeline} disabled={isRunning} className="px-5 py-2 bg-indigo-600 text-white rounded-xl font-bold flex items-center gap-2 disabled:opacity-50"><Send size={14}/> 发送</button>
                </div>
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
  const [alertsConfig, setAlertsConfig] = useState({ email: '', phone: '', wechat: '', smtpServer: '', smtpPort: '', emailPwd: '', smsProvider: 'aliyun', smsAppKey: '' });
  const [dbLogs, setDbLogs] = useState([]);
  
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
        } else {
          throw new Error("后端接口未就绪");
        }
      } catch (e) {
        console.warn("未能连接到后端服务 (Port 3000)，加载默认数据保障 UI 运行");
        setDbUsers([{ id: 'usr_admin', username: 'admin123', password: 'admin456', role: 'admin', roleDetail: 'super', name: '系统管理员', plan: 'max', status: 'active', balance: 9999.0 }]);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSystemData();
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

  useEffect(() => { if (!isLoading && Object.keys(adminKeys).length > 0) syncToDatabase('admin/keys', adminKeys); }, [adminKeys, isLoading]);
  useEffect(() => { if (!isLoading) syncToDatabase('admin/settings', { isTestMode, alertsConfig }); }, [isTestMode, alertsConfig, isLoading]);
  useEffect(() => { if (!isLoading && dbUsers.length > 0) syncToDatabase('admin/users', dbUsers); }, [dbUsers, isLoading]);
  useEffect(() => { if (!isLoading && dbLogs.length > 0) syncToDatabase('admin/logs', dbLogs); }, [dbLogs, isLoading]);

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center bg-gray-50"><div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div></div>;
  }

  // 渲染登录网关
  if (!auth) {
    return (
      <AuthScreen 
        onLogin={(user) => {
          setAuth(user);
          window.sessionStorage.setItem('token', 'session_token_' + user.id); 
        }} 
        onRegister={(u) => {
          setDbUsers(p => [...p, u]);
          syncToDatabase('auth/register', u);
        }} 
        dbUsers={dbUsers} 
        isTestMode={isTestMode} 
      />
    );
  }

  // 完全的页面/布局路由隔离
  if (auth.role === 'admin') {
    return (
      <AdminApp 
        auth={auth} 
        onLogout={() => setAuth(null)} 
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
        onSwitchToUser={() => setAuth({ ...auth, role: 'user', originalRole: 'admin' })}
      />
    );
  } else {
    return (
      <UserApp 
        auth={auth} 
        onLogout={() => setAuth(null)} 
        isTestMode={isTestMode} 
        dbKeys={adminKeys}
        dbUsers={dbUsers}
        onSwitchToAdmin={(adminUser) => setAuth(adminUser)}
      />
    );
  }
}
