# Contributing to DataStack

Thank you for your interest in contributing to **DataStack**, an open-source, self-hosted real-time telemetry and event logging platform developed by **[Vib Tools](https://vib.tools/)**.

We welcome bug reports, documentation improvements, and focused code contributions that align with the project's architecture and engineering standards.

---

## 1. Core Architectural Rules

Before submitting a pull request, please review [`AGENTS.md`](./AGENTS.md) and ensure your changes respect these core boundaries:

1. **Single-Source-of-Truth UI Components (`components/ui/` & `components/layout/`)**
   - All `/vcon/*` and public views assemble shared primitives (`PageShell`, `AdminPageHeader`, `SettingsPanel`, `Panel`, `StatStrip`, `Table`, `Button`, `Input`, `Modal`).
   - Do not introduce isolated inline styles or non-zero border-radius/shadow overrides (`--radius: 0rem`, `--shadow: none`).
2. **Decoupled Dual-Runtime Architecture**
   - **Port 3000 (`web`)**: Next.js 15 App Router serving the UI, `/vcon/*` administration console, `POST /api/events`, and `GET /api/export`.
   - **Port 4000 (`ingestion`)**: Express + Socket.IO server (`server/index.js`) handling WebSocket handshakes, rate limits, idempotency, and batch CSV flushing.
   - Never embed Socket.IO server handlers inside Next.js serverless routes.
3. **Storage & Database Separation**
   - Collected telemetry and event payloads are written exclusively in batches to partitioned CSV files under `/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
   - PostgreSQL (`pg`) is used strictly for administrator accounts (`admin_users`), login lockout tracking (`admin_login_attempts`), registered SDK clients (`client_sdks`), and platform settings (`admin_settings`).

---

## 2. Local Development Workflow

1. **Fork & Clone the Repository**
   ```bash
   git clone https://github.com/vibtoolshq/datastack.git
   cd datastack
   npm install
   ```
2. **Create a Feature or Fix Branch**
   ```bash
   git checkout -b fix/short-description
   ```
3. **Run the Development Services**
   ```bash
   # Terminal 1: Next.js Web UI & Admin Console (Port 3000)
   npm run dev

   # Terminal 2: Socket.IO Ingestion Service (Port 4000)
   npm run server
   ```
4. **Verify Build & Lint Checks**
   ```bash
   npm run lint
   npm run build
   ```

---

## 3. Pull Request Checklist

- [ ] Changes are focused on a single bug fix, improvement, or documented feature.
- [ ] `npm run lint` and `npm run build` pass with zero errors.
- [ ] Documentation (`README.md` or relevant `manifest.md`) is updated if behavior or configuration changed.
- [ ] No runtime CSV files (`storage/data/*`) or private environment secrets (`.env`) are committed.

---

## 4. Contact & Support

- **General Inquiries**: [hello@vibtools.io](mailto:hello@vibtools.io)
- **Technical & Product Support**: [support@vibtools.io](mailto:support@vibtools.io)
- **GitHub Organization**: [https://github.com/vibtoolshq](https://github.com/vibtoolshq)
- **Website**: [https://vib.tools/](https://vib.tools/)
