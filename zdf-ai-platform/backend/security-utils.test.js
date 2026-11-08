import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeRagFilename,
  resetCodeMatches,
  normalizePublicBase,
  timingSafeEqualStr,
  generateOAuthState,
  oauthStateCookieName,
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
});
