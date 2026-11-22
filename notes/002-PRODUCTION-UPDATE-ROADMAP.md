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
