/**
 * 调度角色可选启用/跳过逻辑（纯函数，便于单测）。
 * 生成者 A 必选；校核者 B、审核者 C、终审者 D 可「不启用」。
 */

/** @typedef {{ vendor?: string, model?: string, mode?: string, key?: string, enabled?: boolean }} RoleConfig */

/** 可选角色（可不启用） */
export const OPTIONAL_ROLE_IDS = ['B', 'C', 'D'];

/** 厂商下拉中的「不启用」哨兵值 */
export const ROLE_DISABLED_VENDOR = '__disabled__';

/** 推理过程/结果中标记已跳过的文案 */
export const SKIPPED_LABEL = '已跳过';

/**
 * 判断角色是否已配置（启用且选定厂商与模型）。
 * @param {RoleConfig | null | undefined} config
 * @returns {boolean}
 */
export function isRoleConfigured(config) {
  if (!config) return false;
  if (config.enabled === false) return false;
  if (config.vendor === ROLE_DISABLED_VENDOR || !config.vendor) return false;
  if (!config.model) return false;
  return true;
}

/**
 * 列出未配置的可选角色（按 B→C→D）。
 * @param {Record<string, RoleConfig>} configs
 * @param {Array<{ id: string, name: string }>} roles
 * @returns {Array<{ id: string, name: string }>}
 */
export function getUnconfiguredOptionalRoles(configs, roles) {
  const byId = Object.fromEntries((roles || []).map((r) => [r.id, r]));
  return OPTIONAL_ROLE_IDS
    .filter((id) => !isRoleConfigured(configs?.[id]))
    .map((id) => ({ id, name: byId[id]?.name || id }));
}

/**
 * 生成调度面板提醒文案；全部可选角色已配置时返回空串。
 * @param {Array<{ id: string, name: string }>} unconfigured
 * @returns {string}
 */
export function formatUnconfiguredReminder(unconfigured) {
  if (!unconfigured?.length) return '';
  const names = unconfigured.map((r) => r.name).join('、');
  return `尚未配置：${names}。若不配置，执行时将跳过这些角色。`;
}

/**
 * 生成者 A 未配置时的阻断提示。
 * @returns {string}
 */
export function generatorRequiredMessage() {
  return '请先配置生成者后再执行流水线。';
}

/**
 * 按配置生成执行计划：run 或 skip。
 * @param {Record<string, RoleConfig>} configs
 * @param {string[]} [order]
 * @returns {Array<{ id: string, action: 'run' | 'skip' }>}
 */
export function buildPipelinePlan(configs, order = ['A', 'B', 'C', 'D']) {
  return order.map((id) => ({
    id,
    action: isRoleConfigured(configs?.[id]) ? 'run' : 'skip',
  }));
}

/**
 * 取最近一次已完成（非跳过）角色的输出，供下游角色作为输入。
 * @param {Record<string, string>} results
 * @param {Set<string> | Record<string, boolean>} skipped
 * @param {string[]} upToIds 按顺序的角色 id，取其中最后一个有效输出
 * @returns {string}
 */
export function lastCompletedOutput(results, skipped, upToIds) {
  const isSkipped = (id) => {
    if (!skipped) return false;
    if (skipped instanceof Set) return skipped.has(id);
    return Boolean(skipped[id]);
  };
  let last = '';
  for (const id of upToIds) {
    if (isSkipped(id)) continue;
    const text = results?.[id];
    if (typeof text === 'string' && text.length > 0) last = text;
  }
  return last;
}

/**
 * 构造校核者 B 的用户提示。
 * @param {string} question
 * @param {string} draftA
 * @returns {string}
 */
export function buildRoleBPrompt(question, draftA) {
  return `问题: ${question}\n初稿:\n${draftA}\n任务: 事实校核。`;
}

/**
 * 构造审核者 C 的用户提示；`priorDraft` 为上一完成角色输出（通常为 B，跳过 B 时为 A）。
 * @param {string} priorDraft
 * @returns {string}
 */
export function buildRoleCPrompt(priorDraft) {
  return `校核稿:\n${priorDraft}\n任务: 润色。`;
}

/**
 * 构造终审者 D 的用户提示；仅纳入实际跑过的阶段，避免伪造跳过角色的输出。
 * @param {string} question
 * @param {Record<string, string>} results
 * @param {Set<string> | Record<string, boolean>} skipped
 * @returns {string}
 */
export function buildRoleDPrompt(question, results, skipped) {
  const isSkipped = (id) => {
    if (!skipped) return false;
    if (skipped instanceof Set) return skipped.has(id);
    return Boolean(skipped[id]);
  };
  const labels = { A: '生成者', B: '校核者', C: '审核者' };
  const parts = [`原始问题: ${question}`];
  for (const id of ['A', 'B', 'C']) {
    if (isSkipped(id)) continue;
    const text = results?.[id];
    if (typeof text !== 'string' || !text) continue;
    parts.push(`\n\n阶段${id}（${labels[id]}）输出:\n${text}`);
  }
  parts.push('\n\n任务: 作为终审者，根据策略输出最终纯文本结果。');
  return parts.join('');
}

/**
 * 取最终答案：最后一个实际执行角色的输出。
 * @param {Record<string, string>} results
 * @param {Array<{ id: string, action: 'run' | 'skip' }>} plan
 * @returns {string}
 */
export function pickFinalResult(results, plan) {
  let last = '';
  for (const step of plan) {
    if (step.action !== 'run') continue;
    const text = results?.[step.id];
    if (typeof text === 'string') last = text;
  }
  return last;
}
