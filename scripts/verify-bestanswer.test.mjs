import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runChecks, extractHashedAssets, looksLikeHtml, isHealthyJson, assertAllowedUrl } from './verify-bestanswer.mjs';

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function goodHandler(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/BestAnswer' || url === '/BestAnswer/') {
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
      '<!doctype html><html><head>'
      + '<script type="module" src="/BestAnswer/assets/index-TESTHASH.js"></script>'
      + '<link rel="stylesheet" href="/BestAnswer/assets/index-TESTHASH.css">'
      + '</head><body><div id="root"></div></body></html>');
  }
  if (url === '/BestAnswer/assets/index-TESTHASH.js') {
    return send(res, 200, { 'Content-Type': 'application/javascript' }, 'console.log("ok");');
  }
  if (url === '/BestAnswer/assets/index-TESTHASH.css') {
    return send(res, 200, { 'Content-Type': 'text/css' }, 'body{margin:0}');
  }
  if (url === '/BestAnswer/api/health') {
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ ok: true, service: 'zdf-ai-platform-backend' }));
  }
  if (url === '/SuitAssistant' || url === '/SuitAssistant/') {
    return send(res, 200, { 'Content-Type': 'text/html' }, '<!doctype html><html><body>suit</body></html>');
  }
  if (url === '/') {
    res.writeHead(301, { Location: '/europeBESS-financial/' });
    return res.end();
  }
  if (url === '/europeBESS-financial/' || url === '/europeBESS-financial') {
    return send(res, 200, { 'Content-Type': 'text/html' }, '<!doctype html><html><body>bess</body></html>');
  }
  send(res, 404, { 'Content-Type': 'text/plain' }, 'nope');
}

describe('extractHashedAssets / guards', () => {
  it('extracts hashed js and css without hard-coded filenames', () => {
    const html = '<script src="/BestAnswer/assets/index-Aa1.js"></script>'
      + '<link rel="stylesheet" href="/BestAnswer/assets/index-Bb2.css">';
    const { js, css } = extractHashedAssets(html);
    assert.deepEqual(js, ['/BestAnswer/assets/index-Aa1.js']);
    assert.deepEqual(css, ['/BestAnswer/assets/index-Bb2.css']);
  });

  it('looksLikeHtml detects HTML even without a content-type', () => {
    assert.equal(looksLikeHtml('', '<!DOCTYPE html><html>'), true);
    assert.equal(looksLikeHtml('application/javascript', 'console.log(1)'), false);
  });

  it('isHealthyJson matches live schema', () => {
    assert.equal(isHealthyJson({ ok: true, service: 'zdf-ai-platform-backend' }), true);
    assert.equal(isHealthyJson({ ok: false, service: 'zdf-ai-platform-backend' }), false);
    assert.equal(isHealthyJson({ ok: true }), false);
  });

  it('assertAllowedUrl blocks other origins and paths', () => {
    assert.throws(() => assertAllowedUrl('https://evil.example/BestAnswer/assets/x.js', 'https://zdfai.cn'), /cross-origin/);
    assert.throws(() => assertAllowedUrl('https://zdfai.cn/secret.env', 'https://zdfai.cn'), /allow-list/);
  });
});

describe('runChecks against local fixtures', () => {
  it('good case PASS', async () => {
    const { server, origin } = await startServer(goodHandler);
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, true, result.checks.map((c) => `${c.id}:${c.ok}:${c.detail}`).join('\n'));
    } finally {
      server.close();
    }
  });

  it('catches the old blank-page failure: HTML 200 / hashed assets 404', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/' || url === '/BestAnswer') {
        return send(res, 200, { 'Content-Type': 'text/html' },
          '<!doctype html><script src="/BestAnswer/assets/index-DEAD.js"></script>'
          + '<link rel="stylesheet" href="/BestAnswer/assets/index-DEAD.css">');
      }
      if (url.startsWith('/BestAnswer/assets/')) {
        return send(res, 404, { 'Content-Type': 'text/html' }, '<html>nginx 404</html>');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      const js = result.checks.find((c) => c.id === 'bestanswer-js');
      const css = result.checks.find((c) => c.id === 'bestanswer-css');
      assert.equal(js.ok, false);
      assert.match(js.detail, /404/);
      assert.equal(css.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'bestanswer-html').ok, true);
    } finally {
      server.close();
    }
  });

  it('FAIL when JS/CSS is missing from HTML', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/' || url === '/BestAnswer') {
        return send(res, 200, { 'Content-Type': 'text/html' }, '<!doctype html><html><body>no assets</body></html>');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'bestanswer-js').ok, false);
      assert.equal(result.checks.find((c) => c.id === 'bestanswer-css').ok, false);
    } finally {
      server.close();
    }
  });

  it('FAIL when an asset is HTML even with HTTP 200', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/assets/index-TESTHASH.js') {
        return send(res, 200, { 'Content-Type': 'text/html' }, '<!doctype html><html>spa fallback</html>');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.match(result.checks.find((c) => c.id === 'bestanswer-js').detail, /HTML/);
    } finally {
      server.close();
    }
  });

  it('FAIL on wrong JS content type', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/assets/index-TESTHASH.js') {
        return send(res, 200, { 'Content-Type': 'text/plain' }, 'console.log(1)');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.match(result.checks.find((c) => c.id === 'bestanswer-js').detail, /content-type/);
    } finally {
      server.close();
    }
  });

  it('FAIL on unhealthy JSON', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/api/health') {
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, service: 'down' }));
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.match(result.checks.find((c) => c.id === 'bestanswer-health').detail, /unhealthy/);
    } finally {
      server.close();
    }
  });

  it('FAIL on malformed health JSON', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/api/health') {
        return send(res, 200, { 'Content-Type': 'application/json' }, 'not-json{');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.match(result.checks.find((c) => c.id === 'bestanswer-health').detail, /malformed/);
    } finally {
      server.close();
    }
  });

  it('FAIL on timeout', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/BestAnswer/' || url === '/BestAnswer') {
        /* hang until client aborts */
        return;
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 200 });
      assert.equal(result.ok, false);
      assert.match(result.checks.find((c) => c.id === 'bestanswer-html').detail, /timeout|HTTP failure/);
    } finally {
      server.close();
    }
  });

  it('FAIL on HTTP failure / broken neighbor', async () => {
    const { server, origin } = await startServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url.startsWith('/SuitAssistant')) {
        return send(res, 502, { 'Content-Type': 'text/plain' }, 'bad gateway');
      }
      return goodHandler(req, res);
    });
    try {
      const result = await runChecks({ origin, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'suitassistant-html').ok, false);
      assert.equal(result.checks.find((c) => c.id === 'bestanswer-html').ok, true);
    } finally {
      server.close();
    }
  });
});
