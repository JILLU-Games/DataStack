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

## FINAL-ACCEPTANCE-02 — 2026-11-28 10:41 UTC evidence checkpoint

This supersedes earlier pending Windows CI statements; it is not a new phase or release acceptance.

- Frozen authoritative main remains `4959b69bb25b46a16509bfc4755d13bad87347a9`, tree `37bffae18e2abb6d66a1ae7e1cc6599b48593ee1`. Existing draft PR #1, branch `final-acceptance-02-closeout`, remains unmerged. Previous approved candidate `7eb9e7f705276a129cf3b9c2dc0bab999ffc3c8d`, tree `1c1e74ef55e8d2060f2502c1236957c6ea2fe23a`.
- Windows #16 and #17 failed at got patch application; #17 normalized the wrong boundary (installed source rather than patch transport). Diagnostic [run #18/job #59](https://dev.vib.tools/vibtools/DataStack/actions/runs/18/jobs/59), commit `44dc5bd32e1e4085d0d4082e32ed1e9536932918`, completed with expected diagnostic failure after extracting 1,278 locked packages without scripts. Windows system Git `core.autocrlf=true` caused checked-out patches to have 16/91/155/63 CRLF lines respectively (got/glob/minimatch/file-type), while all nine target source files and committed patch blobs had zero CRLF. Raw exact apply checks failed 4/4; normalized LF checks and original Git blob checks passed 4/4. Normalized patch SHA-256 equaled committed blob SHA-256 in every case.
- Corrective commit `2650337f64b20d1b0071fec0ff196b5af5d29a39`, tree `898390f4a4eb1a331a410b47e202e4b2fc1c44e5`, modifies only package.json, existing CI workflow and File Manager test fixture. It normalizes UTF-8 patch transport to LF and passes through stdin, with exact forward/reverse Git checks, no whitespace relaxation and no installed-source line-ending rewrite. The negative got redirect fixture uses a unique nonexistent socket instead of a real Docker socket. Four patch blobs, lockfile and application code unchanged. Exact candidate delta 3 paths; total main-to-candidate diff still 16 approved paths, no deletes.
- Combined focused [run #19](https://dev.vib.tools/vibtools/DataStack/actions/runs/19) dispatched on that exact corrective commit. Linux job #61, Windows #66, audit #67; four unrelated jobs skipped intentionally. At this checkpoint execution is in progress, NOT a final acceptance result. New checks require all four postinstall idempotence markers, official npm registry tarball SHA-512 validation and byte-for-byte patched-source comparison on Linux, plus native Windows clean install/SDK/File Manager and current npm advisory inventory. Existing accepted #12 Windows Python 14/14, #14 webhook 6/6, #15 Linux clean install/4 patches/SDK/webhook 6/6/File Manager 8/8 are preserved as historical evidence.
- Advisory provenance: got GHSA-pfrx-2q88-qq97, upstream sindresorhus/got commit 861ccd9ac2237df762a9e2beed7edd88c60782dc; glob GHSA-3g3m-2fjr-6pw4, isaacs/node-glob 4682e8c9babee1b385202ede36389634e12076d7; minimatch GHSA-g3hv-75wg-m249, isaacs/minimatch 77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8; file-type GHSA-5v7r-6r5c-r473, sindresorhus/file-type 319abf871b50ba2fa221b4a7050059f1ae096f4f. Locked ancestry: cloudcmd -> @cloudcmd/dropbox -> dropbox-stream -> got 10.7.0; inly/onezip/spawnify -> glob 10.5.0 and onezip -> glob 13.0.7; those glob versions -> minimatch 9.0.9 and 10.2.6; restbox/join-io -> ponse -> two nested file-type 16.5.4. Root file-type 21.3.4 outside that advisory; glob 13.0.7 already has relevant abort returns. Cloudcmd 19.24.6 upstream manifest still retains several implicated dependency ranges and changes restbox major version, so not a verified safe replacement. No dependency upgrade. Lock has 1,360 entries, only 91 with integrity and resolved metadata; targeted entries lack integrity metadata. New CI verifies official tarballs and all patched target bytes; does not imply whole-tree cryptographic lock integrity.
- Advisory-specific residual dispositions remain OPEN pending terminal #19 and assessment. Version-based npm audit flags are not equivalent to exploitability or backport failure; do not claim zero findings. Prior runtime 20 Moderate/full 22 Moderate, zero High/Critical are historical only.
- Docker mandatory gate remains BLOCKED: #9 job #13 and historical #132 fail closed on occupied/shared Docker daemon. No verified independent non-production Docker runner is available through authorized Gitea controls; user explicitly prohibits Home VPS access and requires MyPC backup/sync only. No guard bypass, host reconfiguration, Docker runtime tests, service startup, backups/restores, rollback or final consolidated CI. No production action, tag, release, merge or backup candidate sync. Continue within the same existing draft PR once terminal evidence and genuine isolated runner are available; residual-risk acceptance and live deployment are separate decisions. RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.

## FINAL-ACCEPTANCE-02 — Run #19 focused verification result

Exact tested commit `2650337f64b20d1b0071fec0ff196b5af5d29a39` / tree `898390f4a4eb1a331a410b47e202e4b2fc1c44e5`. [Run #19](https://dev.vib.tools/vibtools/DataStack/actions/runs/19) status at capture: **SUCCESS**. Job states: node-regression #61 success; python-regression #62 skipped; quality #63 skipped; production-build #64 skipped; docker-image-build #65 skipped; windows-compatibility #66 success; security-audit #67 success. This is focused cross-platform acceptance, not the final consolidated gate.

- Linux #61 SUCCESS: clean npm ci, all four exact patch applications and idempotence markers, six registry package-version tarballs SHA-512 checked, nine patched source files byte-identical to independently reconstructed tarball+patch outputs, and two existing nested glob walker files byte-identical to official glob 13.0.7 tarball. Node SDK build SUCCESS; lockout/security webhook 6/6 and File Manager/security 8/8 PASS, zero failures. Source integrity evidence includes got, glob, minimatch and file-type, both CJS/ESM where applicable.
- Windows #66: native committed-lock clean install (1,278 packages) SUCCESS, all four patch CRLF normalization and application markers and all four second-run idempotence markers verified; Node SDK compilation SUCCESS; native File Manager CRUD/ZIP/UNZIP/auth/RBAC/CSRF/revocation/traversal and four advisory-specific regression tests 8/8 PASS, zero failed/skipped. Root cause correction accepted at focused test boundary. No npm version/lockfile change.
- Fresh npm audit #67 SUCCESS: runtime 20 Moderate / 0 High / 0 Critical; full 22 Moderate / 0 High / 0 Critical. Runtime inventory has four direct advisory IDs and 16 propagated vulnerable package entries, not 20 distinct vulnerabilities. Full adds build/development-only GHSA-rj75-hqrm-r3gf (`postcss-selector-parser` via `@tailwindcss/typography`), outside four targeted backports; retain for explicit separate disposition. Suggested Cloudcmd 17.0.1 major downgrade is not an accepted fix. All four targeted advisories are **source-backport mitigated with focused Windows/Linux regression and verified Linux target-source integrity**, still version-flagged, not final risk accepted. Whole-lock integrity metadata gap remains separately recorded; no claim of full supply-chain integrity or zero vulnerabilities. Explicit residual-risk authorization is required before final release if version findings remain.
- Mandatory Docker/recovery/rollback and full consolidated CI remain NOT RUN/BLOCKED because there is no verified authorized independently isolated nonproduction Docker daemon. Keep fail-closed isolation guard and draft PR #1. Frozen main and backups unchanged, no deployment/tag/release/force/production mutation. No Home VPS access; MyPC backup/sync only. No new phase or PR. RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.
