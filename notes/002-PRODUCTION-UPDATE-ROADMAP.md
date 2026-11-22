# DataStack — Production Update Roadmap / Exact Scope Lock

Planning baseline: `d725841ebc828d58cbe90f517da9e600f23c4630` (frozen; documentation commits will advance Git HEAD but NOT this source baseline).
Current state: **3 implementation phases P01–P03 planned; 0 implemented; approvals not yet granted**.
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

P01 -> P02 -> P03, strictly in this order. **No P01 implementation has begun** in this documentation-only update.

Approval command for next turn:

`APPROVED — DataStack Production Readiness P01. Baseline: d725841ebc828d58cbe90f517da9e600f23c4630. Implement ONLY notes/002 P01 exact Scope Lock; preserve all app, UI, SDK, backend, live data, deployment and unrelated files. One focused disposable Gitea CI, exact diff/security audit, notes/003–005 update, one commit, push GitHub/GitLab/Gitea and verify all HEADs. No live deployment, tags, releases or scope expansion.`
