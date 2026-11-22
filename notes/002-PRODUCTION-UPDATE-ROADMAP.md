# DataStack — Production Update Roadmap / Exact Scope Lock

Planning baseline: `d725841ebc828d58cbe90f517da9e600f23c4630` (frozen; documentation commits will advance Git HEAD but NOT this source baseline).
Current state: **P01 CLOSED and CI-verified (1 of 3 phases complete); P02 and P03 NOT STARTED; P02 requires new explicit approval**.
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
