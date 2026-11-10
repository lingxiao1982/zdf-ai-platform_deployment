/**
 * 阿里厂商 → 千问AI平台（OpenAI 兼容）配置与 resolveApiModel 回归。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiModel } from './vendor-resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');

describe('Alibaba → 千问AI平台 endpoints', () => {
  it('chat base uses maas.qianwenaiapi.com/compatible-mode (not DashScope 百炼)', () => {
    assert.match(
      serverSrc,
      /alibaba:\s*\{\s*base:\s*'https:\/\/maas\.qianwenaiapi\.com\/compatible-mode',\s*path:\s*'\/v1\/chat\/completions'\s*\}/,
    );
    assert.equal(serverSrc.includes("alibaba: { base: 'https://dashscope.aliyuncs.com/compatible-mode'"), false);
  });

  it('embeddings use maas.qianwenaiapi.com and qwen3.7-text-embedding', () => {
    assert.match(
      serverSrc,
      /alibaba',\s*base:\s*'https:\/\/maas\.qianwenaiapi\.com\/compatible-mode\/v1\/embeddings',\s*model:\s*'qwen3\.7-text-embedding'/,
    );
    assert.equal(serverSrc.includes('dashscope.aliyuncs.com/compatible-mode/v1/embeddings'), false);
  });

  it('TEST_KEY_MODEL probe is qwen3.8-flash, not retired qwen-turbo', () => {
    assert.match(serverSrc, /alibaba:\s*'qwen3\.8-flash'/);
    assert.equal(/alibaba:\s*'qwen-turbo'/.test(serverSrc), false);
  });

  it('DEFAULT_VENDORS / FALLBACK_VENDORS list current 千问 models only', () => {
    for (const src of [serverSrc, appSrc]) {
      assert.match(src, /id: 'alibaba'[\s\S]*?models: \['qwen3\.8-max', 'qwen3\.7-plus', 'qwen3\.8-flash'\]/);
      assert.equal(/models: \[[^\]]*qwen-turbo/.test(src), false);
      assert.equal(/models: \[[^\]]*qwq-plus/.test(src), false);
    }
  });

  it('key hint points at 千问AI平台 sk-ws- keys', () => {
    assert.match(appSrc, /alibaba:\s*'sk-ws-\.\.\. \(千问AI平台\)'/);
    assert.equal(appSrc.includes('阿里云百炼'), false);
  });

  it('default Alibaba lane uses qwen3.8-max', () => {
    assert.match(appSrc, /B:\s*\{\s*vendor:\s*'alibaba',\s*model:\s*'qwen3\.8-max'/);
  });
});

describe('resolveApiModel(alibaba)', () => {
  it('preserves current 千问AI平台 IDs without coercing to retired aliases', () => {
    assert.equal(resolveApiModel('alibaba', 'qwen3.8-max'), 'qwen3.8-max');
    assert.equal(resolveApiModel('alibaba', 'qwen3.7-plus'), 'qwen3.7-plus');
    assert.equal(resolveApiModel('alibaba', 'qwen3.8-flash'), 'qwen3.8-flash');
  });

  it('does not fall back to retired qwen-turbo / qwq-plus', () => {
    const unknown = resolveApiModel('alibaba', 'something-unknown');
    assert.equal(unknown, 'qwen3.8-flash');
    assert.notEqual(unknown, 'qwen-turbo');
    assert.notEqual(resolveApiModel('alibaba', 'qwq-plus'), 'qwq-plus');
  });

  it('maps legacy display names onto current served models', () => {
    assert.equal(resolveApiModel('alibaba', 'qwen-max'), 'qwen3.8-max');
    assert.equal(resolveApiModel('alibaba', 'qwen-plus'), 'qwen3.7-plus');
    assert.equal(resolveApiModel('alibaba', 'qwen-turbo'), 'qwen3.8-flash');
  });
});
