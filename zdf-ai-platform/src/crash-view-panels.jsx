import React, { useState, useEffect } from 'react';
import { ArrowRight, Users, FileText } from 'lucide-react';

const API_BASE_URL = `${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/api`;

function authHeaders(json = false) {
  const headers = { Authorization: `Bearer ${window.sessionStorage.getItem('token') || ''}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/** Admin 升级审批 — hooks at component top level so tab switch does not crash. */
export function UpgradeRequestsPanel({ auth, addLog }) {
  const [upgradeList, setUpgradeList] = useState([]);
  const [upgradeLoading, setUpgradeLoading] = useState(true);
  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/upgrade-requests`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.requests) setUpgradeList(d.requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))); })
      .catch(() => {})
      .finally(() => setUpgradeLoading(false));
  }, []);
  const handleReview = async (id, action) => {
    const note = action === 'reject' ? (prompt('拒绝原因（可选）：') || '') : '';
    try {
      const r = await fetch(`${API_BASE_URL}/admin/upgrade-requests/${id}/review`, {
        method: 'POST', headers: authHeaders(true),
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
}

/** Admin 订单管理 */
export function OrdersPanel() {
  const [orderList, setOrderList] = useState([]);
  const [orderLoading, setOrderLoading] = useState(true);
  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/orders`, { headers: authHeaders() })
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
          <div className="text-lg font-black text-emerald-700">{paid.some(o => o.currency === 'eur') ? `€${(totalRevenue / 100).toFixed(0)}` : `¥${(totalRevenue / 100).toFixed(0)}`}</div>
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
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{String(o.id || '').slice(0, 16)}...</td>
                <td className="px-4 py-3 font-bold text-gray-700">{o.username || o.userId}</td>
                <td className="px-4 py-3"><span className="px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-700 font-bold">{o.plan}</span></td>
                <td className="px-4 py-3 font-mono">{o.currency === 'eur' ? '€' : '¥'}{((o.amount || 0) / 100).toFixed(2)}</td>
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
}

/** Admin 工作流编排 — live workflow list/create */
export function WorkflowConfigPanel() {
  const [wfList, setWfList] = useState([]);
  const [newName, setNewName] = useState('');
  const [newSteps, setNewSteps] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const tkn = window.sessionStorage.getItem('token') || '';
    fetch(`${API_BASE_URL}/admin/workflows`, { headers: { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' } })
      .then(r => r.ok ? r.json() : null).then(d => { if (d?.workflows) setWfList(d.workflows); }).catch(() => {});
  }, []);
  const handleCreate = async () => {
    if (!newName.trim() || !newSteps.trim()) return;
    setCreating(true);
    const tkn = window.sessionStorage.getItem('token') || '';
    const hdrs = { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' };
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
    const tkn = window.sessionStorage.getItem('token') || '';
    try {
      const r = await fetch(`${API_BASE_URL}/admin/workflows/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tkn}` } });
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
              {(wf.steps || []).map((s, j) => (
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
}

/** Admin SLA live metrics strip */
export function SlaLiveMetrics() {
  const [slaData, setSlaData] = useState(null);
  useEffect(() => {
    const tkn = window.sessionStorage.getItem('token') || '';
    fetch(`${API_BASE_URL}/admin/sla`, { headers: { Authorization: `Bearer ${tkn}` } })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) setSlaData(d); }).catch(() => {});
  }, []);
  const avail = slaData?.availability ?? '—';
  const rt = slaData?.responseTime || {};
  const aiRt = slaData?.aiResponseTime || {};
  const up = slaData?.uptime || {};
  return (
    <>
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
    </>
  );
}

/** Admin SLA health-check runner */
export function SystemHealthCheck() {
  const [healthData, setHealthData] = useState(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API_BASE_URL}/admin/health-check`, { headers: authHeaders() });
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
}

/** Admin 私有化部署 checklist */
export function DeployChecklist() {
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
  const [checklist, setChecklist] = useState(items.map(i => ({ ...i })));
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
}

/** User 知识库 — org/multi-tenant section */
export function OrgKnowledgeBase({ plan }) {
  const [orgs, setOrgs] = useState([]);
  const [newOrgName, setNewOrgName] = useState('');
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [orgDocs, setOrgDocs] = useState([]);
  const [orgMembers, setOrgMembers] = useState([]);
  const [addMember, setAddMember] = useState('');
  useEffect(() => {
    const tkn = window.sessionStorage.getItem('token') || '';
    fetch(`${API_BASE_URL}/user/orgs`, { headers: { Authorization: `Bearer ${tkn}` } })
      .then(r => r.ok ? r.json() : null).then(d => { if (d?.orgs) setOrgs(d.orgs); }).catch(() => {});
  }, []);
  const createOrg = async () => {
    if (!newOrgName.trim()) return;
    const tkn = window.sessionStorage.getItem('token') || '';
    const hdrs = { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' };
    try {
      const r = await fetch(`${API_BASE_URL}/user/orgs`, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: newOrgName.trim() }) });
      if (r.ok) { const d = await r.json(); setOrgs(prev => [...prev, d.org]); setNewOrgName(''); }
      else { const d = await r.json(); alert(d.error || '创建失败'); }
    } catch {}
  };
  const selectOrg = async (org) => {
    setSelectedOrg(org);
    const tkn = window.sessionStorage.getItem('token') || '';
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
    const tkn = window.sessionStorage.getItem('token') || '';
    const hdrs = { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' };
    try {
      const r = await fetch(`${API_BASE_URL}/orgs/${selectedOrg.id}/members`, { method: 'POST', headers: hdrs, body: JSON.stringify({ username: addMember.trim() }) });
      if (r.ok) { setAddMember(''); selectOrg(selectedOrg); }
      else { const d = await r.json(); alert(d.error || '添加失败'); }
    } catch {}
  };
  if (plan === 'free') return null;
  return (
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
  );
}
