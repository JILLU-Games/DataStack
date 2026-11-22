# DataStack — Production-Readiness Forensic Audit (Documentation Baseline)

Status: **DOCUMENTED / NO BUG FIX APPLIED**. Date: 2026-11-22 (Asia/Dhaka).
Frozen source HEAD: `d725841ebc828d58cbe90f517da9e600f23c4630`. Local, Gitea `vibtools/DataStack`, GitLab `ivibtools/datastack`, and GitHub `JILLU-Games/DataStack` confirmed at this exact HEAD before writing these notes.
Scope of this document: **evidence-backed CI and source review**, not proof that every production feature works. No Coolify live write, rollback, restart or deployment was conducted. Public GET `https://data.ivib.cc/api/health` returned `status: online`; full DB/Redis/MCP/S3 transaction health is not established.

## Findings classification

- **8 finding groups** from actual CI: **5 code/test/lockfile groups** (CI-01…05) and **3 CI infrastructure/security-review groups** (CI-06…08). **Not 43 separate bugs**: the 43 compiler errors belong to CI-05.
- **2 failing assertions, 4 timeout suites** (24 TypeScript suites in run #45: 18 clean, 6 fail/timeout).
- **3 extra source-observed reliability risks** (R-01…03) have NOT been reproduced as production failures; they require targeted fault injection before any fix or behavior change.
- **Do not equate successful test/source feature with verified production runtime.**

## Eight confirmed findings / blockers

| ID | Severity* | Evidence (run/job) | Exact affected area | Verified observation | Planned phase |
|---|---|---|---|---|---|
| CI-01 | High | Run #42 job 63; #45 job 71 | `package-lock.json`, `package.json`; `.gitea/workflows/datastack-ci.yml` Windows job | Original Windows `npm ci` reports missing platform dependency entries; regenerate lock **only in runner** -> SDK builds. Lock not fixed in repo. | P01 |
| CI-02 | Medium | Run #45 job 66 | `bun.lock` and `tests/phase07-deployment.test.ts:648-649` | Tracked `bun.lock` conflicts with assertion requiring its absence. Validate references before removing. | P01 |
| CI-03 | Medium | Run #45 job 66 | `tests/r3-phase04-ui-metrics-rbac.test.ts`, `tests/r4-phase03-sdk-deploy-auth.test.ts`, `tests/r5-phase01-mcp-foundation-logs.test.ts`, `tests/r5-phase03-mcp-ui.test.ts` | Each suite timed out with exit **124** despite reaching passing assertions; investigate open handles/teardown without changing application timers by default. | P01 |
| CI-04 | Medium | Run #45 job 66 | `tests/v2-phase01-storage-quotas.test.ts:788-804` vs `app/vcon/clients/page.tsx:15-20,70-95` and `lib/vconUiHelpers.ts:717-780` | Old regex expects `function isClientExpired(` in page; production page uses shared `classifyUiClientStatus` and `summarizeUiClientCounts`. Test contract is stale; not proof expiry feature fails. | P01 |
| CI-05 | Medium | Run #45 job 68 | Nine `tests/*.test.ts` files (listed below), `tsconfig.json:27` | `npx tsc --noEmit` produced **43 compiler errors**, despite Next.js production build PASS. Type errors in test sources require focused correction; do not disable strict TypeScript. | P01 |
| CI-06 | Low/CI | Run #45 job 67, run #48 job 74 | `.gitea/workflows/datastack-ci.yml` Python job | Linux Bullseye `apt-get` returned Debian-security 404; separate Windows Python job passed **14/14**. Runner provisioning defect, not SDK regression. | P03 |
| CI-07 | High/CI | Run #50 job 76 | `.gitea/workflows/datastack-docker-ci.yml`, Docker daemon; `docker/Dockerfile.web:13` | Compose validation and ingestion image PASS, then web image layer copy fails with containerd `lstat .../app/node_modules/@uiw: no such file or directory`. Root cause **unconfirmed** (runner snapshot/storage or reproducible build interaction); proxy never built. | P03 |
| CI-08 | Review | Run #50 job 76 | `package.json` / `package-lock.json` / resolved npm graph | npm reports **24 (23 moderate, 1 high)** with `--omit=dev`, **26 (25 moderate, 1 high)** with `--include=dev`. Counts overlap; no CVE list, reachable-exploit assessment or remediation done. | P03 |

*Severity is release-priority triage, NOT a CVSS rating and NOT proof of real-world exploitation.

### CI-05 exact file map (43 total, all inside tests)

| File | Error count | Families / main anchors |
|---|---:|---|
| `tests/phase01-auth.test.ts` | 4 | TS2540; 88,560,773,794 |
| `tests/phase03-storage-buffer.test.ts` | 2 | TS2349; 1158,1202 |
| `tests/r3-phase01-security-vault-webhooks.test.ts` | 6 | TS2353, TS2345; 185,191,202,210,295,430 |
| `tests/r3-phase02-storage-scheduler-gzn.test.ts` | 1 | TS2345; 49 |
| `tests/r4-phase01-security-boot.test.ts` | 3 | TS2345; 102,537,571 |
| `tests/r4-phase02-ingestion-audit-streaming.test.ts` | 9 | TS2345/TS2833; 87,332,335,338,407 |
| `tests/r5-phase02-mcp-server.test.ts` | 12 | TS18046; 510,524,538,549,560,570,581,604,613,635,644,657 |
| `tests/v2-phase01-storage-quotas.test.ts` | 2 | TS2554; 762,783 |
| `tests/v2-phase02-alerts-ip-prometheus.test.ts` | 4 | TS2339; 479,480,490,491 |

No source fix is authorized here. Use typed narrowing and correct test fixtures, not `skipLibCheck`, `any` everywhere, `@ts-ignore`, or changing real API responses merely to make tests compile.

## Three source-observed production reliability risks — CONDITIONAL GATES, not confirmed bugs

| Gate | Source proof | Why verification is required | Phase |
|---|---|---|---|
| R-01 Redis outage ACK durability | `server/index.js:165-193`, `server/socket/handlers.js:583-602` | `redis.rpush` failure falls back to RAM, and `onBufferPush()` can resolve, then Socket.IO ACK success; process crash before flush may lose acknowledged events. Fail-injection test and explicit durability contract required. | P02 |
| R-02 Batch replay duplication | `server/index.js:943-994`, `server/workers/csvWriter.js:265-323` | CSV write precedes Redis list trim. Crash/partial write between these operations can replay already written rows. Validate at-least-once vs exactly-once guarantee before mitigation. | P02 |
| R-03 Liveness ≠ readiness | `server/index.js:1939-1956`; `app/api/health/route.ts:95-111` | Health returns online without full PostgreSQL + Redis + disk transaction proof. Preserve existing `/health` API semantics; consider separate, internal readiness rather than breaking public health. | P02 |

Optional configuration review (not counted among eight): `server/index.js:1086-1089` Socket.IO uses CORS delegate; verify WebSocket origin/access and JWT guard in target deployments before recommending policy changes. `sdk/python/datastack/pyproject.toml:47-51` still references legacy `anik-d-art/datastack` URLs; metadata only, not current release blocker. Do not silently modify either under approved scope.

## CI evidence / original logs

- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/42` — initial Windows lockfile failure (job 63), cancelled after partial node evidence.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/45` — 24 suites = 18 clean / 6 fail-or-timeout, 43 TS diagnostics, Next.js production build PASS, Windows diagnostic SDK build PASS; Linux Python apt and Docker-CLI job blocked.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/48` — Python SDK 14/14 PASS.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/49` — full ESLint PASS.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/50` — Compose PASS, Docker ingestion image PASS, web image containerd failure.
- See `notes/006-BASELINE-AND-PATCH-EVIDENCE.md` for precise code/log excerpts and proposed patch anchors.

## Release acceptance rule

NOT production-update-ready until P01, conditional P02 gates, and P03 finish, 24/24 TypeScript suites exit 0, 14/14 Python tests pass, full strict `tsc --noEmit` and ESLint pass, Linux/Windows clean install is reproducible, standalone Next build passes, all 3 Docker images build, security advisories are triaged, and approved **non-mutating** live readiness checks pass. Production deploy is a separate operator-approved action; never automatic from this documentation phase.
