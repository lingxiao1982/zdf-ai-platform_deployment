/**
 * 将前端展示用模型名映射为各平台常用 API 模型 id。
 * @param {string} vendor
 * @param {string} model
 * @returns {string}
 */
export function resolveApiModel(vendor, model) {
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
    // 千问AI平台：先匹配完整新 ID，避免 qwen3.8-max / qwen3.7-plus 被旧别名正则误伤
    if (/qwen3\.8-max/i.test(m)) return 'qwen3.8-max';
    if (/qwen3\.7-plus/i.test(m)) return 'qwen3.7-plus';
    if (/qwen3\.8-flash/i.test(m)) return 'qwen3.8-flash';
    if (/^qwen3[\w.\-]*$/i.test(m)) return m;
    if (/max/i.test(m)) return 'qwen3.8-max';
    if (/plus/i.test(m)) return 'qwen3.7-plus';
    return 'qwen3.8-flash';
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
