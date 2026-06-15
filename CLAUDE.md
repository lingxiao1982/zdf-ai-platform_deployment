# ZDF.AI Platform — Claude Code 上下文

## 项目简介

ZDF.AI 是一个 AI Multi-Agent Decision Operating System（多智能体决策操作系统）。
采用四级流水线架构（生成 → 校核 → 审核 → 终审），多模型互相监督，输出可审计、可追踪的 AI 决策结果。

---

## 本地开发启动

**终端 1 — 前端（Vite，端口 8080）：**
```bash
cd zdf-ai-platform
npm run dev
```

**终端 2 — 后端（Express，端口 3000）：**
```bash
cd zdf-ai-platform/backend
npm run dev
```

访问：`http://localhost:8080`
后端健康检查：`http://localhost:3000/api/health`

> `npm run dev:full` 在 bash 环境下会报 `spawn cmd.exe ENOENT`，请始终用两个终端分别启动。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + Vite 5 + Tailwind CSS 3 |
| 后端 | Node.js + Express 4（ESM） |
| 持久化 | JSON 文件（`backend/data/store.json`） |
| 图标 | lucide-react |

---

## 项目结构

```
zdf-ai-platform/
├── src/
│   └── App.jsx          # 全部前端逻辑（单文件）
├── backend/
│   ├── server.js        # Express API + 多厂商 LLM 调度
│   └── data/store.json  # 持久化数据库
├── postcss.config.cjs   # 注意：必须是 .cjs，否则 ES module 冲突
└── vite.config.js       # 端口 8080，/api 代理到 3000
```

---

## 默认管理员账号

```
用户名：admin123
密码：  admin456
套餐：  enterprise
```

---

## 套餐体系（ZDF_AI 设计方案 V1.0）

### 订阅模式
采用 **AI 能力等级订阅**，而非传统聊天次数模式。

### Free 免费版
- 适用：AI 爱好者、普通用户、内容创作者
- 每日任务：20 次 | 并发：1 | 上下文：32K | 历史记录：7 天
- 支持模型：DeepSeek、Qwen、GPT-4.1-mini
- 不支持：RAG、API、导出

### Pro 专业版
- 适用：开发者、工程师、AI 从业者、自媒体
- 价格：29~59 EUR/月（欧洲）· 199~399 RMB/月（中国）
- 每日任务：500 次 | 并发：5 | 上下文：256K | 历史：永久
- 支持：完整四级流水线、Prompt 模板、API 接口、RAG 基础版、PDF/Word 导出

### Enterprise 企业版
- 适用：企业、金融、法务、能源、政府
- 无限任务 | 50+ 并发 | 无限上下文 | 历史：永久
- 核心能力：私有化部署、企业知识库、RBAC 权限、审计日志、工作流编排、本地模型、SLA 支持

---

## AI Credit 体系

用 Credit 代替直接展示 Token，对用户更友好。

| 操作 | 消耗 |
|------|------|
| 普通单模型任务 | 1 Credit |
| 四模型协同流水线 | 5 Credits |
| 深度推理 | 20 Credits |
| RAG 审核 | 10 Credits |

后台换算：Credit → Token → 实际成本

---

## 后台监管系统（待完善）

后台需监管：
1. **Token 使用量**：输入 Token、输出 Token、Embedding Token
2. **模型成本**：用户成本、平台成本、盈利情况
3. **并发限制**：Free 1 · Pro 5 · Enterprise 50+
4. **知识库存储**：Free 100MB · Pro 10GB · Enterprise 无限

---

## 用户中心 Dashboard（已实现）

用户实时可见：
- 当前套餐 + 今日任务进度条
- Credits 已用
- 历史记录条数与保留策略
- 导出权限状态
- 套餐功能对比表

推荐后续增加：Token 趋势图、使用排行、超额预警

---

## 支持的 AI 厂商

| 厂商 | 协议 | 备注 |
|------|------|------|
| OpenAI | OpenAI 兼容 | gpt-4o, gpt-4o-mini 等 |
| DeepSeek | OpenAI 兼容 | deepseek-chat, deepseek-coder |
| Moonshot | OpenAI 兼容 | moonshot-v1-8k |
| 智谱 GLM | OpenAI 兼容 | glm-4, glm-4v |
| 阿里云通义 | OpenAI 兼容 | qwen-max, qwen-plus, qwen-turbo |
| Anthropic | 原生 API | claude-3.5-sonnet, opus, haiku |
| Google Gemini | 原生 API | gemini-2.0-flash（默认） |

无 API Key 时自动降级为结构化模拟回复（stub），不影响 UI 联调。

---

## Testing

- After making any code changes, always run the full test suite (`pytest`) and report the number of passing/failing tests before considering the task complete.
- When patching/mocking in tests, always verify the patch target path matches the actual import path used in the source module (patch where it's used, not where it's defined).

---

## Refactoring

- When renaming or refactoring dictionary keys, state fields, or schema properties, grep the entire codebase for all references to the old name and update them in a single pass.

---

## 已知注意事项

- `postcss.config.js` 必须命名为 `.cjs`，项目 `type: module` 会导致 CommonJS 语法报错
- Gemini 默认模型为 `gemini-2.0-flash`，`gemini-1.5-flash` 已废弃
- `backend/data/store.json` 包含 API Key，不应提交到 git（已在 .gitignore 中）
- `.docx` 设计文档和 `doc_content.txt` 已加入 .gitignore，不提交到仓库
