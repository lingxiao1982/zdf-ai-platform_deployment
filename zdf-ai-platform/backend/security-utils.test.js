import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeRagFilename,
  resetCodeMatches,
  normalizePublicBase,
  timingSafeEqualStr,
  generateOAuthState,
  oauthStateCookieName,
  resolveServerCreditCost,
  PipelinePassBook,
  SERVER_CREDIT_COSTS,
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

  describe('resolveServerCreditCost (server-authoritative)', () => {
    it('ignores client under-billing: A / missing role never charge 0', () => {
      assert.equal(resolveServerCreditCost({ roleId: 'A' }), SERVER_CREDIT_COSTS.pipeline);
      assert.equal(resolveServerCreditCost({}), SERVER_CREDIT_COSTS.single);
      assert.equal(resolveServerCreditCost({ roleId: 'B', hasPipelinePass: false }), SERVER_CREDIT_COSTS.pipeline);
      assert.equal(resolveServerCreditCost({ roleId: 'D', hasPipelinePass: false }), SERVER_CREDIT_COSTS.pipeline);
    });

    it('allows 0 only for B/C/D with a valid server-issued pass', () => {
      assert.equal(resolveServerCreditCost({ roleId: 'B', hasPipelinePass: true }), 0);
      assert.equal(resolveServerCreditCost({ roleId: 'C', hasPipelinePass: true }), 0);
      assert.equal(resolveServerCreditCost({ roleId: 'D', hasPipelinePass: true }), 0);
      // A 即使声称有 pass 也仍按 pipeline 计费（并会重新签发）
      assert.equal(resolveServerCreditCost({ roleId: 'A', hasPipelinePass: true }), SERVER_CREDIT_COSTS.pipeline);
    });

    it('prices RAG on the server', () => {
      assert.equal(resolveServerCreditCost({ roleId: 'A', useRag: true }), SERVER_CREDIT_COSTS.rag);
    });

    it('honest four-role and A+C pipelines still total 5 with pass book', () => {
      const book = new PipelinePassBook();
      const uid = 'u1';
      const charge = (roleId) => {
        const hasPipelinePass = book.hasValid(uid) && ['B', 'C', 'D'].includes(roleId);
        const cost = resolveServerCreditCost({ roleId, hasPipelinePass });
        if (roleId === 'A') book.open(uid);
        else if (hasPipelinePass && cost === 0) book.consume(uid);
        return cost;
      };
      assert.equal(['A', 'B', 'C', 'D'].map(charge).reduce((a, b) => a + b, 0), 5);

      const book2 = new PipelinePassBook();
      const uid2 = 'u2';
      const charge2 = (roleId) => {
        const hasPipelinePass = book2.hasValid(uid2) && ['B', 'C', 'D'].includes(roleId);
        const cost = resolveServerCreditCost({ roleId, hasPipelinePass });
        if (roleId === 'A') book2.open(uid2);
        else if (hasPipelinePass && cost === 0) book2.consume(uid2);
        return cost;
      };
      assert.equal(['A', 'C'].map(charge2).reduce((a, b) => a + b, 0), 5);
    });

    it('B without pass cannot under-bill even if client would send 0', () => {
      const book = new PipelinePassBook();
      assert.equal(book.hasValid('attacker'), false);
      assert.equal(
        resolveServerCreditCost({ roleId: 'B', hasPipelinePass: book.hasValid('attacker') }),
        SERVER_CREDIT_COSTS.pipeline,
      );
    });
  });

  describe('PipelinePassBook', () => {
    it('expires and limits continuations', () => {
      let now = 1_000_000;
      const book = new PipelinePassBook({ ttlMs: 1000, maxContinuations: 2, now: () => now });
      book.open('u');
      assert.equal(book.hasValid('u'), true);
      assert.equal(book.consume('u'), true);
      assert.equal(book.consume('u'), true);
      assert.equal(book.hasValid('u'), false);

      book.open('u2');
      now += 1001;
      assert.equal(book.hasValid('u2'), false);
    });
  });
});
