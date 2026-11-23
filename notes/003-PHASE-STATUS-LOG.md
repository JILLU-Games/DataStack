# DataStack — Phase Status & Change Log (Source of Progress Truth)

Frozen source baseline: `d725841ebc828d58cbe90f517da9e600f23c4630`. Generated: 2026-11-22 Asia/Dhaka.
Scope: documentation-only kickoff. Any future phase must update this log **after** verification, not on intention.
**P01 CLOSED; P02 verified in Gitea CI #72 and awaiting recorded three-remote publication; P03 NOT STARTED.** Publication/tree-parity proof and final phase-close status are recorded in the latest acceptance appendix and operator report.

| Phase | Status | IDs / function | Changed source | Verified CI evidence | Commit / remote sync |
|---|---|---|---|---|---|
| P00 Notes / freeze | COMPLETED (documentation only) | `001–006` docs, source baseline and exact scope | `notes/**` only | 6 Markdown files; balanced fences; staged diff `--check` PASS | Documentation commit containing this file; remote SHA verification recorded in session handoff |
| P01 Tests & lockfile | **CLOSED — VERIFIED** | CI-01…CI-05, no runtime feature changes | 16 exact P01 code/test/CI paths, plus `notes/001–006` records | #59 Linux/Windows clean npm/SDK, 24/24 TS suites, Next standalone PASS; #60 strict TypeScript and ESLint PASS; historical #59 quality mismatch corrected | One permanent P01 main commit containing these notes; confirm remote SHA/tree parity in phase handoff |
| P02 Ingestion reliability | **CI VERIFIED #72 — final publish gate** | R-01 ACK/idempotency safety; R-02 CSV replay; R-03 liveness verified unchanged | Exactly 3 runtime files, 2 tests, notes/001-006 | #72 terminal SUCCESS: 24/24 TS, TS typecheck, lint, Next standalone, Windows SDK | Final source/test acca8be01a31f8d3972564cbaec8fd3117a0b551; three-remote main parity recorded on publication |
| P03 CI/Docker/security | NOT STARTED | CI-06,07,08; release gates | None | Not run | — |

## Existing diagnostic CI snapshot (NOT implementation phase completions)

| Run | Baseline commit | Result | Meaning |
|---|---|---|---|
| #42 | `f7c1e7f` | Cancelled | Windows original lock fail logged; long combined regression stopped |
| #45 | `d3a93c6` | Failure | TS 18 clean/6 fail-or-timeout; 43 type errors; build and Windows SDK pass; Python apt / Docker CLI blockers |
| #48 | `ff1333d` | Success | Python SDK 14/14 |
| #49 | `559f180` | Success | ESLint |
| #50 | `d725841` | Failure | Compose + ingestion image pass; web image fails containerd snapshot copy; proxy unrun |

Historical baseline code stayed frozen through these CI workflow changes. Current HEAD before documentation changes = `d725841ebc828d58cbe90f517da9e600f23c4630` on local/GitHub/GitLab/Gitea.

## Per-phase closure record template — COPY for each P01/P02/P03

### P0X — [TITLE] (OPEN / BLOCKED / CLOSED)

- Authorized baseline / parent SHA:
- Approval command / exact scope document reference:
- Findings addressed + any conditional gates:
- Exact modified paths (one path per row):
- Applied code patch summary (function + lines):
- Existing feature/UI/API/auth/SDK/data preservation audit:
- Focused CI run URL / test counts / exit codes:
- Security check / handling of secrets, data and scope exceptions:
- Verification result: PASS / FAIL / BLOCKED, not assumed:
- Closure commit SHA + GitHub/GitLab/Gitea main SHAs:
- Completed implementation phases: X/3; remaining: Y.
- Next phase: P0Y; **specific approved features** / allowed files:
- New issues / deferred risks / notes evidence links:
- MEMORY.md cross-IDE handoff text (copyable):
  `[DataStack P0X] Baseline=<SHA>; findings=<IDs>; scope=<exact paths>; CI=<run + exit>; commit=<SHA>; remote sync=<all 3>; phase=CLOSED; next=P0Y; production deployment=unchanged.`

## P01 attempted implementation & gate outcome (2026-11-22)

- Frozen source baseline remains `d725841ebc828d58cbe90f517da9e600f23c4630`; latest source HEAD before P01 was documentation commit `d8ac96e39dad4ea3b241c1d2f16f959c5215701e` on all three remotes.
- Disposable CI commit `90fce0629a752dd2916d8d3a2afeaf2c52ed6cbb` contains **16 P01-allowed paths**: `bun.lock` deletion, `package-lock.json` optional/native metadata closure (+67 entries, no existing version or root-manifest change), 14 scoped test files, and `.gitea/workflows/datastack-ci.yml` clean-install/phase-filter changes. No application runtime source/UI/SDK/Docker changes.
- Gitea run: https://dev.ivib.cc/vibtools/DataStack/actions/runs/58; overall **FAIL**, terminal. `windows-compatibility`, `node-regression`, `quality`, `production-build` all failed during clean `npm ci`: `Missing: @tybys/wasm-util@0.10.5 from lock file`. The Python and Docker jobs were intentionally skipped for P01. **No current TypeScript test, strict typecheck, ESLint or build PASS may be claimed**.
- Root issue likely parallel incompatible transitive requirement of `@tybys/wasm-util`; inspect `node_modules/@napi-rs/wasm-runtime` vs `node_modules/@tailwindcss/oxide-wasm32-wasi` in lock and install exact requested transitive version under correct nested path without changing existing pinned entries. Then verify npm clean-install on both platforms and rerun focused P01 acceptance once after repair; do not blindly override lock integrity.
- Local original Windows device's VARUA connection reached monthly call quota; local changes were staged via safe squash on `main` but **no P01 main commit/push** occurred. A separate connected desktop did not have this workspace. Do not claim local/3-remote post-P01 sync until verified.
- **Historical #58 status:** 0/3, P01 BLOCKED before nested lockfile correction. **Superseded by closure evidence below**; no force push or deploy was used.

## Status transition rules

- OPEN -> IN PROGRESS only with explicit approval and baseline SHA match.
- IN PROGRESS -> CLOSED only after one focused CI and exact diff audit, updated `003` + `005` + relevant `001/004/006`, Git commit, sync, and confirmed remote SHA.
- Failed test -> BLOCKED with log excerpt and scope decision; never log as complete.
- Unexpected file change -> STOP and revert only own documented changes safely; never touch pre-existing work.
- At any time, `actual production deployment status` is a separate tracked dimension (do not infer deployed SHA from Git HEAD).

## P01 Final Closure — CI-01…CI-05

