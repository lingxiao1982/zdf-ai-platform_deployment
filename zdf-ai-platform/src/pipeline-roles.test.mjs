/**
 * 可选调度角色：跳过/透传与提醒文案。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_DISABLED_VENDOR,
  isRoleConfigured,
  getUnconfiguredOptionalRoles,
  formatUnconfiguredReminder,
  generatorRequiredMessage,
  buildPipelinePlan,
  lastCompletedOutput,
  buildRoleBPrompt,
  buildRoleCPrompt,
  buildRoleDPrompt,
  pickFinalResult,
} from './pipeline-roles.js';

const ROLES = [
  { id: 'A', name: '生成者' },
  { id: 'B', name: '校核者' },
  { id: 'C', name: '审核者' },
  { id: 'D', name: '终审者' },
];

const enabled = (vendor, model) => ({ vendor, model, mode: 'platform', key: '', enabled: true });
const disabled = () => ({ vendor: ROLE_DISABLED_VENDOR, model: '', mode: 'platform', key: '', enabled: false });

describe('isRoleConfigured', () => {
  it('treats default vendor+model as configured', () => {
    assert.equal(isRoleConfigured(enabled('deepseek', 'deepseek-v4-pro')), true);
  });

  it('treats 不启用 / empty vendor as unconfigured', () => {
    assert.equal(isRoleConfigured(disabled()), false);
    assert.equal(isRoleConfigured({ vendor: '', model: 'x', enabled: true }), false);
    assert.equal(isRoleConfigured({ vendor: 'openai', model: '', enabled: true }), false);
    assert.equal(isRoleConfigured(null), false);
  });
});

describe('reminder copy', () => {
  it('lists B and C when only those are unconfigured', () => {
    const configs = {
      A: enabled('deepseek', 'deepseek-v4-pro'),
      B: disabled(),
      C: disabled(),
      D: enabled('openai', 'gpt-4.1'),
    };
    const unconfigured = getUnconfiguredOptionalRoles(configs, ROLES);
    assert.deepEqual(unconfigured.map((r) => r.name), ['校核者', '审核者']);
    assert.equal(
      formatUnconfiguredReminder(unconfigured),
      '尚未配置：校核者、审核者。若不配置，执行时将跳过这些角色。',
    );
  });

  it('lists B, C, D when all optional roles are off', () => {
    const configs = {
      A: enabled('deepseek', 'deepseek-v4-pro'),
      B: disabled(),
      C: disabled(),
      D: disabled(),
    };
    const text = formatUnconfiguredReminder(getUnconfiguredOptionalRoles(configs, ROLES));
    assert.equal(text, '尚未配置：校核者、审核者、终审者。若不配置，执行时将跳过这些角色。');
  });

  it('returns empty reminder when all four are configured', () => {
    const configs = {
      A: enabled('deepseek', 'deepseek-v4-pro'),
      B: enabled('alibaba', 'qwen3.8-max'),
      C: enabled('anthropic', 'claude-sonnet-4-6'),
      D: enabled('openai', 'gpt-4.1'),
    };
    assert.equal(formatUnconfiguredReminder(getUnconfiguredOptionalRoles(configs, ROLES)), '');
  });

  it('exposes generator-required message for A', () => {
    assert.match(generatorRequiredMessage(), /生成者/);
  });
});

describe('pipeline plan / pass-through', () => {
  it('runs A then D when B and C are disabled', () => {
    const configs = {
      A: enabled('deepseek', 'deepseek-v4-pro'),
      B: disabled(),
      C: disabled(),
      D: enabled('openai', 'gpt-4.1'),
    };
    const plan = buildPipelinePlan(configs);
    assert.deepEqual(plan, [
      { id: 'A', action: 'run' },
      { id: 'B', action: 'skip' },
      { id: 'C', action: 'skip' },
      { id: 'D', action: 'run' },
    ]);
  });

  it('runs only A when B/C/D are disabled; final is A', () => {
    const configs = {
      A: enabled('deepseek', 'deepseek-v4-pro'),
      B: disabled(),
      C: disabled(),
      D: disabled(),
    };
    const plan = buildPipelinePlan(configs);
    assert.deepEqual(plan.map((s) => s.action), ['run', 'skip', 'skip', 'skip']);
    const results = { A: '答案A', B: '', C: '', D: '' };
    assert.equal(pickFinalResult(results, plan), '答案A');
  });

  it('C receives last completed (A) when B is skipped', () => {
    const skipped = { B: true };
    const results = { A: '初稿A', B: '', C: '', D: '' };
    const prior = lastCompletedOutput(results, skipped, ['A', 'B']);
    assert.equal(prior, '初稿A');
    assert.equal(buildRoleCPrompt(prior), '校核稿:\n初稿A\n任务: 润色。');
  });

  it('D prompt includes only completed stages (no fake B/C)', () => {
    const skipped = { B: true, C: true };
    const results = { A: '生成内容', B: '', C: '' };
    const prompt = buildRoleDPrompt('用户问题', results, skipped);
    assert.match(prompt, /原始问题: 用户问题/);
    assert.match(prompt, /阶段A（生成者）输出:\n生成内容/);
    assert.equal(prompt.includes('阶段B'), false);
    assert.equal(prompt.includes('阶段C'), false);
    assert.equal(prompt.includes('校核者）输出'), false);
  });

  it('keeps classic four-stage prompts when nothing is skipped', () => {
    assert.equal(
      buildRoleBPrompt('Q', 'Aout'),
      '问题: Q\n初稿:\nAout\n任务: 事实校核。',
    );
    const prompt = buildRoleDPrompt('Q', { A: 'a', B: 'b', C: 'c' }, {});
    assert.match(prompt, /阶段A（生成者）输出:\na/);
    assert.match(prompt, /阶段B（校核者）输出:\nb/);
    assert.match(prompt, /阶段C（审核者）输出:\nc/);
  });

  it('pickFinalResult uses D when D ran', () => {
    const plan = buildPipelinePlan({
      A: enabled('a', '1'),
      B: disabled(),
      C: disabled(),
      D: enabled('d', '1'),
    });
    assert.equal(pickFinalResult({ A: 'a', B: '', C: '', D: 'final-d' }, plan), 'final-d');
  });
});
