# DataStack — Production Readiness / FINAL-ACCEPTANCE-02

> Evidence cutoff: 2026-11-28 UTC; read terminal Actions run links for any later state. This is an **unmerged candidate**, not an operational release authorization.

## Verified identity and boundaries

- **Canonical:** https://dev.vib.tools/vibtools/DataStack; frozen `main` SHA `4959b69bb25b46a16509bfc4755d13bad87347a9`, tree `37bffae18e2abb6d66a1ae7e1cc6599b48593ee1`; GitHub, GitLab and clean Local PC mirror tree parity 420/420 before this candidate.
- **One candidate:** `final-acceptance-02-closeout`; [Gitea draft PR #1](https://dev.vib.tools/vibtools/DataStack/pulls/1), base `main`. **Do not merge** without all mandatory gates PASS.
- **Previous source:** `dev.ivib.cc` PR #13 branch/candidate unavailable: recovery attempt failed (no local Git object; endpoint timed out). Reconstructed patches in this branch are independent, not recovered originals. Old PR #4 untouched.
- **Preserve:** UI/UX, WebSocket/REST/SDK/MCP contracts, auth/RBAC/CSRF/SSRF, File Manager and ZIP/UNZIP, Redis ACK/idempotency, CSV/gzip and DB schema, persistent volumes, secrets and live production. No feature removal, bypasses, personal-PC builds, destructive operations, tags or releases.

## Verified focused acceptance

| Gitea Actions | Source/result | Boundary |
| --- | --- | --- |
| [#12](https://dev.vib.tools/vibtools/DataStack/actions/runs/12) | Focused Windows Python SDK **SUCCESS**, 14/14 | Python test fixture uses valid quoted Windows spool path, no SDK API/parser change |
| [#14](https://dev.vib.tools/vibtools/DataStack/actions/runs/14) | Focused Node webhook **SUCCESS**, 6/6 | Event-driven bounded async dispatch assertion replaces flaky 60ms sleep |
| [#15](https://dev.vib.tools/vibtools/DataStack/actions/runs/15) | Linux clean npm install and four patch application **SUCCESS**, Node SDK build; webhook 6/6; File Manager/security 8/8 | Source SHA `9a3796ceb5ec8cfe9062ce155c7379ecd7c2ed34`; not full release acceptance |
| [#16](https://dev.vib.tools/vibtools/DataStack/actions/runs/16) | Native Windows patch/npm SDK/File Manager focused CI **DISPATCHED** on `d08ffae878dcec65a8e103e3fa476018f778c532` | Check real terminal outcome; never assume PASS |
| [#13](https://dev.vib.tools/vibtools/DataStack/actions/runs/13) | **SKIPPED**, not PASS | Narrow workflow condition corrected |
| [#9](https://dev.vib.tools/vibtools/DataStack/actions/runs/9) | Original main **FAILED** 5 SUCCESS / 2 FAILURE (Node, Docker) | No new full release test performed |

## Security decision matrix — candidate only

| Root GHSA | Existing affected source | Candidate correction | Acceptance |
| --- | --- | --- | --- |
| `got` GHSA-pfrx-2q88-qq97 | `10.7.0` via `dropbox-stream` | Guard redirect from HTTP(S) to UNIX socket | Linux regression PASS; Windows pending; audit remains version-based |
| `glob` GHSA-3g3m-2fjr-6pw4 | `10.5.0` (also `13.0.7` transitive) | Abort early return v10; v13 already had corresponding returns | Linux regression PASS; exposure/audit pending |
| `minimatch` GHSA-g3hv-75wg-m249 | `9.0.9`, `10.2.6` | Cap glob expansion and O(n²) deduplication | Linux regression PASS; broader API/platform acceptance pending |
| `file-type` GHSA-5v7r-6r5c-r473 | nested `16.5.4` via `ponse` | Detect malformed ASF parser non-progress | Linux regression PASS; Windows pending |

Upstream evidence: Got `861ccd9ac2237df762a9e2beed7edd88c60782dc`; glob official v14.0.2 change; minimatch `77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8`; file-type `319abf871b50ba2fa221b4a7050059f1ae096f4f`. The app uses strict `package-lock.json`; `npm ci` applies four context-checked idempotent patch files or exits nonzero. No arbitrary major-version overrides. **Historic npm audit**: runtime 20 Moderate/full 22 Moderate; 0 High/Critical. Fresh inventory and advisory-specific residual-risk decision **PENDING**; do not claim `npm audit` zero from patched installed code.

## Mandatory Docker acceptance — BLOCKED

The existing Gitea `ubuntu-latest` Actions runner exposes an occupied/shared Docker daemon. [Main CI #9](https://dev.vib.tools/vibtools/DataStack/actions/runs/9) aborted its Docker job with `DATASTACK_DOCKER_HOST_NOT_ISOLATED` BEFORE three image builds. Old Gitea #132 found production-like containers and similarly failed closed. This is an intentional safety rule, NOT an excuse to disable it.

**Exact safe infrastructure prerequisite:** independently isolated non-production Docker daemon, owned by a dedicated runner or ephemeral VM, with no shared production Docker socket, volumes, namespaces, data or network; an independently verified preflight before any build. Only then test 3 Docker images, Compose web/ingestion/proxy/Redis/PostgreSQL, health/auth, clean shutdown, disposable Postgres fixture backup/restore, Redis ACK/restart, CSV/gzip recovery, previous-image rollback, and cleanup of owned test resources. **All unexecuted, not PASS.**

## Full release candidate gate — PENDING

On verified final candidate SHA only, run the authorized single consolidated Gitea Actions acceptance: Linux/Windows/Node/Python SDK, auth/SSRF/RBAC/CSRF, File Manager and ZIP, Redis/CSV/MCP, Next/TS/ESLint, security installed-code and audit, three Docker images and five-service recovery/rollback, exact changed-path diff. All mandatory jobs must be terminal SUCCESS. Do not reuse historic CI for new source changes.

## Production operations and rollback — separate authorization

Before actual Production GO, read-only verify TLS/ingress/proxy/DNS/firewall, token/session/DB/Redis secret requirements without recording secret values, persisted backup schedule and proven restore, health monitoring/alerts/oncall ownership, capacity and log retention, migration safety, outage rollback version/commands and maintenance window. **No live mutations, deployment, DNS, secrets, restore, tag or release under this task.**

## Readiness

**RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.** Patch application and focused Linux tests are positive evidence but do not close residual advisories or disposable Docker validation. Draft PR remains unmerged; three remotes and Local PC preserve the previously accepted main. Continue only within authorized Scope Lock and without creating another phase.
