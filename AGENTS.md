# AGENTS.md — Component-Only Architecture Rules & System Directives

## 1. Single Source of Truth Components

- All UI design styles are designed once as reusable components in `components/ui/` and `components/layout/`.
- Pages must never implement isolated, inline styles or custom ad-hoc styling blocks.
- Spacing, colors, fonts, borders, buttons, cards, modals, and tables are defined centrally. Any design token alteration automatically cascades across all pages.

## 2. Decoupled Runtime Split

- **Port 3000**: Next.js App Router (Frontend UI, `/vcon/*` admin console, streaming CSV export `/api/export`).
- **Port 4000**: Express.js + Socket.IO process (WebSocket handshake, JWT verification, real-time ingestion).
- **Socket.IO Rule**: Socket.IO must never reside inside Next.js serverless route handlers.

## 3. Data Storage Rules

- **Collected Realtime Data**: Strictly stored in rotated CSV files at `/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
- **Zero Database Inserts**: Per-row DB inserts are prohibited for collected data streams.
- **File Rotation**: Rotates daily or upon reaching 100MB (`-part2.csv`).
- **Redis / In-Memory Buffer**: Aggregates batches (500 events or 2000ms timer) before flushing to disk.
- **PostgreSQL / Prisma**: Exclusively dedicated to metadata, SDK registrations, and admin settings.

## 4. Design & Typography Tokens

- **Font Stack**: `"Segoe UI", "Segoe UI Web", system-ui, -apple-system, "Helvetica Neue", sans-serif`.
- **Border Radius**: `--radius: 0rem` strictly across all shadcn and custom UI components.
- **Shadows**: None. Clean, soft, compact flat design with subtle 1px borders.

## 5. Private Development Notes

- The root `notes/` directory is local-only and must remain ignored by Git.
- `notes/` is exclusively for private development-time notes, plans, reports, and update/fix phase logs. Never put public-facing or publishable documentation, Markdown, or public information in this directory.
- Before starting any repository update, fix, or addition, record its report and plan in `notes/` first. Keep the relevant steps and phase status/logs updated there as work progresses.

## 6. Phase Implementation & Fast Single-Pass Verification Rules

- **Strict Scope Lock**: Every phase must only touch the files and targets locked in its phase specification. Never modify unrelated features or UI outside the active phase scope.
- **No Long Verification Loops**: Once a phase's code changes are applied, perform a single verification pass (`compile_applet` + `lint_applet`), update the `notes/` phase logs immediately, close the phase, and prepare for the next phase.
- **Zero Redundant Testing Loops**: Never run repetitive or unnecessary multi-round verification/test loops within the same phase. Implement the scoped patch cleanly, verify once, and close the phase directly.

