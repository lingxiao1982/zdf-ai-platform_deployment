import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseLocations, matchLocation, summarizeMatch } from './nginx-location-priority.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NEW_CONF = fs.readFileSync(path.join(here, 'fixtures/nginx-shared-host.conf'), 'utf8');
const OLD_CONF = fs.readFileSync(path.join(here, 'fixtures/nginx-shared-host-old-blank-page.conf'), 'utf8');
const REPO_SNIPPET = fs.readFileSync(path.join(here, '../nginx-bestanswer.conf'), 'utf8');

const HASHED_JS = '/BestAnswer/assets/index-DBm7z36C.js';
const HASHED_CSS = '/BestAnswer/assets/index-DKkDbiMe.css';
const GLOBAL_REGEX = '\\.(?:js|css|html)$';

describe('nginx location priority (shared-host regex context)', () => {
  it('OLD prefix without ^~ loses hashed assets to the global static regex (blank-page cause)', () => {
    const locs = parseLocations(OLD_CONF);
    const js = matchLocation(HASHED_JS, locs);
    const css = matchLocation(HASHED_CSS, locs);
    assert.equal(js.reason, 'regex');
    assert.equal(js.location.pattern, GLOBAL_REGEX);
    assert.equal(css.reason, 'regex');
  });

  it('NEW ^~ prefix keeps hashed assets on BestAnswer, not the global regex', () => {
    const locs = parseLocations(NEW_CONF);
    const js = summarizeMatch(HASHED_JS, locs);
    const css = summarizeMatch(HASHED_CSS, locs);
    assert.equal(js.reason, 'prefix-caret');
    assert.equal(js.pattern, '/BestAnswer/');
    assert.equal(css.reason, 'prefix-caret');
    assert.equal(css.pattern, '/BestAnswer/');
  });

  it('preserves /BestAnswer exact redirect and does not steal neighbors', () => {
    const locs = parseLocations(NEW_CONF);
    const exact = matchLocation('/BestAnswer', locs);
    assert.equal(exact.reason, 'exact');
    assert.equal(exact.location.pattern, '/BestAnswer');

    const suitJs = matchLocation('/SuitAssistant/app.js', locs);
    assert.equal(suitJs.reason, 'regex', 'neighbor JS still hits the global regex (we do not rewrite SuitAssistant)');

    const bess = matchLocation('/europeBESS-financial/', locs);
    assert.equal(bess.location.pattern, '/europeBESS-financial/');
  });

  it('repo nginx-bestanswer.conf uses ^~ /BestAnswer/ and keeps the = /BestAnswer redirect', () => {
    const locs = parseLocations(REPO_SNIPPET);
    const exact = locs.find((l) => l.modifier === '=' && l.pattern === '/BestAnswer');
    const prefix = locs.find((l) => l.pattern === '/BestAnswer/');
    assert.ok(exact, 'missing location = /BestAnswer');
    assert.ok(prefix, 'missing location /BestAnswer/');
    assert.equal(prefix.modifier, '^~');
    const js = matchLocation(HASHED_JS, [...locs, {
      modifier: '~*',
      pattern: GLOBAL_REGEX,
      order: 99,
    }]);
    assert.equal(js.reason, 'prefix-caret');
    assert.equal(js.location.pattern, '/BestAnswer/');
  });
});

describe('isolated nginx -t (optional)', () => {
  it('runs nginx -t on the shared-host fixture when nginx is installed', () => {
    const probe = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
    if (probe.error && probe.error.code === 'ENOENT') {
      console.log('LIMITATION: nginx binary not installed in this environment; skipped nginx -t. Location-priority tests above still ran.');
      return;
    }
    const conf = path.join(here, 'fixtures/nginx-shared-host.conf');
    const r = spawnSync('nginx', ['-t', '-c', conf], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, `nginx -t failed: ${out}`);
  });
});
