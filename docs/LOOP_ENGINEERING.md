# Loop Engineering — BestAnswer nginx regression + live verifier

This document is the **frozen acceptance contract** for this change. Do not silently weaken it to make a test pass. If a criterion cannot be met, stop and report disagreement to the coordinator.

## Objective

Keep `https://zdfai.cn/BestAnswer/` serving a real SPA (HTML **and** hashed JS/CSS), without breaking BESS (`/` → `/europeBESS-financial/`) or `/SuitAssistant/` on the shared Tencent host. Prove it with a bounded read-only verifier and offline tests. Repository nginx must not regress to the blank-page failure.

## Frozen acceptance criteria

1. **Read-only live verifier** (one command, documented below)
   - BestAnswer HTML is a successful document response (HTTP 200, HTML content type, nonempty body).
   - Dynamically extract current hashed JS and CSS URLs from that HTML (no hard-coded filenames).
   - Each extracted asset: HTTP 200, appropriate JS/CSS content type, nonempty body; **reject fallback HTML even if HTTP 200**.
   - `GET /BestAnswer/api/health` → 200 and valid healthy JSON matching the live schema (`ok === true` and a nonempty `service` string).
   - SuitAssistant HTML still works; root still redirects to the BESS destination, which still serves HTML.
   - No generation, payment, login, or other mutating endpoints.
   - Bounded timeouts and redirects; nonzero exit; per-check evidence; no secrets.
   - Origin/path allow-list: do not fetch arbitrary external assets; do not eval or execute fetched content.
   - No implicit periodic monitoring or auto-deploy.

2. **Offline automated tests** (fixtures / local HTTP server; no production network required)
   - Good case PASS.
   - FAIL cases: missing JS/CSS, HTML-as-asset, wrong content type, unhealthy/malformed JSON, timeout/HTTP failure, broken neighbor.
   - At least one test reproduces the old blank-page failure: HTML 200 + assets 404.

3. **Repo nginx**
   - Preserve `/BestAnswer` → `/BestAnswer/` redirect.
   - BestAnswer (including hashed assets) must take priority over a shared-host global static regex such as `location ~* \.(?:js|css|html)$`.
   - Regression proof in a shared-server regex context. Isolated `nginx -t` / smoke if nginx is available; otherwise label the limitation.
   - Do not rewrite whole-site nginx or neighbor locations. Do not bake production-only ports/secrets into the reusable snippet.

4. **Loop**
   - try → test → fix → save
   - Implementation and independent verification stay distinct (this script vs a later adversarial review).
   - Stop / escalate after ~3 failures on the **same** point.
   - Final self-check: every claim has evidence; missing evidence is listed, not implied.

5. **Process**
   - Narrow edits. No architecture refactor. No merge, no deploy, no production `.env` / `store.json` / data / secrets.

## One-command invocation

From the repository root:

```bash
node scripts/verify-bestanswer.mjs
```

Optional origin override (still must be an https origin you intend to probe; default is `https://zdfai.cn`):

```bash
VERIFY_ORIGIN=https://zdfai.cn node scripts/verify-bestanswer.mjs
```

Offline tests (no production network):

```bash
node --test scripts/verify-bestanswer.test.mjs scripts/nginx-location-priority.test.mjs
```

## try → test → fix → save

1. **try** — make the smallest change that could satisfy one criterion.
2. **test** — run the offline suite first; only then a single low-volume live probe.
3. **fix** — if a test fails, fix the cause; do not delete or loosen the assertion.
4. **save** — commit when that criterion is green.

Live HTTP 200 on HTML is **not** full browser/UI correctness. A live pass may reflect a **pre-existing production hotfix**, not this unmerged PR.

## Implementation vs independent verification

| Role | What it is |
|------|------------|
| This PR | Adds the verifier, offline tests, and repo nginx `^~` so the snippet cannot regress. |
| Live site | May already have a hotfix. Live success ≠ this PR is deployed. |
| Independent review | A later adversarial pass before Henry; not this agent merging or deploying. |

## Stop / escalate

After **three** failed attempts at the same criterion (same assertion still red after three distinct fixes), stop. Report: what failed, commands, outputs, what was tried. Do not weaken the criterion.

## Final self-check (required in the PR body)

- Facts with commands/outputs/SHAs.
- Uncertainties and untested items listed explicitly.
- Live vs offline distinguished.
- Usage and rollback: revert the nginx snippet commit; verifier is read-only and can be ignored.
