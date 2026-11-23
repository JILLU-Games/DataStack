# DataStack — Production Update Roadmap / Exact Scope Lock

Planning baseline: `d725841ebc828d58cbe90f517da9e600f23c4630` (frozen; documentation commits will advance Git HEAD but NOT this source baseline).
Current state: **P01 CLOSED; P02 CI ACCEPTED (Gitea #72 terminal SUCCESS), final three-remote publication gate; P03 NOT STARTED and requires separate explicit approval**. See latest P02 final acceptance appendix and publication report.
Prerequisite for any phase: compare current HEAD and changed paths with this baseline and previously committed notes. For new commits since source baseline, inspect exact diff; no implicit rebase or silent discard.

## Global non-negotiable Scope Lock (applies to ALL phases)

1. Existing UI/UX, public API response contracts, authentication, RBAC, JWT/SDK interoperability, MCP permissions, data retention, CSV content, persistent databases, keys, Redis values, S3/R2 objects, Coolify configuration and production deployment: **unchanged unless an exact targeted fix is proven and separately approved**.
2. No live event sending, live database mutation, destructive test, production restart/deploy, automatic package vulnerability `--force`, tag or release without explicit approval.
3. Limit changes to exact allowlisted paths per phase. Any additional path, altered schema, migration, UI behavior, API code, or security default = STOP / document scope exception / obtain new approval. No broad refactoring.
4. One phase = targeted patch, **one focused CI verification**, exact diff/security review, log/register updates, one Git commit and 3-remote sync verification. No repetitive test loops or local production builds. If CI infra is broken, report a blocker rather than spoof PASS.
5. Phase close requires written evidence with exit codes, commit SHA, changed paths, feature preservation checklist, remaining issues and a next-phase approval command.
6. Reference test logs and source code, not README assertions alone. Code candidate risks require fault reproduction before production behavior changes.
7. Secrets, personal data, local `.env` and runtime tokens never copied into reports, logs or commits. Never perform unsafe `git reset --hard` / `git clean -fd`.
8. `AGENTS.md` cross-IDE memory requirement: update `MEMORY.md` only under explicit scope exception, otherwise provide exact handoff Markdown in `notes/003-PHASE-STATUS-LOG.md` for copy/sync.

## Phase P01 — Dependency, tests & type-contract reconciliation (CI-01…CI-05)

**Goal:** fix confirmed test/lockfile blockers without changing actual app/SDK runtime behavior.
**Allowed paths only:**
- `package-lock.json`; `bun.lock` (delete ONLY after verifying no build consumers; npm lock stays canonical).
- `tests/phase07-deployment.test.ts`; `tests/v2-phase01-storage-quotas.test.ts`;
- `tests/r3-phase04-ui-metrics-rbac.test.ts`; `tests/r4-phase03-sdk-deploy-auth.test.ts`; `tests/r5-phase01-mcp-foundation-logs.test.ts`; `tests/r5-phase03-mcp-ui.test.ts`;
- `tests/phase01-auth.test.ts`; `tests/phase03-storage-buffer.test.ts`; `tests/r3-phase01-security-vault-webhooks.test.ts`; `tests/r3-phase02-storage-scheduler-gzn.test.ts`;
- `tests/r4-phase01-security-boot.test.ts`; `tests/r4-phase02-ingestion-audit-streaming.test.ts`; `tests/r5-phase02-mcp-server.test.ts`; `tests/v2-phase02-alerts-ip-prometheus.test.ts`;
- `.gitea/workflows/datastack-ci.yml` (narrow clean-install/test harness only); `notes/001…006` (status/evidence only).

**Not allowed:** `app/**`, `components/**`, `lib/**`, `core/**`, `server/**`, `docker/**`, `tsconfig.json`, `package.json` or SDK runtime files. If open-handle leak proves core timer bug, STOP and request explicit additional exception for `core/data/buffer.ts` instead of altering it as a side effect.

**Patch tasks and references:**
- CI-01: deterministic regenerated `package-lock.json` with cross-OS optional entries, verify clean `npm ci` on Linux/Windows with same pinned npm; no dependency version bump unless separately approved. Reference `.gitea/workflows/datastack-ci.yml:91-120`.
- CI-02: check `bun.lock` consumers, then remove stale lock or resolve test contract with proof; `tests/phase07-deployment.test.ts:649`.
- CI-03: isolate 4 suites, enumerate open handles/intervals, add explicit test teardown / mocks; source `core/data/buffer.ts:347-391` is **read-only diagnostic reference**. Avoid `process.exit()` hacks and wholesale timeout increases.
- CI-04: replace obsolete regex tests in `tests/v2-phase01-storage-quotas.test.ts:788-804` with precise shared-helper/integration assertions matching `app/vcon/clients/page.tsx:70-95` and `lib/vconUiHelpers.ts:717-780`.
- CI-05: fix 43 test-code type errors across 9 listed files (see `001`). Keep strict TS compile; preserve production API signatures. `tsconfig.json:27` includes tests by glob.
- **P01 acceptance:** 24/24 test files exit 0 (no timeout), `tsc --noEmit` zero errors, `npm run lint` PASS, Python 14/14 PASS regression, Windows/Linux original `npm ci` PASS without diagnostic lock regeneration; one focused Gitea matrix. If network/runner blocker, mark BLOCKED not PASS.
- **Close:** update `notes/003` and `notes/005` only after verifying; commit and sync.

## Phase P02 — Ingestion reliability / error-handling acceptance gates (R-01…R-03)

**Goal:** reproduce or dismiss source-observed risk, preserve response semantics unless proven fix is necessary. **Risk ≠ bug until test fails.**
**Diagnostic-only allowlist:** `server/index.js`, `server/socket/handlers.js`, `server/workers/csvWriter.js`, `core/data/buffer.ts`, `app/api/health/route.ts`, `tests/phase02-sync.test.ts`, `tests/phase03-storage-buffer.test.ts`, `tests/r4-phase02-ingestion-audit-streaming.test.ts`, `notes/001…006`.
**Default write allowlist:** only the THREE listed test files plus `notes/001…006`. Runtime source files above are **READ ONLY until a reproducible failing test demonstrates the need**; then the P02 approval must name an exact method/line range and explicitly authorize the smallest required change. This is not preapproval for changing server source.
**Test matrix (disposable, never production):**
- R-01: fake Redis `rpush` rejection + ACK + simulated process exit/reopen; ensure API explicitly returns failed/pending unless durable, or document intended guarantee. Preserve existing duplicate/rate/size/auth error codes.
- R-02: injected CSV partial write, simulated failure before Redis `ltrim`, restart and compare event IDs/rows; decide documented at-least-once semantics vs dedupe strategy before altering storage.
- R-03: separate liveness/readiness checks with mocked Redis/PG errors; old public `/health` stays backwards compatible. Verify startup fail-closed when secrets or DB unavailable.
- Review source CORS/WebSocket origin and security access policy as **read-only**, no default policy change automatically.
- **P02 acceptance:** targeted fault-injection tests PASS, no acknowledged-event loss in the documented guarantee, no unbounded duplicate amplification, correct 503/507/429/401 semantics and recovery. If risk not reproduced, close as verified with **zero runtime source changes**; never invent a fix.
- **Close:** record precise outcome and next P03 approval.

## Phase P03 — CI runner, Docker images, dependency security, release evidence (CI-06…CI-08)

**Goal:** reproducible Gitea verification, safe dependency advisory triage, complete all three Docker builds, confirm non-mutating production health.
**Default write allowlist:** `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-python-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, `.gitea/workflows/datastack-eslint-ci.yml`, `package.json`, `package-lock.json`, `notes/001…006`.
**Conditional, separate approval only:** `docker/Dockerfile.web` / `docker/Dockerfile.server` if isolated runner/containerd evidence establishes source-level Dockerfile defect. **Not allowed** to change Compose deployment services, secrets, volumes or Dockerfiles merely to work around a runner failure.
**Tasks:**
- CI-06: replace stale Debian Bullseye `apt-get` dependency step with preinstalled compatible Python image/toolchain OR canonical Windows Python job; avoid duplicate CI runs.
- CI-07: inspect runner daemon snapshotter/filesystem free space, cache/BuildKit and known `node_modules/@uiw` layer failure; use properly configured disposable BuildKit builder or another isolated runner. If reproducible Dockerfile defect is proven, obtain narrow scope amendment. Build images **without running containers**; no `docker system prune` or shared cache destruction.
- CI-08: run read-only detailed `npm audit --json` in isolated runner, map actual direct/transitive paths and runtime impact, document advisory IDs/severity, apply minimal compatible pin bumps only where necessary. Never `npm audit fix --force`.
- Verify canonical package metadata and Git remote SHA; GitHub login/account issue is **already resolved** and is not a current blocker.
- **P03 acceptance:** all 3 images build, Compose config PASS, Next standalone PASS, lint + strict TS PASS, 24/24 TS suites no hang, Python 14/14, regression error codes unchanged, advisory disposition documented, read-only public health PASS. Any real deployment/production migration is a **separate approval**.
- **Close:** exact diff, one CI acceptance run (plus only blocked job rerun where necessary), statuses/feature matrix update, one commit, synced remote HEADs, phase CLOSED.

## Sequence and approval gate

P01 **CLOSED** -> P02 **approved diagnostic completed / BLOCKED on R-01 and R-02 remediation** -> P03 **must await P02 closure**. P01 acceptance evidence: Gitea CI #59 (Windows + Linux clean install, 24/24 tests, Node SDK, Next standalone) and #60 (strict TypeScript + ESLint), with historical #59 single test-type error corrected before #60. No actual app/runtime/UI/SDK change or live deployment.

Approval command for next turn:

`APPROVED — DataStack Production Readiness P02. Follow notes/002 P02 Exact Scope Lock. Verify R-01 Redis ACK durability, R-02 CSV crash/replay duplication, and R-03 liveness/readiness with disposable fault-injection tests. App/runtime source READ-ONLY unless a reproducible bug and separate exact patch approval. Preserve all existing UI, API, auth, SDK, data, and production. One focused CI, forensic diff, notes update, commit, three-remote sync. No deploy, releases, migrations or scope expansion.`

## P02 Execution Scope Addendum — 2026-11-22

P02 approved as **diagnostic-only**. Published P01 baseline: `667a140c4e9e75382bfdcdbe1d3e9eb96f6e808a`. Isolated local worktree: `p02-readiness-test-20261122`, preserving previously staged local P01 source. The **only code edits** are `tests/phase02-sync.test.ts` and `tests/phase03-storage-buffer.test.ts`; six `notes/001–006` documents may be amended. CI #63 uses the existing `.gitea/workflows/datastack-ci.yml`; changing workflow files is **outside P02 Scope Lock**. No runtime/source/API/UI/SDK change is approved. If loss or unbounded replay is reproduced, classify as **BLOCKED pending an independently authorized narrow runtime patch**, not as fixed; do not advance P03 as if P02's production-readiness gate passed. Approval after evidence must name precise methods, event ACK contract, deduplication/CSV recovery strategy and allowed tests before editing runtime.


### P02 Conditional Remediation Approval (NOT CURRENTLY APPROVED)

`APPROVED — DataStack P02-RUNTIME-REMEDIATION. Baseline: use the verified P02 diagnostic commit/remote tree. Fix reproduced R-01 and R-02 only, following exact notes/001–006 proof and scoped server/index.js pushEventsToRedisOrFallback/onBufferPush and flushBuffer, server/socket/handlers.js sync_data/batch_sync ACK, and their three existing P02 test files. First document safe ACK/retry semantics, exactly-once versus at-least-once CSV contract and crash recovery. Add disposable fault tests proving no positive ACK for non-durable data and no unbounded duplicate replay. Runtime sources core/data/buffer.ts and server/workers/csvWriter.js remain READ-ONLY unless a separately justified exact file/line amendment is approved. Preserve all UI/auth/SDK/public health behavior and existing error codes, production data, security, other features and Docker. One focused CI, diff/security audit, notes update, commit and 3-remote parity. No deployment, migrations, tags/releases or scope expansion. If a safe fix cannot be achieved within these exact methods, stop and report the required additional Scope Lock rather than broadening automatically.`

After separate approved remediation and verified P02 closure, **P03 plan** remains CI-06 Linux Python runner provisioning, CI-07 isolated Docker/BuildKit failure remediation and 3-image build, CI-08 supply-chain advisory triage, and non-mutating readiness evidence. P03 should not modify unrelated UI/runtime/API code by default.


## P02 Runtime Remediation Execution Handoff — 2026-11-22

The user explicitly approved **only** R-01 Redis failure ACK and R-02 Redis-to-CSV replay corrections in these methods: `server/index.js` `pushEventsToRedisOrFallback` / `flushBuffer` / existing `onBufferPush` integration; `server/socket/handlers.js` `sync_data` / `batch_sync` ACK handling; `core/data/buffer.ts` `flush` if needed; the three earlier P02 test files; `notes/001–006`. No other application method/UI/API/auth/SDK/Docker/CI-workflow edit. Public R-03 `/health` semantics remain unchanged.

Local candidate `44eee8877e40d1683f44502c2a0ba3d437a03b88` is **not release-ready** until Gitea acceptance. Before closure, prove: negative ACK on Redis failure with no sensitive error leakage; ordinary successful Redis ACK preserved; both single and batch retries don't convert volatile failures to success; Redis queued event replays after crash without writing duplicate CSV rows in the Port 4000 worker and Port 3000 web buffer; CSV read/parse failure never causes premature Redis trim; validate bounded scan overhead and edge cases for rotated/gzipped partitions; all historical 401/403/429/507/503 tests unchanged.

**Stop rule:** if required fixes need touching `validateSingleEventAsync`, `csvWriter.js` or separate journal/storage scheme, do not broaden the implementation scope; record the residual and request new explicit approval. Existing unrelated files including `MEMORY.md` remain unchanged due exact Scope Lock; this note is the cross-IDE handoff. P03 must wait for P02 CLOSED, not merely implementation committed.


## P02-FINAL-ACCEPTANCE-01 Execution / P03 Gate

User approved strict P02 final acceptance after `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898` published diagnosis and `76cd972bdeea9ef07b4b38e9d8b5b5ed3312ca5b` runtime candidate. Previously failed claim is negative timestamp cleaned with positive-timestamp TTL arithmetic; final patch changes only `server/socket/handlers.js` sync_data/batch_sync marker and mixed-batch handling, plus `tests/phase02-sync.test.ts` and `tests/phase03-storage-buffer.test.ts`. It does not edit production startup, public health, schema, CSV format, SDK or dependency files. Candidate CI #66 **terminal SUCCESS**: all 24/24 TypeScript suites, strict tsc, lint, Windows Node SDK and Next build PASS. Final focused CI #69 on `bf525f0d4e5e4781de7fddd2f5e7d3d602a80532` was dispatched; confirm terminal results before any P02 CLOSED claim. No repeated broad CI runs unless this run demonstrates a scoped failure.

**Acceptance contract:** ACK durability applies to Redis-backed events when Redis configured. Intentionally Redis-free RAM mode retains its historical best-effort ACK. CSV replay is at-least-once with per-partition event-id duplicate suppression under tested crash windows, not a global transactional exactly-once guarantee. Existing scan uses streaming parsing (bounded memory) and scans entire matching partitions (disk I/O scales with data size; monitor before production promotion). Corrupt matching CSV fails closed. If a hard upper disk-scan budget is required for production traffic, obtain a dedicated storage/index design approval rather than silently breaking ingestion.

**Next P03 (ONLY after P02 closure):** CI-06 Python runner environment and 14/14 Python SDK; CI-07 three Docker image builds/isolated BuildKit with no live prune; CI-08 read-only npm advisory IDs/direct-transitive audit, compatible dependency pins only if justified; Compose/standalone/health gate evidence and manual release decision. Exact P03 allowlist remains in this roadmap. No live deploy, migrations, tags or releases without separate approval.


### P02 Final CI Exception / Narrow Retry

The final acceptance test-only clock override in #69 interfered with Socket.IO ACK timing. The source-grounded mixed `batch_sync` all-duplicate edge also required a single conditional correction within the previously approved handler. Commit `acca8be01a31f8d3972564cbaec8fd3117a0b551` changes only `server/socket/handlers.js` and `tests/phase02-sync.test.ts` after initial final candidate; one narrow Gitea CI #72 requested because CI #69 node-regression failed one fixture. Other scope/production invariants remain unchanged. P02 closure requires terminal #72 and exact patch/security evidence.


## P02 Final Acceptance Closure Gate / P03 approval handoff — 2026-11-22

P01 CLOSED; **P02 tests/quality/build ACCEPTED via terminal [Gitea CI #72](https://dev.ivib.cc/vibtools/DataStack/actions/runs/72) SUCCESS** on `acca8be01a31f8d3972564cbaec8fd3117a0b551`; P02 phase transitions to CLOSED only when the verified code plus these documentation-only notes are merged to Gitea main and published to GitHub/GitLab with identical tracked Git trees. Terminal jobs: node-regression 24/24 PASS; quality strict TypeScript and ESLint PASS; Windows compatibility SDK PASS; production Next standalone PASS; Python and Docker intentionally skipped (P03). #69 historical test-only clock failure is resolved in #72. A production deployment and all live services remain **NOT VERIFIED** and NOT authorized.

**P03 next / exact future Scope Lock (requires separate user approval):** CI-06 Linux/Python environment: `.gitea/workflows/datastack-ci.yml` and `.gitea/workflows/datastack-python-ci.yml` only; Python SDK 14/14 isolated. CI-07 Docker/BuildKit 3-image verification: `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml` only, runner evidence read-only; Dockerfiles can be edited ONLY after independently approved exact exception, no shared runner prune. CI-08 advisory triage: read-only `npm audit --json`, actual CVE/advisory and direct/transitive dependency graph; only minimal justified `package.json`/`package-lock.json` pins under this phase scope, never forced audit repair. `.gitea/workflows/datastack-eslint-ci.yml` quality harness only if source-proven CI-08 need. `notes/001–006` for evidence. Existing UI/API/auth/SDK/runtime logic, Compose, volumes, DB data, secrets, real host, and release configuration remain unchanged. One focused acceptance / one exact patch/security audit / one main commit and 3-way tree sync. Do not deploy, run live ingestion, migrate, prune shared Docker, tag or release.

**P03 approval command (not authorization until user explicitly sends):**

```text
APPROVED — DataStack Production Readiness P03.
Use notes/002 P03 CI-06/CI-07/CI-08 Exact Scope Lock and the verified published P02 main baseline.
CI-06: fix Python runner/toolchain only in approved .gitea workflows; verify Python SDK 14/14.
CI-07: isolate Docker runner/BuildKit and build all 3 images without deploying or pruning shared caches; Dockerfiles READ-ONLY unless a separately approved exact exception.
CI-08: read-only npm audit advisory inventory, minimal compatible package pins only for proven security need; no npm audit fix --force.
Preserve UI/UX, app/API/auth/SDK/runtime, Compose, production data, secrets and existing features unchanged.
Use one focused Gitea CI, strict patch/security diff, notes/001–006 update, Git commit and Gitea/GitHub/GitLab tree parity.
No live deployment, migrations, tags or releases.
Close P03 only on verified acceptance; provide production release readiness report.
```

## P03 scoped execution and release gate — 2026-11-22

Baseline Gitea/GitHub `48fb277079b380fdbf1e58cd2da40afeed0b03ee`; GitLab baseline same tracked tree `41a169eec0c05ce19bc4acc29d7a8cfe1f8dd90d` (317/317 blobs). Final P03 workflow candidate `549d575653b68c29f97e2f78036646f2e2035719`. [Gitea CI #77](https://dev.ivib.cc/vibtools/DataStack/actions/runs/77): overall **FAILURE** because the initial Python-only checkout lacked Node (exit 127), **not** an SDK regression. Its other six jobs terminal **SUCCESS**: Node `CI_SUITE_SUMMARY total=24 failed=0`, strict TS+ESLint, Next standalone build, Windows SDK, Compose + isolated BuildKit ingestion/web/proxy image build `DATASTACK_THREE_IMAGES_BUILD_PASS`, read-only advisory inventory `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Narrow [Python-only CI #78](https://dev.ivib.cc/vibtools/DataStack/actions/runs/78) terminal **SUCCESS**: Node-capable Bookworm container, Python 3.11 isolated venv, `Ran 14 tests in 3.959s`, `OK`, `DATASTACK_PYTHON_14_OF_14_PASS`. The other six jobs were deliberately skipped in #78.

**CI-08 security disposition:** `npm audit --json` full=26 affected packages (25 moderate, 1 high); runtime=24 (23 moderate, 1 high), **not counts of distinct advisories**. High-severity advisories [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) affect Next 15.5.29's nested `postcss@8.4.31` despite patched root `postcss@8.5.33`; npm recommends major `next@16.4.6`. Direct `cloudcmd@19.24.0` carries moderate transitive issues (`dompurify`, `file-type`, `glob`, `minimatch`, `got`); npm recommends `cloudcmd@17.0.2` downgrade, not a verified safe pin. No speculative package pin, major upgrade or force fix; a separately tested compatible remediation is needed before release.

**Scope / release decision:** only `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, and `notes/001–006` changed. No `package.json`/lock, Dockerfile, application UI/UX, runtime, auth, SDK, database, Compose, production data, secret, shared Docker prune, deployment, migration, tag or release. P03 technical CI and advisory-triage acceptance verified by #77 non-Python jobs plus #78 Python; do **not** mislabel #77 overall as successful. Final phase publication requires one main commit and Gitea/GitHub/GitLab exact tracked tree parity. **Production release NO-GO** while runtime high advisory is unresolved; live production health, throughput and deployment remain unverified.

## P04-S01 approved security remediation scope — 2026-11-22

Baseline Gitea `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`, tree `12818ba732f5abdc42af46d83278b13b6be4eafd`. SEC-01: Next `15.5.29` nested `postcss@8.4.31` is the sole P03 high runtime affected package despite top-level `postcss@8.5.33`; see CI #77 `AUDIT_PACKAGE runtime postcss`, GHSA-6g55-p6wh-862q / GHSA-r28c-9q8g-f849. Source `package-lock.json:10552-10560`, `10602-10603`, `11427-11428`; `package.json:35,37`. Approval authorizes only scoped override in `package.json`, npm-generated `package-lock.json`, **existing** `.gitea/workflows/datastack-ci.yml` security-audit job and `notes/001–006`. All application, test, SDK, Docker/Compose and deployment files READ-ONLY. Never force next@16, downgrade cloudcmd, `npm audit fix --force`, prune shared Docker, deploy, migrate or tag. Acceptance: reproducible lockfile, clean npm ci, Node 24/24, Python 14/14, tsc/lint, Windows SDK, Next standalone, 3 Docker images, runtime high/critical zero and exact Git diff. One focused Gitea CI, one accepted main commit, three-remote content parity; unresolved moderates/live checks retain production NO-GO. If override incompatible, STOP as BLOCKED and request exact exception.

## P04-S01 blocked security reconciliation report

P04-S01 SEC-01 BLOCKED — 2026-11-22. Approved scoped `overrides.next.postcss=8.5.33` trialed in disposable Windows npm 10.9.8 workspace only. `npm install --package-lock-only` EXIT 0, but `npm ls --package-lock-only postcss --all` EXIT 1 (`ELSPROBLEMS`: Next nested `postcss@8.4.31` invalid; expected 8.5.33); npm dedupe also kept invalid dependency. Read-only `npm audit --omit=dev --json` EXIT 1, runtime high 1/moderate 23/critical 0. Lockfile regeneration caused unrelated churn (91 package entries added, 106 removed, 69 changed, including two lightningcss optional 1.33.0 -> 1.30.1). Fresh minimal Next 15.5.29 fixture with identical override resolves PostCSS 8.5.33, isolating failure to DataStack committed lock graph. `npm ci --dry-run` exit 0 does not prove real clean install. Exact stop rule applied: no dependency patch, no CI acceptance, no main commit, no GitHub/GitLab sync, no release/deploy; production NO-GO. Need separate explicit narrowly scoped lock reconciliation approval.

Approved scope remains `package.json` scoped override, npm-generated `package-lock.json`, current Gitea `security-audit` job, notes/001–006. Do not add manual lock edits, major Next 16, Cloudcmd downgrade, npm audit fix --force or unrelated source files. Phase BLOCKED until amended approval.

## P04-S01B correction gate — 2026-11-22

The targeted removal-and-regenerate method fixes SEC-01 in an isolated copy: valid `npm ls` exit 0 and `npm audit --omit=dev` high=0/critical=0/moderate=22, while Next 15.5.29, Cloudcmd 19.24.0 and all unrelated versions remain unchanged. **But** npm regenerated 67 unrelated package metadata entries (36 `dev` flags, 29 `libc` fields, 2 dependency map order changes); that is outside the expressly approved preservation contract. P04-S01B **BLOCKED by exact scope lock**, not by unresolved PostCSS resolution. Do not commit the unacceptable lock or quietly normalize metadata. Require separate approved exact metadata-reconciliation strategy/exception and content-preserving proof. Until then no acceptance CI, commit to main, remote parity, release or deployment.

## P04-S01C implementation checkpoint and exact release gate — 2026-11-22

Approved P04-S01C changes are strictly `package.json`, `package-lock.json`, existing `.gitea/workflows/datastack-ci.yml:security-audit`, notes/001–006. Applied scoped Next→PostCSS 8.5.33 override, npm regenerated disposable lock after stale entry deletion, deterministically restored **all 67** unrelated npm metadata modifications against baseline; exact final diff only stale nested package removal. No version, integrity, peer or optional metadata drift. Gitea branch patch `c759be990c032c2474d2d0bad519c643dec11a3a`; lock SHA-256 `e6b5b362877627085dc04c9ded03c019971e07ef9f4af1e78057d58961a1c091`. Focused [CI #85](https://dev.ivib.cc/vibtools/DataStack/actions/runs/85) six jobs terminal SUCCESS including Docker 3/3, Python 14/14, Node 24/24, Next/tsc/lint, runtime high/critical zero; Windows compatibility **QUEUED**, so P04-S01C **PENDING**. Do not merge/mark CLOSED until Windows job succeeds, overall #85 SUCCESS, exact file-scope audit and Gitea/GitHub/GitLab tracked-tree parity; no deployment, migration, release/tag/prune. After closure, independently approve P04-S02 Cloudcmd moderate advisory triage and later production readiness.

## P04-S01C FINAL CI acceptance (7/7) — 2026-11-22

Gitea CI #85 https://dev.ivib.cc/vibtools/DataStack/actions/runs/85 COMPLETED/SUCCESS; tested implementation SHA c759be990c032c2474d2d0bad519c643dec11a3a; later changes to candidate are documentation only. All seven jobs terminal SUCCESS: node-regression (Linux committed-lock npm ci and exactly 24/24 TypeScript suites); python-regression (Ran 14 tests, OK); quality (strict tsc and ESLint); production-build (Next 15.5.29 standalone, 22/22 pages); docker-image-build (three isolated BuildKit ingestion/web/proxy images); windows-compatibility (Windows committed-lock npm ci and Node SDK build, job #182, terminal SUCCESS); security-audit (runtime moderate=22 high=0 critical=0; full moderate=24 high=0 critical=0; DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO). Single Gitea acceptance run used, no additional broad reruns.

Scope: exactly nine approved paths: package.json scoped next->postcss 8.5.33 override; package-lock.json removes only old nested postcss@8.4.31 entry; existing .gitea/workflows/datastack-ci.yml security-audit job high/critical rejection; notes/001–006 evidence. Other package metadata, versions, integrity and resolved URLs match baseline. Next.js 15.5.29 and Cloudcmd 19.24.0 preserved. Final candidate package-lock SHA256 e6b5b362877627085dc04c9ded03c019971e07ef9f4af1e78057d58961a1c091 (verified byte-for-byte with Gitea). No API, auth, SDK, UI, application runtime, database, Compose, Dockerfile, tests or production data changes, deployment, migration, prune, tag, release.

Next roadmap: P04-S02 Cloudcmd moderate-advisory triage, followed by separate live readiness approval. No forced major upgrade/downgrade. CI fully accepted; publication not yet asserted in these pre-merge notes. Final phase CLOSED requires one squash merge of PR #5 into Gitea main and verified identical tracked content across Gitea/GitHub/GitLab; record actual new SHAs in terminal report. Production release remains NO-GO pending P04-S02 moderate vulnerability triage and separately authorized live readiness verification.

## P04-S02 scoped candidate — 2026-11-22

Baseline Gitea main `2d467ff1494858164a37814f7dbc2b321f510291`, tree `648c76ca496d2c9bf22a16f558c9ba347a45d4f7`. Cloudcmd 19.24.0 -> deepword 11.0.1 -> monaco-editor 0.55.1 pins DOMPurify 3.2.7, vulnerable according to npm advisory inventory. Disposable Windows npm 10.9.8 `npm view dompurify@3.4.18` verified, scoped npm override `overrides.cloudcmd.dompurify=3.4.18` resolves `dompurify@3.4.18` via `npm ls --package-lock-only dompurify --all --depth=5` (exit 0). `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-offline` exit 0. npm graph initially changed 67 unrelated metadata entries; deterministically restored exact baseline values after validating unrelated versions, URLs, integrity and dependencies. Final lock has **one changed package entry**, DOMPurify; same-major replacement plus verified registry `resolved` and `integrity`, no other packages added/deleted/changed. Candidate runtime audit affected-package counts **moderate 20/high 0/critical 0** versus baseline **22/0/0**; full candidate **moderate 22/high 0/critical 0** versus baseline **24/0/0**. DOMPurify and Monaco Editor dropped from vulnerable-package inventory. Other moderate packages (got, glob, minimatch, nested file-type, Cloudcmd transitive chain) remain; they require major package changes under current advisory constraints, prohibited by Scope Lock. This is a **pre-acceptance candidate**: do not claim application compatibility, CI PASS, publication, or phase CLOSED before full focused Gitea CI and exact three-remote tree parity.

Roadmap: finish one focused Gitea acceptance, exact 8-file scope and three-remote parity. Remaining moderate findings deferred to independently approved scope, never silently upgraded.

## P04-S02 final CI acceptance — 2026-11-22

Gitea CI #92 (https://dev.ivib.cc/vibtools/DataStack/actions/runs/92) **COMPLETED / SUCCESS**, all 7/7 jobs terminal success on source commit `a88bc5f4498ea1b11acc0acfeb66b5aa9d6531be`: node-regression real Linux npm ci + 24/24 tests including `tests/files-manager.test.ts` exit 0; Python SDK 14/14; quality strict TypeScript/ESLint; Next.js standalone (22/22 static pages); isolated Docker/BuildKit 3-image verification `DATASTACK_THREE_IMAGES_BUILD_PASS`; Windows committed-lock npm ci + Node SDK compatibility; security-audit `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO` and `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Audit full=22 moderate/high=0/critical=0 (baseline 24), runtime=20 moderate/high=0/critical=0 (baseline 22). These are affected package entries, not distinct advisories. No new CI workflow or extra broad CI dispatched.

Exact approved patch: `package.json` scoped `overrides.cloudcmd.dompurify=3.4.18`, preserving `overrides.next.postcss=8.5.33`; npm-generated `package-lock.json` changes solely `node_modules/dompurify` version 3.2.7 -> 3.4.18 and verified `resolved`/SHA512 integrity. Baseline Cloudcmd 19.24.0, Monaco Editor 0.55.1, Next.js 15.5.29, all unrelated locked package versions, URL, hash, dependency and metadata preserved. Gitea published candidate lock bytes match disposable SHA-256 `57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854`. Exact candidate tree diff 420 entries, 8 approved changed files only (`package.json`, `package-lock.json`, notes/001–006), 0 unauthorized paths. No runtime/UI/auth/API/SDK/tests/CI/Dockerfiles/Compose/db/schema/data modifications.

Roadmap: after P04-S02 accepted mirror parity, next separately approved P04-S03 remaining moderate advisory dependency-contract triage (read-only / disposable compatibility first), then P05 live readiness. **Residual risk:** 20 moderate runtime affected package entries remain, including Cloudcmd transitive dependencies `got`, `glob`, `minimatch`, nested `file-type` and their parent chains. Current npm audit suggests `cloudcmd@17.0.2` (a major downgrade), explicitly out-of-scope; other transitive fixes need major-version dependency-contract changes. No force/downgrade/unverified override. Security improvement verified but NOT zero vulnerabilities. Production release stays NO-GO; remaining advisory disposition and live readiness need independent scope approval.

**Merge gate:** CI #92 7/7 PASS, approved 8-file patch integrity PASS; main squash merge and Gitea/GitHub/GitLab exact Git content-tree verification required before P04-S02 CLOSED. This note is written before that publication, so final remote commit SHAs shall be appended to the PR closure report after verification. No deployment, migrations, prune, tag, release.

## P04-S03 — Scope-locked risk disposition and next roadmap (2026-11-23)

Gitea main a9ad7700638bea5a7a815c6582721ba517744087, tree 1a0790d0d5922a2df5d529d60a1f106651a3654f. P04-S02 remains accepted (CI #92 7/7 PASS); all approved Cloudcmd 19.24.0, Next 15.5.29, PostCSS 8.5.33 and DOMPurify 3.4.18 locks preserved. Windows disposable npm 10.9.8/Node 22.23.2 inspection downloaded the exact Gitea package.json/package-lock.json; original lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. `npm ls --package-lock-only cloudcmd got glob minimatch file-type dompurify --all --depth=5` exit 0. Fresh `npm audit --omit=dev --json` reports runtime moderate=20/high=0/critical=0, full `npm audit --json` moderate=22/high=0/critical=0; npm audit exit 1 because existing moderates, not a tool failure. Counts are affected package nodes, not distinct advisories.

**Remediation gate:** All four vulnerable leaf packages require crossing one or more parent dependency major constraints. Existing Cloudcmd 19.24.0/Monaco Editor behavior, UI, SDK, API and other features cannot be changed under P04-S03. No safe npm override candidate; do not use Cloudcmd 17.0.2 downgrade, global force or transitive major-version replacement. **P04-S03 disposition: FORENSIC REVIEW COMPLETE / TARGETED REMEDIATION BLOCKED BY APPROVED SCOPE.** No package.json, package-lock.json, runtime, UI, File Manager, Monaco Editor, tests, SDK, CI, Dockerfile, Compose, database, secrets or production file edits. No npm install or `npm ci` required for unmodified baseline, no extra Gitea CI dispatched: accepted unchanged baseline retains Gitea CI #92 7/7 including real Linux/Windows npm ci, File Manager regression, SDKs and 3 Docker images. No claim of newly fixed advisories or zero Moderate. Only notes/001–006 publication is permitted; no dependency patch, tag, release, deployment, migration, prune or live change. Production remains NO-GO, pending separately approved parent dependency migration with full compatibility acceptance or a formal risk-disposition decision.

**Next proposed P04-S04:** separately approved read-only deployment-exposure and security risk review, with option to propose a NEW exact scope/compatibility matrix for parent package migrations only after explicit user approval. Do not assume P04-S04 grants application edits or risk acceptance. P05 readiness and production release require their own gated authorization.

## P04-S04 — Next roadmap (2026-11-23)

Approved baseline Gitea main 986ac1fcb2cced4cb5b330429084b9206f84a791, tracked tree 118fae01fb48c9435907aa5b696e78eba3cc8d36 (420 entries). Disposable Windows Node 22.23.2/npm 10.9.8 copied byte-exact published package.json/package-lock.json; lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. Live registry.npmjs.org upstream metadata inspected 17 parent package names (all fetches passed) and 17 parent/dependency constraint assertions exit 0.

Four direct npm audit GHSA roots remain: got GHSA-pfrx-2q88-qq97 (patched >=11.8.5), glob GHSA-3g3m-2fjr-6pw4 (patched >=14.0.2), minimatch GHSA-g3hv-75wg-m249 (patched >=11.0.1), file-type GHSA-5v7r-6r5c-r473 (patched >=21.3.1). Latest supported upstream parent metadata: @cloudcmd/dropbox 5.0.3 -> dropbox-stream ^3, dropbox-stream 3.2.0 -> got ^10.6.0; console-io 15.0.4 -> spawnify ^8, spawnify 8.0.1 -> glob ^10.3.3; inly 5.0.1 -> glob ^10.3.10/onezip ^6, onezip 6.1.1 -> glob ^10.3.10, onezip 7.0.3 -> glob ^13.0.6; glob 10.5.0 -> minimatch ^9.0.4, glob 13.0.7 -> minimatch ^10.2.2; join-io 5.0.0 -> ponse ^6, restbox 4.0.1 -> ponse ^7, ponse 6.0.0 and 7.0.0 -> file-type ^16.2.0. Root file-type 21.3.4 already patched; nested file-type 16.5.4 remains. Latest @cloudcmd/fileop 9.1.1 still pins inly ^5 and onezip ^7: no advisory improvement. Cloudcmd latest 19.24.0 unchanged. Latest glob 14.0.6 uses minimatch ^11.0.5, incompatible with existing parent ranges. None of these latest parent releases supports a patched leaf major.

Current fresh npm audit --omit=dev --json: runtime affected package entries moderate=20, high=0, critical=0; npm audit --json: full moderate=22, high=0, critical=0. Both audit commands exit 1 due documented moderate advisories, not audit parser errors. Baseline audited lock SHA-256 unchanged; no dependency patch or npm installation. Historical unchanged-code Gitea CI #92 remains 7/7 SUCCESS (not a new P04-S04 CI).

Roadmap: a future separately approved phase should evaluate maintained upstream parent releases/patch coordination and explicit exposure mitigations or formal risk decision; never authorize app source changes or automatic risk acceptance under P04-S04.

P04-S04: FORENSIC DISPOSITION COMPLETE, COMPATIBLE SECURITY REMEDIATION BLOCKED by approved Scope Lock. Parent-documented support is mandatory before major transitive upgrade; upstream has no supporting releases. No unsupported leaf overrides, forced npm audit fix, Cloudcmd downgrade, UI/feature/API/auth/SDK/test/CI/Docker/Compose/DB/production changes. Exact publication is notes/001-006 ONLY; package manifest, lock and runtime byte-exact baseline. No new broad CI because no candidate. No deployment, migration, shared prune, tag or release. Production NO-GO. Do not mark four advisories resolved or claim zero moderate. Any parent patch/fork, compatibility adapter, or operational risk acceptance requires separate exact user approval.

