import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeRagFilename,
  resetCodeMatches,
  normalizePublicBase,
  timingSafeEqualStr,
  generateOAuthState,
  oauthStateCookieName,
  parseCreditCost,
} from './security-utils.js';

describe('security-utils (no HTTP server)', () => {
  describe('sanitizeRagFilename', () => {
    it('preserves a safe extension when truncating a long name', () => {
      const longStem = 'a'.repeat(250);
      const out = sanitizeRagFilename(`${longStem}.pdf`, 111);
      assert.ok(out.endsWith('.pdf'), `expected .pdf suffix, got ${out}`);
      assert.equal(out, `111_${'a'.repeat(196)}.pdf`);
    });

    it('keeps short names and allowed extensions intact', () => {
      assert.equal(sanitizeRagFilename('notes.md', 42), '42_notes.md');
    });

    it('drops an extension that is not in the allow-list', () => {
      const out = sanitizeRagFilename('payload.exe', 7);
      assert.equal(out, '7_payload');
      assert.ok(!out.endsWith('.exe'));
    });
  });

  describe('resetCodeMatches', () => {
    const token = 'abcdef12zzzzzzzz';
    it('accepts the exact 8-character prefix (case-insensitive)', () => {
      assert.equal(resetCodeMatches(token, 'ABCDEF12'), true);
      assert.equal(resetCodeMatches(token, 'abcdef12'), true);
    });
    it('rejects a 1-character prefix (the main-branch bug)', () => {
      assert.equal(resetCodeMatches(token, 'a'), false);
    });
    it('rejects a 7-character prefix and a 9-character string', () => {
      assert.equal(resetCodeMatches(token, 'abcdef1'), false);
      assert.equal(resetCodeMatches(token, 'abcdef12z'), false);
    });
  });

  describe('normalizePublicBase', () => {
    it('maps empty and / to no prefix', () => {
      assert.equal(normalizePublicBase(''), '');
      assert.equal(normalizePublicBase('/'), '');
      assert.equal(normalizePublicBase(undefined), '');
    });
    it('normalizes /BestAnswer/ to /BestAnswer', () => {
      assert.equal(normalizePublicBase('/BestAnswer/'), '/BestAnswer');
      assert.equal(normalizePublicBase('BestAnswer'), '/BestAnswer');
    });
  });

  describe('oauth helpers', () => {
    it('generates a hex state and a per-provider cookie name', () => {
      const a = generateOAuthState();
      const b = generateOAuthState();
      assert.equal(a.length, 32);
      assert.notEqual(a, b);
      assert.equal(oauthStateCookieName('github'), 'oauth_state_github');
    });
    it('timingSafeEqualStr rejects different lengths without throwing', () => {
      assert.equal(timingSafeEqualStr('ab', 'a'), false);
      assert.equal(timingSafeEqualStr('ab', 'ab'), true);
    });
  });

  describe('parseCreditCost', () => {
    it('keeps explicit 0 (must not coerce to 1)', () => {
      assert.equal(parseCreditCost(0), 0);
      assert.equal(parseCreditCost('0'), 0);
    });

    it('accepts positive costs and defaults missing/invalid to 1', () => {
      assert.equal(parseCreditCost(5), 5);
      assert.equal(parseCreditCost('5'), 5);
      assert.equal(parseCreditCost(undefined), 1);
      assert.equal(parseCreditCost(null), 1);
      assert.equal(parseCreditCost(''), 1);
      assert.equal(parseCreditCost('abc'), 1);
      assert.equal(parseCreditCost(NaN), 1);
    });

    it('clamps negatives to 0', () => {
      assert.equal(parseCreditCost(-3), 0);
    });

    it('sums skipped-role pipeline costs to pipeline total (not +1 per role)', () => {
      // 四角色：前端对非计费角色传 0，旧逻辑 Number(0)||1 会多记 3 → 总计 8
      const fourRole = [0, 0, 0, 5].map(parseCreditCost);
      assert.equal(fourRole.reduce((a, b) => a + b, 0), 5);
      // A+C（跳过 B/D）：旧逻辑会把 A 的 0 记成 1 → 总计 6
      const aPlusC = [0, 5].map(parseCreditCost);
      assert.equal(aPlusC.reduce((a, b) => a + b, 0), 5);
    });
  });
});
