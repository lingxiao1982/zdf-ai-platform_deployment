# Loop Engineering — BestAnswer blank/white-screen menu views

Frozen acceptance for t218u. Do not weaken.

## Background

On https://zdfai.cn/BestAnswer/ (admin123), these menu clicks crash the SPA to a blank React page (HTML shell only, body ~625 bytes):

| Role | Menu | View id |
|------|------|---------|
| Admin | 升级审批 | `subTab === 'upgrades'` |
| Admin | 订单管理 | `subTab === 'orders'` |
| Admin | 工作流编排 | `subTab === 'workflow'` |
| Admin | SLA 保障 | `subTab === 'sla'` |
| Admin | 私有化部署 | `subTab === 'deploy'` |
| User | 知识库 | `activeTab === 'rag'` |

Working tabs that must keep rendering: Admin 数据看板 / 用户管线 / 系统接口配置 / 厂商与模型管理 / 管理员与权限 / 运行与告警日志 / 全局与告警设置 / Prompt 模板; User 调度中心 / 历史记录 / 账户设置.

Related APIs (`/admin/upgrade-requests`, `/admin/orders`, `/admin/workflows`, `/admin/sla`, `/rag/docs`, …) return 200 with Bearer. This is a frontend render crash in `zdf-ai-platform/src/App.jsx` (`AdminApp` / `UserApp`), not nginx.

## Frozen criteria

Visiting **each of the 6 views** must render without a blank crash.

Offline proof (`npm test` in `zdf-ai-platform/`):

1. **Tab-switch mount (required).** Start on a working tab (Admin `overview` / User `dispatch`). Switch to each of the 6 views. The renderer must **not throw**. The rendered tree must include that view’s identifying heading:

   - 升级审批 → `套餐升级审批`
   - 订单管理 → `订单与支付管理`
   - 工作流编排 → `工作流编排引擎`
   - SLA 保障 → `SLA 服务等级协议`
   - 私有化部署 → `私有化部署管理`
   - 知识库 (enterprise `canRag`) → `知识库管理`

2. **Working-tab regression.** Switching among the working tabs listed above must still render without throw.

3. **Hooks contract.** `App.jsx` must not call `React.useState` / `useEffect` / `useRef` / `useCallback` / `useMemo` (or `React.use*`) **inside IIFEs** gated by `subTab` / `activeTab`. Hooks belong at the top level of a mounted component so tab switches do not change the parent’s hook count.

## Out of scope

Secrets, `.env`, vendor key wiring, OAuth / SMTP / payment config, nginx, deploy, merge, production changes, new product features.
