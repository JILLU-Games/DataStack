# Dependencies Inventory & Rationales

This document audits all runtime dependencies, development tools, and client libraries used in DataStack, providing version numbers, licenses, and architectural rationales.

---

## 1. Node.js Production Dependencies

| Package | Version | License | Architectural Rationale |
| :--- | :--- | :--- | :--- |
| `next` | `^15.4.9` | MIT | App Router frontend framework, SSR rendering, Edge middleware, and standalone container packaging. |
| `react` | `^19.2.1` | MIT | Core UI component engine. |
| `react-dom` | `^19.2.1` | MIT | DOM rendering for React 19. |
| `express` | `^5.3.0` | MIT | High-performance, lightweight HTTP listener powering the dedicated Port 4000 ingestion server and `/internal/*` service bridge. |
| `socket.io` | `^4.8.4` | MIT | Real-time WebSocket server engine with automatic reconnection, heartbeat pings, and room/client management. |
| `socket.io-client`| `^4.8.4` | MIT | Client library for in-browser simulation (`/vcon/simulator`) and automated integration tests. |
| `pg` | `^8.23.1` | MIT | Robust PostgreSQL connection pool (`pg.Pool`) used strictly for control-plane metadata persistence. |
| `ioredis` | `^6.0.0` | MIT | High-speed Redis client supporting list buffering (`RPUSH`/`LPOP`), atomic trimming, and distributed flush locks (`SET NX PX`). |
| `jsonwebtoken` | `^9.0.3` | MIT | Fast HMAC-SHA256 signing and verification for SDK client authentication tokens. |
| `json2csv` | `^6.0.0-alpha.2` | MIT | High-performance transform streams for non-blocking CSV dataset extraction in `/api/export`. |
| `csv-parse` | `^7.0.3` | MIT | Stream-based parser for structured file ingestion and test verification. |
| `cors` | `^2.8.6` | MIT | Cross-origin resource sharing middleware for HTTP ingestion APIs. |
| `lucide-react` | `^0.553.0` | ISC | Clean, consistent SVG icon set across all UI components. |
| `motion` | `^12.23.24` | MIT | Smooth, declarative animations for dashboard counters, page transitions, and status badges. |
| `clsx` & `tailwind-merge` | `^2.1.1` / `^3.3.1` | MIT | Utility functions for conditional class concatenation and Tailwind utility conflict resolution (`cn()`). |
| `class-variance-authority`| `^0.7.1` | Apache-2.0 | Type-safe variant styling for UI primitives (`Button`, `Badge`, `Panel`). |
| `@hookform/resolvers` | `^5.2.1` | MIT | Form validation resolver support. |
| `@google/genai` | `^2.4.0` | Apache-2.0 | Google GenAI TypeScript SDK. |

---

## 2. Development & Tooling Dependencies

| Package | Version | License | Architectural Rationale |
| :--- | :--- | :--- | :--- |
| `typescript` | `^5` | Apache-2.0 | Static typing and compile-time contract enforcement across all source files. |
| `tsx` | `^4.21.0` | MIT | Native Node.js TypeScript runner used to execute integration test suites directly (`npx tsx --test`). |
| `@tailwindcss/postcss` | `4.1.11` | MIT | Next-generation Tailwind CSS v4 compiler. |
| `@tailwindcss/typography` | `^0.5.19` | MIT | Typography utility classes for documentation and markdown rendering. |
| `eslint` & `eslint-config-next` | `^9` / `^15.4.9` | MIT | Code quality analysis and style enforcement. |
| `@types/*` | Various | MIT | High-fidelity TypeScript definitions for Node, React, Express, PG, and JWT. |

---

## 3. Python SDK Dependencies (`sdk/python/datastack/`)

| Package | Version | License | Architectural Rationale |
| :--- | :--- | :--- | :--- |
| `python-socketio[client]` | `>=5.11.0` | MIT | WebSocket transport enabling real-time streaming with automatic reconnection. |
| `requests` | `>=2.31.0` | Apache-2.0 | Reliable HTTP transport for REST ingestion fallback and export downloads. |
| `urllib3` | `>=2.0.0` | MIT | Connection pooling and retry logic for network resiliency. |