- **Status:** CLOSED after one P01 acceptance CI (#59) plus one narrow quality-only correction/retry (#60); completed implementation phases **1/3**, remaining **2** (P02 and P03).
- **Baseline:** frozen source `d725841ebc828d58cbe90f517da9e600f23c4630`; pre-P01 documentation HEAD `d8ac96e39dad4ea3b241c1d2f16f959c5215701e`.
- **Validated implementation code snapshot:** `7d8eebd3dc867e82113343403b63ce1d4ed20584` on disposable Gitea P01 branch. Permanent main commit is the **single squash commit containing this closure log**; remote SHAs and content-tree equality must be checked at publish, not predicted here.
- **Exact P01 patch:** deletion `bun.lock`; append-only 68 optional/native lock entries with zero original package-version changes; 13 in-scope test files with typed mocks, teardown, and shared-helper assertions; narrow `.gitea/workflows/datastack-ci.yml` clean-install and focused verification inputs. `package.json`, `tsconfig.json`, all app/UI/backend/SDK/Docker/production files unchanged.
- **#58 failed before tests** (`@tybys/wasm-util@0.10.5` missing); fixed by nested, registry-hash-verified optional dependency. **#59 overall FAIL** due exactly one TS2339 test teardown type declaration; the same run separately proved 24/24 TS suite exits 0, Linux/Windows original committed-lock `npm ci`, both Node SDK builds, and Next standalone production build (22/22 pages). Fixed only the test declaration; **#60 quality-only PASS** for `npx tsc --noEmit` and `npm run lint` with no error.
- Prior independent Python SDK 14/14 PASS: #48 (SDK unmodified); not rerun during P01. P03 Docker and security/advisory findings unresolved; no Docker builds, live ingestion, network fault injection, migrations, releases or production deployment occurred.
- **Diff audit:** only allowlisted 16 P01 code/test/CI paths and 6 `notes/*.md` files; `git diff --check` PASS; no unrelated features, API behavior, UI or persistent data changed. 1293 original lock entries remained byte-equivalent; 68 optional entries added with integrity hashes.
- **Working tree caveat:** original local Windows VARUA device reached its monthly quota during P01; its current local branch/working tree could not be rechecked and should be reconciled against published `main` before new local work. A separate authorized temporary Windows clone was used for diff and Git push verification. Never claim original PC is already updated.
- **Next:** P02 read-only initial source audit plus targeted disposable fault-injection tests for R-01 (Redis ACK), R-02 (CSV replay), R-03 (health readiness). Runtime-source change requires reproduced issue and a separate exact method/file approval. P03 only after P02 closure.
- **P02 implementation approval command:** `APPROVED — DataStack P02. Implement only notes/002 P02 diagnostic/test write scope for R-01, R-02 and R-03. Keep app/UI/API/auth/SDK/runtime/data unchanged. Runtime files read-only unless a proven failure and separately approved narrow code patch. One focused disposable Gitea CI, exact diff, notes/001–006 update, commit and remote verification. No production deployment or scope expansion.`


## P02 Execution Log — 2026-11-22 (supersedes P02: pending until acceptance)

- **Status: IN PROGRESS / diagnostic CI pending.** Not CLOSED and not a production-readiness certificate.
- P01 published baseline `667a140c4e9e75382bfdcdbe1d3e9eb96f6e808a`. Original PC local `main` still at prior docs HEAD with **16 user-visible staged P01 paths**, preserved untouched. New isolated `p02-readiness-test-20261122` worktree based on published baseline; no reset/stash/force update.
- P02 disposable test commit: `bbe73d91666641743cbec6cf7203f1694094caef`; **only two files**: `tests/phase02-sync.test.ts` (Redis negative-path ACK and health fallback), `tests/phase03-storage-buffer.test.ts` (failure between CSV append and Redis LTRIM, replay). Source contracts and auth flows unchanged.
- Focused evidence: https://dev.ivib.cc/vibtools/DataStack/actions/runs/63. Record terminal suite/typecheck/build results after completion. Test assertions expose existing behavior; they do not implement durability or readiness fixes.
- Scope audited: `server/index.js`, `server/socket/handlers.js`, `server/workers/csvWriter.js`, `core/data/buffer.ts`, `app/api/health/route.ts` all READ-ONLY; `app/**`, `components/**`, `lib/**`, `sdk/**`, Docker, settings, production data and deployments unchanged.
- P01 remains CLOSED (1/3). If R-01 or R-02 are confirmed unsafe, P02 must remain BLOCKED for runtime remediation approval. No P03 implementation on this approval.


### P02 Verified Diagnostic Gate (R-01/R-02/R-03)

- Gitea #63 (test-only commit `bbe73d91666641743cbec6cf7203f1694094caef`): `P02 R-01 diagnostic` PASS, `P02 R-03 diagnostic` PASS, `P02 R-02 diagnostic` PASS. Each PASS validates reproduction of existing behavior, **not a successful reliability remediation**.
- `tests/phase02-sync.test.ts` suite exit 0; `tests/phase03-storage-buffer.test.ts` suite exit 0. Other CI jobs may have independent status; do not infer full job or complete workflow PASS from three cases.
- **BLOCKING RELEASE FINDINGS:** R-01 success ACK issued for non-durable RAM fallback when Redis RPUSH fails; R-02 identical eventId can append twice on post-CSV Redis-trim failure (web-side representative test). R-03 health remains online on Redis loss; liveness-only behavior is backward-compatible, protected dependency-readiness verification remains missing.
- **P02 PHASE = BLOCKED**, diagnostic implementation done, release reliability acceptance NOT satisfied. Runtime remediation requires separate exact approval. 1/3 phases still CLOSED (P01 only); P02 and P03 remain unclosed. No P03 start authorization from this diagnostic completion.
- Next approval must explicitly authorize exact narrow server/core patch for ACK durability and CSV replay deduplication, plus concrete no-loss/no-duplicate tests. Any readiness endpoint change needs separate explicit approval. User's initial P02 approval is insufficient for runtime mutation.


## P02-RUNTIME-REMEDIATION — Candidate implementation checkpoint (2026-11-22)

- **Current P02: BLOCKED / NOT CLOSED.** One previous diagnostic Gitea CI #63 reproduced R-01/R-02/R-03; runtime remediation was separately approved after that. Verified completed implementation phases remain **1/3** (P01 only). Do not approve P03 yet.
- Published P02 diagnosis baseline `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898`; isolated local candidate commit `44eee8877e40d1683f44502c2a0ba3d437a03b88` on `p02-runtime-remediation-20261122`.
- Exactly five code/test files changed in this candidate: `server/index.js`, `server/socket/handlers.js`, `core/data/buffer.ts`, `tests/phase02-sync.test.ts`, `tests/phase03-storage-buffer.test.ts`. No `server/workers/csvWriter.js`, `app/**`, `components/**`, SDK, public R-03 health, CI workflow, database, migration, production data, secrets or deployment touched.
- JS `node --check` on two changed JS files PASS; `git diff --check` PASS and allowlist audit PASS. Targeted TS/Node regression and Gitea CI **NOT YET RUN TO TERMINAL PASS**. The Gitea connector/host was unavailable when dispatch/push was attempted. Local temporary dependency installation also not yet complete.
- The original user PC root `D:\VibTools_Workspace\01_Products\14_DataStack` still has 16 pre-existing staged P01 paths on older `d8ac96e`; deliberately preserved without reset/stash/discard. All P02 implementation is in a separate temporary worktree. Do not assume the old local root is up to date.
- R-01 and R-02 implementations are candidates; practical reliability limitations and I/O cost recorded in `notes/001` and `notes/004`. No false claim of globally exactly-once CSV or universally durable ACK.
- **Next gates:** restore Gitea access; run one focused disposable acceptance; fix any in-scope test/TS defects; record exact CI terminal results; only after required acceptance and security audit, squash single phase main commit and verify GitHub/GitLab/Gitea tree parity; then, and only then, decide P02 CLOSED versus residual-risk blocker.


### Verification environment blocker — local dependency install

The authorized Windows PC attempted a **local disposable** `npm.cmd ci --ignore-scripts --no-audit --no-fund --prefer-offline` in the isolated P02 worktree only; it failed with `npm ERR! ETARGET No matching version found for yaml@2.9.1` plus cleanup EPERM warnings in the temp worktree's `node_modules`. Exact output captured in `%TEMP%\DataStack-P02-npm-ci.log` on the authorized PC. This is **not a passed code test nor proof of a repository package defect**, and `package-lock.json` / `package.json` cannot be edited under P02 scope. Gitea MCP remained UNAVAILABLE and the Git remote/HTTP service was not responding when CI was attempted, so the mandatory P02 focused CI was **not dispatched**. Phase remains BLOCKED pending actual CI evidence; no runtime change was pushed to production/main.


## P02-FINAL-ACCEPTANCE-01 Current Verification (latest record)

- **At this checkpoint: P02 acceptance PENDING CI #69**. P01 CLOSED; P03 NOT STARTED. Do not reinterpret earlier P02 BLOCKED audit as a completed release.
- Gitea #66 on `76cd972bdeea9ef07b4b38e9d8b5b5ed3312ca5b` **COMPLETED SUCCESS**: node-regression 24/24 suites PASS including direct Port4000 replay; quality (strict tsc+ESLint) PASS; production-build PASS; windows-compatibility SDK PASS; Python/Docker skipped by scoped `p01_only` input.
- Final patch `bf525f0d4e5e4781de7fddd2f5e7d3d602a80532` in clean isolated `p02-final-acceptance-20261122`: resolved source-grounded negative-marker TTL bug and mixed-batch success ACK, plus test-only stale-claim time jump (+61s), failed Redis claim, mixed batch, intentionally Redis-free compatibility, rotated .csv.gz+multiline replay and partial-corrupt CSV fail-closed/recovery. No source outside `server/socket/handlers.js` changed since candidate.
- One focused Gitea CI #69 dispatched for final patch; job terminal outcome and any corrective action must be recorded. **Do not merge until this passes and exact patch/security audit is reviewed.**
- Original `D:\VibTools_Workspace\01_Products\14_DataStack` at old `d8ac96e` with 16 staged P01 changes untouched. Separate pre-existing `p02-runtime-remediation-20261122` had three dirty files; left untouched. The new isolated worktree was created clean from candidate SHA.
- Source behavior: no Redis configured = historical RAM best-effort acceptance preserved; configured Redis failure = negative ACK; public /health unchanged. Per-CSV replay scanning bounded-memory but linear in stored bytes; no global exactly-once/throughput guarantee. P03 cannot begin until P02 acceptance/remote parity close.


### P02 Focused Retry — #69 fixture failure / #72 correction

- Final acceptance CI #69 on `bf525f0d4e5e4781de7fddd2f5e7d3d602a80532`: node-regression **FAIL** because `phase02-sync` stale-marker test globally mocked `Date.now` and Socket.IO ACK timed out. Other new tests for gzip/rotated CSV, partial CSV corruption, Redis-free RAM and mixed batch with a new persisted event PASS. Strict TypeScript, lint and Windows SDK jobs PASS; full workflow conclusion must be read at terminal.
- New source-grounded all-duplicate mixed batch path (`processed=0`, `duplicates=1`, `rejected>0`, volatile claim present) could return overall success; added focused test and changed handler conditional to reject all `volatileDuplicate` combinations.
- Test correction removes process-wide Date.now override, verifies 61000ms/300000ms cleanup math with static source marker assertion, and checks real Socket.IO negative retries. No unrelated files, CI workflows, SDK, auth or public health modified.
- Commit `acca8be01a31f8d3972564cbaec8fd3117a0b551` submitted to disposable CI #72; **P02 remains pending / NOT CLOSED** until terminal acceptance and 3-way mirror parity.


## P02 Verified Acceptance and Conditional Publication — 2026-11-22

- **Code acceptance VERIFIED — Gitea CI #72 terminal SUCCESS.** Code SHA `acca8be01a31f8d3972564cbaec8fd3117a0b551`. Node regression exactly `CI_SUITE_SUMMARY total=24 failed=0`, individual `tests/phase02-sync.test.ts` and `tests/phase03-storage-buffer.test.ts` suites exit 0. Quality strict TS+ESLint, Next standalone build and Windows Node SDK jobs all SUCCESS. Python/Docker intentionally skipped in this focused P02 workflow.
- **Root causes fixed:** configured Redis RPUSH outage returns `BUFFER_PERSIST_FAILED` negative ACK rather than volatile RAM success; stale failed idempotency claim retains correct TTL and remains negative through retries; `batch_sync` with old durable duplicates plus failed volatile claim returns `success:false`; CSV-before-Redis-LTRIM replay suppresses previously written same-client/date/eventId across plain/rotated/gz CSV with multiline quoted payload; corrupt matching CSV prevents Redis trim and can be recovered after disposable repair.
- **Explicit limits:** Redis intentionally unconfigured retains historical best-effort RAM ACK; no globally atomic exactly-once promise; scan I/O proportional to matching partition bytes even though memory streaming; public /health continues liveness not dependency readiness; live production unknown. No deployment, migration, secret access, user-data mutation, tag, release or build of production images.
- **Historical testing:** #66 PASS candidate; #69 suite failure (Socket.IO ACK timeout caused by test-only global `Date.now` override) and cancellation; #72 PASS corrected source/test. No false claim that #69 succeeded.
- Final code/diff safety audit: 11/11 approved paths only: `server/index.js`, `server/socket/handlers.js`, `core/data/buffer.ts`, `tests/phase02-sync.test.ts`, `tests/phase03-storage-buffer.test.ts`, plus `notes/001–006`; `git diff --check` and JS syntax PASS. Original PC root old staged P01 (16 paths) and separate dirty earlier temporary worktree preserved.
- **Publication gate:** Gitea PR #3 final verified source + documentation notes; squash-merge with `[skip ci]`, publish to GitHub and GitLab, verify identical tracked Git trees despite potentially different GitLab commit SHA. P02 marked CLOSED only after three-remote content parity; evidence SHA/tree in operator's final publication report. P03 NOT STARTED and requires separate approval.

## P03 final CI acceptance ledger — 2026-11-22

| Gate | Terminal outcome |
| --- | --- |
| #77 Node | SUCCESS, 24/24 |
| #77 TypeScript / ESLint | SUCCESS |
| #77 Next standalone build | SUCCESS |
| #77 Windows Node SDK | SUCCESS |
| #77 isolated three-image BuildKit | SUCCESS |
| #77 read-only npm audit inventory | SUCCESS with 1 high runtime finding |
| #77 Python | FAILED before tests: checkout requires Node |
| #78 corrected Python-only | SUCCESS, 14/14; other jobs SKIPPED |

**CI-08 security disposition:** `npm audit --json` full=26 affected packages (25 moderate, 1 high); runtime=24 (23 moderate, 1 high), **not counts of distinct advisories**. High-severity advisories [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) affect Next 15.5.29's nested `postcss@8.4.31` despite patched root `postcss@8.5.33`; npm recommends major `next@16.4.6`. Direct `cloudcmd@19.24.0` carries moderate transitive issues (`dompurify`, `file-type`, `glob`, `minimatch`, `got`); npm recommends `cloudcmd@17.0.2` downgrade, not a verified safe pin. No speculative package pin, major upgrade or force fix; a separately tested compatible remediation is needed before release.

**Scope / release decision:** only `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, and `notes/001–006` changed. No `package.json`/lock, Dockerfile, application UI/UX, runtime, auth, SDK, database, Compose, production data, secret, shared Docker prune, deployment, migration, tag or release. P03 technical CI and advisory-triage acceptance verified by #77 non-Python jobs plus #78 Python; do **not** mislabel #77 overall as successful. Final phase publication requires one main commit and Gitea/GitHub/GitLab exact tracked tree parity. **Production release NO-GO** while runtime high advisory is unresolved; live production health, throughput and deployment remain unverified.

## P04-S01 security remediation kickoff — 2026-11-22

**Status: IN PROGRESS / NOT ACCEPTED.** User-approved baseline `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`. Scope `package.json`, npm-generated `package-lock.json`, existing Gitea CI `security-audit` job, `notes/001–006`. Root cause `node_modules/next` locks `postcss@8.4.31` while root is `8.5.33`; P03 runtime audit 1 high and 23 moderate package entries. Plan minimal nested npm override, lockfile-only regeneration, high/critical audit gate; preserve all runtime/UI/API/auth/SDK/DB/Compose/production. One focused CI acceptance and exact 3-remote tree equality required; DO NOT label closed before terminal results, publish or claim release-ready.

## P04-S01 blocked security reconciliation report

P04-S01 SEC-01 BLOCKED — 2026-11-22. Approved scoped `overrides.next.postcss=8.5.33` trialed in disposable Windows npm 10.9.8 workspace only. `npm install --package-lock-only` EXIT 0, but `npm ls --package-lock-only postcss --all` EXIT 1 (`ELSPROBLEMS`: Next nested `postcss@8.4.31` invalid; expected 8.5.33); npm dedupe also kept invalid dependency. Read-only `npm audit --omit=dev --json` EXIT 1, runtime high 1/moderate 23/critical 0. Lockfile regeneration caused unrelated churn (91 package entries added, 106 removed, 69 changed, including two lightningcss optional 1.33.0 -> 1.30.1). Fresh minimal Next 15.5.29 fixture with identical override resolves PostCSS 8.5.33, isolating failure to DataStack committed lock graph. `npm ci --dry-run` exit 0 does not prove real clean install. Exact stop rule applied: no dependency patch, no CI acceptance, no main commit, no GitHub/GitLab sync, no release/deploy; production NO-GO. Need separate explicit narrowly scoped lock reconciliation approval.

Candidate branch `p04-s01-postcss-security-20261122` contains notes only. Gitea main stays `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`; no Gitea CI was dispatched and no phase acceptance established.

## P04-S01B run ledger — 2026-11-22

**P04-S01B = BLOCKED / stop rule.** Disposable Windows npm 10.9.8 only (not user project workspace). Verified baseline Gitea `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3` and candidate notes branch `4abcc55fee927b5ae2c1193cea2b4585b8d00158` before test. With approved stale node deletion in disposable lock plus scoped manifest override, `npm install --package-lock-only` 0, `npm ls --package-lock-only postcss --all --depth=4` 0, audit high 0 / critical 0 / moderate 22. Next 15.5.29, Cloudcmd 19.24.0 and every unrelated package version unchanged; package entries added 0, removed 1 (stale `node_modules/next/node_modules/postcss`), existing entries with changed metadata 67 (36 dev, 29 libc, 2 dependency ordering overlaps). **Reject generated candidate due preservation of unrelated metadata requirement.** No real npm ci, regression, Docker, focused Gitea CI, security gate edit, application changes, main commit, GitHub/GitLab mirror or release. P03 CLOSED, P04-S01B NOT CLOSED, published production still NO-GO.

## P04-S01C verified six-job acceptance checkpoint — 2026-11-22

- User-approved baseline Gitea main `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3` still unchanged; candidate source commit `c759be990c032c2474d2d0bad519c643dec11a3a`, PR #5 draft pending acceptance.
- Exact source diff: only `package.json` scoped override, `package-lock.json` delete stale nested PostCSS entry (one package), existing `.gitea/workflows/datastack-ci.yml` security-audit threshold. Updated notes six files only; no runtime/SDK/UI/test/Dockerfile/Compose source changes.
- [Gitea CI #85](https://dev.ivib.cc/vibtools/DataStack/actions/runs/85) results as of checkpoint: node-regression **SUCCESS** `CI_SUITE_SUMMARY total=24 failed=0` plus real Linux `npm ci`; python-regression **SUCCESS** `Ran 14 tests`, `OK`; quality tsc/ESLint **SUCCESS**; production Next standalone **SUCCESS**; Docker/BuildKit 3 images **SUCCESS** `DATASTACK_THREE_IMAGES_BUILD_PASS`; security-audit **SUCCESS** runtime high 0/critical 0, `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO`, full moderate 24/runtime moderate 22. Windows-compatibility **QUEUED** at checkpoint: no terminal proof; entire run must not be mislabelled success.
- **P04-S01C PENDING** terminal Windows acceptance, main squash commit, GitHub/GitLab parity. Production NO-GO; 22 moderate runtime package entries and live readiness remain unresolved.

## P04-S01C FINAL CI acceptance (7/7) — 2026-11-22

Gitea CI #85 https://dev.ivib.cc/vibtools/DataStack/actions/runs/85 COMPLETED/SUCCESS; tested implementation SHA c759be990c032c2474d2d0bad519c643dec11a3a; later changes to candidate are documentation only. All seven jobs terminal SUCCESS: node-regression (Linux committed-lock npm ci and exactly 24/24 TypeScript suites); python-regression (Ran 14 tests, OK); quality (strict tsc and ESLint); production-build (Next 15.5.29 standalone, 22/22 pages); docker-image-build (three isolated BuildKit ingestion/web/proxy images); windows-compatibility (Windows committed-lock npm ci and Node SDK build, job #182, terminal SUCCESS); security-audit (runtime moderate=22 high=0 critical=0; full moderate=24 high=0 critical=0; DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO). Single Gitea acceptance run used, no additional broad reruns.

Scope: exactly nine approved paths: package.json scoped next->postcss 8.5.33 override; package-lock.json removes only old nested postcss@8.4.31 entry; existing .gitea/workflows/datastack-ci.yml security-audit job high/critical rejection; notes/001–006 evidence. Other package metadata, versions, integrity and resolved URLs match baseline. Next.js 15.5.29 and Cloudcmd 19.24.0 preserved. Final candidate package-lock SHA256 e6b5b362877627085dc04c9ded03c019971e07ef9f4af1e78057d58961a1c091 (verified byte-for-byte with Gitea). No API, auth, SDK, UI, application runtime, database, Compose, Dockerfile, tests or production data changes, deployment, migration, prune, tag, release.

CI fully accepted; publication not yet asserted in these pre-merge notes. Final phase CLOSED requires one squash merge of PR #5 into Gitea main and verified identical tracked content across Gitea/GitHub/GitLab; record actual new SHAs in terminal report. Production release remains NO-GO pending P04-S02 moderate vulnerability triage and separately authorized live readiness verification.

## P04-S02 scoped candidate — 2026-11-22

Baseline Gitea main `2d467ff1494858164a37814f7dbc2b321f510291`, tree `648c76ca496d2c9bf22a16f558c9ba347a45d4f7`. Cloudcmd 19.24.0 -> deepword 11.0.1 -> monaco-editor 0.55.1 pins DOMPurify 3.2.7, vulnerable according to npm advisory inventory. Disposable Windows npm 10.9.8 `npm view dompurify@3.4.18` verified, scoped npm override `overrides.cloudcmd.dompurify=3.4.18` resolves `dompurify@3.4.18` via `npm ls --package-lock-only dompurify --all --depth=5` (exit 0). `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-offline` exit 0. npm graph initially changed 67 unrelated metadata entries; deterministically restored exact baseline values after validating unrelated versions, URLs, integrity and dependencies. Final lock has **one changed package entry**, DOMPurify; same-major replacement plus verified registry `resolved` and `integrity`, no other packages added/deleted/changed. Candidate runtime audit affected-package counts **moderate 20/high 0/critical 0** versus baseline **22/0/0**; full candidate **moderate 22/high 0/critical 0** versus baseline **24/0/0**. DOMPurify and Monaco Editor dropped from vulnerable-package inventory. Other moderate packages (got, glob, minimatch, nested file-type, Cloudcmd transitive chain) remain; they require major package changes under current advisory constraints, prohibited by Scope Lock. This is a **pre-acceptance candidate**: do not claim application compatibility, CI PASS, publication, or phase CLOSED before full focused Gitea CI and exact three-remote tree parity.

Phase ledger: P04-S02 candidate patch under test, not yet accepted. One focused CI to verify Linux/Windows npm ci, Cloudcmd File Manager existing tests, Node 24/24, Python 14/14, TS/lint, Next standalone and Docker 3 images.

## P04-S02 final CI acceptance — 2026-11-22

Gitea CI #92 (https://dev.ivib.cc/vibtools/DataStack/actions/runs/92) **COMPLETED / SUCCESS**, all 7/7 jobs terminal success on source commit `a88bc5f4498ea1b11acc0acfeb66b5aa9d6531be`: node-regression real Linux npm ci + 24/24 tests including `tests/files-manager.test.ts` exit 0; Python SDK 14/14; quality strict TypeScript/ESLint; Next.js standalone (22/22 static pages); isolated Docker/BuildKit 3-image verification `DATASTACK_THREE_IMAGES_BUILD_PASS`; Windows committed-lock npm ci + Node SDK compatibility; security-audit `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO` and `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Audit full=22 moderate/high=0/critical=0 (baseline 24), runtime=20 moderate/high=0/critical=0 (baseline 22). These are affected package entries, not distinct advisories. No new CI workflow or extra broad CI dispatched.

Exact approved patch: `package.json` scoped `overrides.cloudcmd.dompurify=3.4.18`, preserving `overrides.next.postcss=8.5.33`; npm-generated `package-lock.json` changes solely `node_modules/dompurify` version 3.2.7 -> 3.4.18 and verified `resolved`/SHA512 integrity. Baseline Cloudcmd 19.24.0, Monaco Editor 0.55.1, Next.js 15.5.29, all unrelated locked package versions, URL, hash, dependency and metadata preserved. Gitea published candidate lock bytes match disposable SHA-256 `57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854`. Exact candidate tree diff 420 entries, 8 approved changed files only (`package.json`, `package-lock.json`, notes/001–006), 0 unauthorized paths. No runtime/UI/auth/API/SDK/tests/CI/Dockerfiles/Compose/db/schema/data modifications.

Phase ledger: P04-S02 fully CI-accepted, publication gate pending. **Residual risk:** 20 moderate runtime affected package entries remain, including Cloudcmd transitive dependencies `got`, `glob`, `minimatch`, nested `file-type` and their parent chains. Current npm audit suggests `cloudcmd@17.0.2` (a major downgrade), explicitly out-of-scope; other transitive fixes need major-version dependency-contract changes. No force/downgrade/unverified override. Security improvement verified but NOT zero vulnerabilities. Production release stays NO-GO; remaining advisory disposition and live readiness need independent scope approval.

**Merge gate:** CI #92 7/7 PASS, approved 8-file patch integrity PASS; main squash merge and Gitea/GitHub/GitLab exact Git content-tree verification required before P04-S02 CLOSED. This note is written before that publication, so final remote commit SHAs shall be appended to the PR closure report after verification. No deployment, migrations, prune, tag, release.

## P04-S03 — Verified forensic STOP decision (2026-11-23)

Gitea main a9ad7700638bea5a7a815c6582721ba517744087, tree 1a0790d0d5922a2df5d529d60a1f106651a3654f. P04-S02 remains accepted (CI #92 7/7 PASS); all approved Cloudcmd 19.24.0, Next 15.5.29, PostCSS 8.5.33 and DOMPurify 3.4.18 locks preserved. Windows disposable npm 10.9.8/Node 22.23.2 inspection downloaded the exact Gitea package.json/package-lock.json; original lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. `npm ls --package-lock-only cloudcmd got glob minimatch file-type dompurify --all --depth=5` exit 0. Fresh `npm audit --omit=dev --json` reports runtime moderate=20/high=0/critical=0, full `npm audit --json` moderate=22/high=0/critical=0; npm audit exit 1 because existing moderates, not a tool failure. Counts are affected package nodes, not distinct advisories.

Four direct npm audit advisories explain inherited runtime findings: got `GHSA-pfrx-2q88-qq97` (<11.8.5, first patched 11.8.5), glob `GHSA-3g3m-2fjr-6pw4` (>=9 <=14.0.1, patched 14.0.2), minimatch `GHSA-g3hv-75wg-m249` (>=7 <11.0.1, patched 11.0.1), file-type `GHSA-5v7r-6r5c-r473` (>=13 <21.3.1, patched 21.3.1). Registry confirmed availability of got@11.8.5, glob@14.0.2, minimatch@11.0.1; file-type@21.3.4 is already present as a patched root copy, while its two nested vulnerable copies are 16.5.4. Specific constrained parents: @cloudcmd/dropbox@5.0.3 -> dropbox-stream@3.2.0 -> got `^10.6.0` (locked 10.7.0); console-io@15.0.4 -> spawnify@8.0.1 -> glob `^10.3.3` (locked 10.5.0) -> minimatch `^9.0.4` (locked 9.0.9); inly@5.0.1 -> glob `^10.3.10` and onezip@6.1.1 -> glob `^10.3.10`; Cloudcmd -> onezip@7.0.3 -> glob `^13.0.6` (locked 13.0.7) -> minimatch `^10.2.2` (locked 10.2.6); dword/edward -> join-io@5.0.0 -> ponse@6.0.0 -> file-type `^16.2.0` (locked 16.5.4); restbox@4.0.1 -> ponse@7.0.0 -> file-type `^16.2.0` (locked 16.5.4). Patch version for each lies outside its parent semver major; no compliant same-major security upgrade exists for these vulnerable leaves. npm suggests Cloudcmd 17.0.2 downgrade, specifically forbidden. No forced override was attempted since each candidate violates approved compatibility boundary.

**Status:** forensic task completed, remediation BLOCKED; published runtime moderation count stays 20, full stays 22, high/critical 0. Existing CI #92 baseline PASS is reused; no new CI or app edits since no safe candidate exists. Documentation-only publication should be audited for six notes paths and three-remote parity before phase disposition is recorded as CLOSED. No production release.

## P04-S04 — Phase status (2026-11-23)

Approved baseline Gitea main 986ac1fcb2cced4cb5b330429084b9206f84a791, tracked tree 118fae01fb48c9435907aa5b696e78eba3cc8d36 (420 entries). Disposable Windows Node 22.23.2/npm 10.9.8 copied byte-exact published package.json/package-lock.json; lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. Live registry.npmjs.org upstream metadata inspected 17 parent package names (all fetches passed) and 17 parent/dependency constraint assertions exit 0.

Four direct npm audit GHSA roots remain: got GHSA-pfrx-2q88-qq97 (patched >=11.8.5), glob GHSA-3g3m-2fjr-6pw4 (patched >=14.0.2), minimatch GHSA-g3hv-75wg-m249 (patched >=11.0.1), file-type GHSA-5v7r-6r5c-r473 (patched >=21.3.1). Latest supported upstream parent metadata: @cloudcmd/dropbox 5.0.3 -> dropbox-stream ^3, dropbox-stream 3.2.0 -> got ^10.6.0; console-io 15.0.4 -> spawnify ^8, spawnify 8.0.1 -> glob ^10.3.3; inly 5.0.1 -> glob ^10.3.10/onezip ^6, onezip 6.1.1 -> glob ^10.3.10, onezip 7.0.3 -> glob ^13.0.6; glob 10.5.0 -> minimatch ^9.0.4, glob 13.0.7 -> minimatch ^10.2.2; join-io 5.0.0 -> ponse ^6, restbox 4.0.1 -> ponse ^7, ponse 6.0.0 and 7.0.0 -> file-type ^16.2.0. Root file-type 21.3.4 already patched; nested file-type 16.5.4 remains. Latest @cloudcmd/fileop 9.1.1 still pins inly ^5 and onezip ^7: no advisory improvement. Cloudcmd latest 19.24.0 unchanged. Latest glob 14.0.6 uses minimatch ^11.0.5, incompatible with existing parent ranges. None of these latest parent releases supports a patched leaf major.

Current fresh npm audit --omit=dev --json: runtime affected package entries moderate=20, high=0, critical=0; npm audit --json: full moderate=22, high=0, critical=0. Both audit commands exit 1 due documented moderate advisories, not audit parser errors. Baseline audited lock SHA-256 unchanged; no dependency patch or npm installation. Historical unchanged-code Gitea CI #92 remains 7/7 SUCCESS (not a new P04-S04 CI).

Acceptance ledger: registry 17/17 retrieval PASS, 17/17 parent constraint assertions PASS, fresh audit counts baseline unchanged, no code patch generated. Notes-only exact diff and three-remote tree parity required before this forensic disposition is closed.

P04-S04: FORENSIC DISPOSITION COMPLETE, COMPATIBLE SECURITY REMEDIATION BLOCKED by approved Scope Lock. Parent-documented support is mandatory before major transitive upgrade; upstream has no supporting releases. No unsupported leaf overrides, forced npm audit fix, Cloudcmd downgrade, UI/feature/API/auth/SDK/test/CI/Docker/Compose/DB/production changes. Exact publication is notes/001-006 ONLY; package manifest, lock and runtime byte-exact baseline. No new broad CI because no candidate. No deployment, migration, shared prune, tag or release. Production NO-GO. Do not mark four advisories resolved or claim zero moderate. Any parent patch/fork, compatibility adapter, or operational risk acceptance requires separate exact user approval.

## P04-S05 — Phase status and acceptance limits (2026-11-23)

Baseline Gitea main f1e04f0689374f401d2f6fd1f97dbc010e2a5015, tracked tree ceb44222e85f3aa64c3e8fcfca1d335cc4a9c6b3, 420 entries. Existing P04-S04 forensic PR #8 records Cloudcmd 19.24.0 and vulnerability constraints. P04-S05 is STATIC SOURCE / UPSTREAM PACKAGE / ADVISORY review only. Runtime affected packages: moderate=20, high=0, critical=0; full audit: moderate=22, high=0, critical=0 (last verified unchanged dependency graph). No live deployment, traffic, runtime exploitation or production session inspection. Source read-only; inherited accepted CI #92 is historical, not new P04-S05 test evidence.

DataStack source-level facts: server/index.js:2530-2538 mounts Cloudcmd File Manager on ingestion port 4000; server/filesManager.js:975-1075 mounts securityGuard first, then Cloudcmd middleware at /vcon/files-engine. server/filesManager.js:664-704 locks root, sets terminal:false, console:false, dropbox:false, packer:zip, zip:true, editor:edward, disabled import/export and config UI. HTTP middleware 711-851 validates admin session, CSRF for unsafe methods, viewer-write denial, path traversal and *.lock; PUT JSON mutation body limit 512KiB at 767-800, NOT a general upload size limit. Socket namespaces 854-973 independently gate session/write/editor events. docker/coolify-nginx.conf:60-73 forwards /vcon/files-engine to ingestion; Docker Compose exposes 4000 internally (source config, NOT verified live firewall). UI components/sections/FilesManagerWorkspace.tsx:24-26,123-133,196-204 show iframe, browsing, editing, upload/download and ZIP/UNZIP. Existing tests/files-manager.test.ts:66-278 exercise auth 401, viewer 403, CSRF, path lockdown, PUT CRUD/rename, ZIP/UNZIP and GET download on an ephemeral localhost server; NOT hostile payload/fuzz or a deployed validation.

Upstream package-source inspection (registry tarball sources, disposable only): cloudcmd@19.24.0 server/cloudcmd.js:211-287 calls config('console') && konsole, config('terminal') && terminal and config('dropbox') && restbox, confirming those integrations are gated under the DataStack configured false values; restafary/HTTP File Manager and editors remain mounted. dropbox-stream@3.2.0 api.js:91 invokes got.stream.post when its Dropbox API function runs; no DataStack-enabled Dropbox call established. spawnify@8.0.1 lib/spawnify.js imports glob, but console disabled; onezip@7.0.3 bin/onezip.js:73 and inly@5.0.1 bin/inly.js:46 use glob in inspected CLI entrypoints, not proof that their library runtime calls have the same glob invocation. Nested ponse@6.0.0/7.0.0 lib/ponse.js:221 calls filetype.fromFile during sendFile(); restbox@4.0.1 uses ponse helpers but Dropbox route conditional; join-io@5.0.0 inspected join.js invokes ponse.getPathName/setHeader/sendError, not sendFile. Cloudcmd main ponse@8.0.2 uses already patched root file-type@21.3.4. No end-to-end DataStack HTTP handler -> vulnerable nested file-type parser demonstrated. Avoid asserting unreachable; dynamic imports, alternate paths, and actual deployed settings remain unverified.

### Advisory-specific risk matrix
- got / GHSA-pfrx-2q88-qq97: malicious response redirect to Unix socket; ancestor @cloudcmd/dropbox -> dropbox-stream@3.2.0 -> got@10.7.0. Dropbox false and route gated; currently no direct invocation proven; risk conditional if integration reenabled, actual run-time policy differs or an alternate path invokes it. No vulnerability fixed.
- glob / GHSA-3g3m-2fjr-6pw4: aborted async walk may continue filesystem traversal after abort; installed via spawnify/inly/onezip parent chains. Need actual vulnerable glob() with AbortSignal; no such invocation found in inspected DataStack route source and sampled upstream library entrypoints. Conditional/unverified, not classified zero exposure.
- minimatch / GHSA-g3hv-75wg-m249: attacker-controlled glob pattern together with optimizationLevel >=2 can amplify processing; installed via glob 10/13. No attacker-supplied glob pattern or optimizationLevel=2 reached in inspected DataStack handlers; conditional/unverified without dynamic path tracing.
- file-type / GHSA-5v7r-6r5c-r473: crafted ASF/WMV/WMA input causes event-loop infinite-loop in affected parser; nested file-type@16.5.4 via ponse@6/7. Upstream ponse.sendFile() calls filetype.fromFile() but its DataStack-mounted invocation not established; Cloudcmd core ponse@8 is patched file-type@21.3.4. Authentication & root restrictions reduce accessible sources but do not guarantee malicious content is impossible. Potential high availability impact if nested vulnerable sendFile invoked on untrusted data. No live exploit test performed.

Risk treatment (PROPOSED, NOT APPLIED): preserve existing disabled Dropbox/terminal/console, mandatory auth and viewer RBAC; inspect effective live config and public exposure only with separately approved READ-ONLY live access. Prefer upstream-compatible backports to got 10, glob 10/13, minimatch 9/10, file-type 16 or maintained vetted forks with identical public API; require independent security review and clean npm lock integrity before approval. For possible file-type parsing DoS, consider a narrowly scoped input/media validation or worker isolation with hard time limit, but any runtime implementation requires separate user permission, tests, and explicit feature-preservation contract. For glob and minimatch investigate exact dynamic patterns/AbortSignal use without feeding hostile payload to production; for got confirm configured Dropbox routes and egress at live edge. Request upstream fixes from maintainers (outside this repo) only when authorized. Existing role/path guards are defense-in-depth, not formal risk acceptance.

Phase gates: [PASS] approved baseline SHA/tree; [PASS] four advisory preconditions; [PASS] upstream library call-site checks; [PASS] exact notes-only diff (pending merge); [NOT PERFORMED] live exposure/penetration; [NO CHANGE] deps/app/CI and vulnerability counts; [PENDING] PR squash merge & 3-way parity. Phase close means documentation only, not vulnerability remediation.

P04-S05 STATIC FORENSIC/RISK ASSESSMENT COMPLETE, EXPLOITABILITY NOT PROVEN AND REMEDIATION NOT IMPLEMENTED. No feature, runtime, UI, auth, API, SDK, dependency, lockfile, test, CI, Docker/Compose, secrets, DB or production edit permitted. Only six approved notes may be changed. No fresh broad Gitea CI because source/lock never changes. 20 affected Moderate runtime nodes persist and cannot be declared safe/unreachable based on static evidence; release remains NO-GO. A future narrowly approved risk-treatment patch phase must specify exact file-level exception(s), unchanged feature contracts, isolated adversarial smoke tests and CI acceptance; the alternative is a separately approved monitored risk-acceptance decision. Neither is silently authorized.

## P04-S06 — Acceptance and phase-status ledger (2026-11-23)

Approved baseline main 79fae037c5920514062c6fbbb3d7eb8133f6449d, 420-entry tree 6aad5a613822c8b119cd558778b7cb7372b4b248. Approved dependency versions unchanged: Cloudcmd 19.24.0, Next 15.5.29, PostCSS 8.5.33, DOMPurify 3.4.18. P04-S05 PR #9 static risk findings respected. Four known direct advisories: got GHSA-pfrx-2q88-qq97, glob GHSA-3g3m-2fjr-6pw4, minimatch GHSA-g3hv-75wg-m249, file-type GHSA-5v7r-6r5c-r473.

Isolation: two authorized disposable Windows sessions used after first execution connector became unavailable. The completed controlled run used temp-cloned Gitea baseline with native Windows Node 26.12.0/npm 11.20.0 and a separately installed Node 22.23.5 runtime via npm exec (no source edits). Clean committed-lock npm ci installed 1,278 packages (exit 0), npm ls cloudcmd/got/glob/minimatch/file-type integrity exit 0; git status remained clean. Baseline lock SHA256 AAA2147F736B33F02109E2FECA2209DC17E1016882B2948A0E16AA2344B4D020. Fresh npm audit runtime: 20 affected Moderate package entries/0 High/0 Critical; full: 22 Moderate/0 High/0 Critical, audit exit 1 due existing Moderate findings.

Dynamic test: external disposable CommonJS Module._load instrumentation logged project-root LOAD events for got (via dropbox-stream/api.js), glob (via spawnify/lib/spawnify.js), minimatch (via glob's CommonJS modules), and nested file-type (via restbox/node_modules/ponse and join-io/node_modules/ponse). Feature-disabled Dropbox can still cause its library to LOAD; LOAD is NOT function invocation or reachable exploit. No corresponding monitored vulnerable CALL events recorded before test stopped, and ESM/dynamically imported functions are outside this CommonJS hook's complete coverage. Tracer was NOT committed to the repo, only temporary tooling. Module-load evidence is not end-to-end proof of exploitability or safety.

Focused existing tests/files-manager.test.ts on Windows: native Node 26.12.0 instrumented result 3/4 PASS, 1 FAIL; supported Node 22.23.5 instrumented result 3/4 PASS, 1 FAIL; Node 22.23.5 without instrumentation ALSO 3/4 PASS, 1 FAIL. Identical first failing assertion tests/files-manager.test.ts:154: authenticated PUT /vcon/files-engine/api/v1/fs/client-alpha/note.csv returned HTTP 404, expected 200. GET status/HTML and preliminary checks passed, but full CRUD/ZIP/UNZIP dynamic operations after that point were NOT exercised. Uninstrumented repro rules out tracer as sole cause; Windows-specific reason or environment/proxy path root cause NOT established. Historical Gitea CI #92 Linux File Manager PASS remains prior evidence only, not new P04-S06 acceptance.

Phase status: static baseline verified; disposable real clean npm ci PASS; dependency tree PASS; Windows File Manager E2E FAIL at 404 in instrumented and clean Node22 runs; limited CJS load trace complete; dynamic reachable exploit NOT PROVEN; secure compatible package candidate NOT FOUND; runtime security 20 Moderate unchanged. P04-S06 forensic disposition can be docs-only CLOSED after exact six-note diff and three-remote tree parity, while actual requested remediation remains BLOCKED. The historical CI #92 is NOT a new P04-S06 PASS.

P04-S06 forensic reachability/disposition COMPLETE but compatible security remediation BLOCKED: P04-S04's latest upstream parent contracts do not accept patched leaf majors, and no publisher-authenticated, vetted, API-compatible older-major backport with exact published integrity and verified regression evidence was established. No unverified override, package or lock patch, npm audit fix --force, app/SDK/test/CI/Docker/Compose/UI/DB/prod change. No new broad Gitea CI because no approved dependency candidate. Only approved notes/001–006 may be committed and mirrored; no deployment, migration, prune, tag, release. Production remains NO-GO; 20 runtime Moderate package entries unresolved. Do not claim full dynamic reachability verification, File Manager compatibility PASS, fixed advisories, or zero exposure.

## WF-01 — Gitea-first / PC backup-only (2026-11-23; candidate, CI pending)

Approved baseline Gitea `d9d1c2f4b2b102599c687090ea56345d58e00d14`, tracked Git tree `98a7e07b1cbc8b6669ffc728b3d68a87f602bfa4` (420 entries); previous P04-S06 PR #10 closed, last accepted CI #92 7/7 PASS on earlier P04-S02 source. Exact WF-01 write allowlist: `.gitea/workflows/datastack-ci.yml`, `notes/002-PRODUCTION-UPDATE-ROADMAP.md`, `notes/003-PHASE-STATUS-LOG.md`, `notes/006-BASELINE-AND-PATCH-EVIDENCE.md`; all other tracked paths read-only. No P04-S07 application defect fix authorized in WF-01.

Runner read-only preflight: Gitea CI #92 logged `coolify-linux-runner` on `ubuntu-latest` and `windows-rdp-runner` on `windows-latest`. An independent remote inventory found online RDP host `WIN-IK7N6SD2UBU`, `C:\gitea-runner\act_runner.exe` and running `act_runner.exe` (PID 6708), matching prior verified dedicated Windows runner identification rather than the user's personal PC. No runner config, service, label or location modified. Linux production-host isolation / Docker socket remains a separately documented operational risk; no cleanup or destructive daemon operation authorized.

CI trigger design: retain manual `workflow_dispatch` and existing main-workflow-file push trigger; add `pull_request_target` for opened/reopened/synchronize targeting main with notes-only/Markdown-only filtering. The workflow is read from the trusted base branch; every heavy job is fail-closed unless `head.repo.full_name == github.repository` and PR base is main. Fork PR code is never checked out or executed on self-hosted runners by this workflow. Same-repo PR jobs explicitly checkout their head SHA with `persist-credentials: false`; GITEA_TOKEN permission reduced to `contents: read`. This is a trusted internal PR/candidate acceptance gate, not an authorization to execute arbitrary untrusted forks. Docs-only changes are manual review without redundant broad CI. No changes to the seven job scripts or existing tests/build behavior.

Gitea API version reported `28.4.0` during preflight. `main` branch unprotected at baseline; branch protection is proposed only, not applied: require verified full CI and human approval before merge, disable unreviewed direct main writes after separately approved protection configuration. Existing unmerged WIP P02 PR #4 must not be merged. Personal PC stays fetch/pull backup-only; no local npm, Python, tests, Docker, builds, resets, cleans or packages.

Candidate state: no acceptance PASS or mirror sync claimed yet. Next gate: one focused Gitea workflow dispatch on this exact candidate after remote runner safety confirmation, inspect terminal seven-job result and exact four-path patch, then squash once into Gitea main with `[skip ci]` to avoid duplicate full-CI trigger, sync GitHub/GitLab and compare 420 tracked objects. If acceptance fails or remote isolation becomes uncertain, STOP without main merge. Production NO-GO: Windows File Manager PUT 404, 20 runtime Moderate dependency entries and live acceptance remain unresolved.

