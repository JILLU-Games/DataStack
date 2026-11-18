# Contribution Rules & Guidelines

Thank you for contributing to **DataStack**! To maintain architectural purity, production reliability, and seamless collaboration across multiple development environments, all contributors must adhere to these guidelines.

---

## 1. Universal Multi-IDE Persistent Memory (`MEMORY.md`)

> **CRITICAL RULE**: DataStack is developed across multiple IDEs and AI toolchains (such as VS Code, Google Antigravity, Cursor, and terminal environments). Whenever any modification, update, or bug fix is completed in your session, you must automatically update the `MEMORY.md` file (or provide the exact markdown blocks) so the project context remains perfectly synchronized across all IDEs (see `.ai-rules` and `AGENTS.md`).

When updating `MEMORY.md`:
- Note any new files, directories, routes, or modules added to the repository.
- Record any updated environment variables, runtime parameters, or architectural adjustments.
- Update the status of active features or resolved bugs.

---

## 2. Architectural Guardrails (Strict Enforcement)

1. **Dual-Runtime Separation**:
   - Next.js 15 App Router (`app/`) runs on **Port 3000**.
   - Express 5 + Socket.IO (`server/index.js`) runs on **Port 4000**.
   - **Never** initialize Socket.IO server instances inside Next.js serverless route handlers.
2. **Zero Telemetry Writes to PostgreSQL**:
   - Incoming telemetry events **must never** be inserted as rows into PostgreSQL.
   - Events are buffered in memory and Redis, then appended to daily CSV partitions in `/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
   - PostgreSQL is strictly reserved for `admin_users`, `admin_login_attempts`, `client_sdks`, `deleted_clients`, and `admin_settings`.
3. **Non-Destructive Database Migrations**:
   - Never write code that executes `DROP TABLE`, `DROP COLUMN`, or `TRUNCATE` against production databases.
   - All schema upgrades must use defensive `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements.
4. **Cooperative CSV Locking**:
   - All disk write operations must acquire cooperative file locks (`.lock`) with automated stale-lock recovery to prevent dual-writer corruption.

---

## 3. UI Component & Design System Standards

- **Single Source of Truth**: All UI primitives must reside in `components/ui/` (`Button`, `Input`, `Modal`, `Table`, `Panel`, `StatCard`, etc.) and layout shells in `components/layout/`. Do not introduce ad-hoc isolated CSS or duplicate button components.
- **Design Tokens**:
  - Border radius: `--radius: 0rem` across all components.
  - Shadows: None (`--shadow: none`). Crisp, clean 1px borders with dark and light mode support.
  - Font stack: `"Segoe UI", "Segoe UI Web", system-ui, -apple-system, "Helvetica Neue", sans-serif`.
- **Icons**: Import all icons exclusively from `lucide-react`.

---

## 4. Pull Request & Pre-Submission Checklist

Before submitting a Pull Request:
1. **Lint Check**: Run `npm run lint` and verify zero errors and warnings.
2. **Build Check**: Run `npm run build` and ensure the Next.js standalone application compiles cleanly.
3. **Automated Tests**:
   - Run the TypeScript integration tests:
     ```bash
     npx --yes tsx --test tests/phase01-auth.test.ts tests/phase02-sync.test.ts tests/phase03-storage-buffer.test.ts tests/phase06-pwa-landing.test.ts tests/phase07-deployment.test.ts
     ```
   - Run the Python SDK tests if modifying SDK code:
     ```bash
     python3 -m unittest tests/phase05_sdk_test.py
     ```
4. **Documentation**:
   - If adding or changing features, update the relevant files in `docs/users/` or `docs/dev/`.
   - Update `docs/MANIFEST.md` if new documentation files were introduced.
5. **Memory Synchronization**: Ensure `MEMORY.md` reflects all changes made during your session.
