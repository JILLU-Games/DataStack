# AGENTS.md — Architecture Rules & Engineering Conventions

## 1. Single Source of Truth UI Components

- All reusable UI primitives and layout shells are maintained in `components/ui/` and `components/layout/`.
- Pages assemble shared components (`PageShell`, `AdminPageHeader`, `SettingsPanel`, `Panel`, `StatStrip`, `Table`, `Button`, `Input`, `Modal`) rather than introducing isolated ad-hoc styling.
- Typography, spacing, colors, and borders use centralized CSS variables in `app/globals.css`.

## 2. Decoupled Runtime Architecture

- **Port 3000 (`web`)**: Next.js 15 App Router serving the public overview, `/vcon/*` administration console, authenticated HTTP ingestion (`POST /api/events`), and streaming CSV/JSON exports (`GET /api/export`).
- **Port 4000 (`ingestion`)**: Dedicated Express.js + Socket.IO service (`server/index.js`) handling WebSocket handshakes, client JWT authentication, rate limiting, idempotency deduplication, and batch CSV persistence.
- **Socket.IO Boundary**: Socket.IO connections are handled exclusively by the Port 4000 service and never inside Next.js serverless route handlers.

## 3. Data Storage & Persistence Rules

- **Partitioned CSV Event Storage**: Collected events are buffered in memory and flushed in batches to `/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
- **Zero Per-Row Database Inserts**: Event telemetry streams are never inserted per-row into PostgreSQL.
- **File Rotation & Pruning**: CSV files rotate daily or when reaching the configured size threshold (`fileRotationMb`, default `100MB`, creating `-part2.csv`), and expired partitions are pruned according to `autoPruneDays`.
- **PostgreSQL Metadata Store (`pg`)**: PostgreSQL is used strictly for administrator accounts (`admin_users`), login attempt tracking (`admin_login_attempts`), registered SDK client credentials (`client_sdks`), and platform configuration (`admin_settings`).

## 4. Design & Typography Tokens

- **Font Stack**: `"Segoe UI", "Segoe UI Web", system-ui, -apple-system, "Helvetica Neue", sans-serif`.
- **Border Radius**: `--radius: 0rem` across all UI components.
- **Shadows**: None (`--shadow: none`). Crisp 1px borders with dark and light theme support.
