# Lifecycle, Resilience & Offline Spooling

This document explains the internal connection state machine, the zero-CPU Heartbeat Monitor, and the thread-safe offline disk spooler powering the DataStack Python SDK.

---

## 1. Connection State Machine (`ConnectionState`)

The client transitions automatically through five lifecycle states:

```text
 ┌────────────────┐         WebSocket Drop          ┌────────────────┐
 │ CONNECTED_IDLE ├────────────────────────────────►│ FALLBACK_HTTP  │
 │ (Heartbeat     │◄────────────────────────────────┤ (Heartbeat     │
 │  IDLE Mode)    │       Reconnected & Verified    │  ACTIVE_REC)   │
 └───────┬────────┘        (via ping_verify)        └───────┬────────┘
         │                                                  │ Both WS & HTTP
         │                                                  │ Unreachable
         │                                                  ▼
         │                                          ┌────────────────┐
         │                                          │ OFFLINE_SPOOL  │
         │                                          │ (Local Disk    │
         │                                          │  spool.jsonl)  │
         │                                          └───────┬────────┘
         │                                                  │
         │            client.disconnect() or                │ Network Returns
         │            Fatal Auth Revocation                 │
         ▼                                                  ▼
 ┌────────────────┐                                 ┌────────────────┐
 │    STOPPED     │◄────────────────────────────────┤  RECONNECTING_ │
 │                │                                 │     VERIFY     │
 └────────────────┘                                 └────────────────┘
```

### State Details

| State | Transport Used | Heartbeat Mode | Description |
| :--- | :--- | :--- | :--- |
| **`CONNECTED_IDLE`** | WebSocket (Port 4000) | `IDLE` (0% CPU) | Primary WebSocket connection is active and verified. The Heartbeat thread sleeps, consuming zero network or CPU resources. |
| **`FALLBACK_HTTP`** | HTTP REST (Port 3000) | `ACTIVE_RECOVERY` | WebSocket connection dropped. Outgoing events automatically route via HTTP `POST /api/events`. The Heartbeat thread wakes up and probes WebSocket reconnection in the background. |
| **`OFFLINE_SPOOL`** | Local Disk Queue | `ACTIVE_RECOVERY` | The client device has lost internet connectivity completely. Telemetry events are appended to `.datastack_spool/spool.jsonl`. |
| **`RECONNECTING_VERIFY`** | WebSocket | `ACTIVE_RECOVERY` | Reconnection handshake in progress. The client issues a `ping_verify` emission and replays spooled disk batches. |
| **`STOPPED`** | None | `STOPPED` | Client was closed via `disconnect()` or credentials were permanently revoked (`401`/`403`). All background threads terminate. |

---

## 2. Zero-CPU Heartbeat Monitor (`HeartbeatMonitor`)

Traditional SDKs constantly emit polling pings even when connections are healthy, wasting bandwidth and battery. DataStack implements an **Event-Driven Sleep Architecture**:

1. **When Healthy**: Once `connect()` succeeds and passes `ping_verify`, the monitor clears its internal wake event (`_wake_event.clear()`). The background thread remains completely idle.
2. **On Disconnect**: The Socket.IO `disconnect` event or an HTTP delivery trigger wakes the thread (`_wake_event.set()`).
3. **Background Reconnection**: Every `HEARTBEAT_INTERVAL_SEC` (default: 5.0s), the monitor attempts to reconnect and verify the WebSocket.
4. **Return to Idle**: Once verified, the thread drains any offline spooled events and immediately returns to sleep.

---

## 3. Offline Disk Spooling (`DiskSpooler`)

When edge devices, field laptops, or factory floor terminals lose internet connectivity:

### Storage Mechanics
- Events are appended to `.datastack_spool/spool.jsonl` using UTF-8 JSON lines.
- Each event preserves its deterministic `eventId`, `timestamp`, and `clientId`.
- Disk capacity is protected by `MAX_SPOOL_SIZE_MB` (default: 50 MB).

### Atomic Drain & Crash Recovery
- When connectivity returns, the Heartbeat Monitor reads spooled records in batches of `BATCH_CHUNK_SIZE` (default: 250).
- Batches are emitted to the server.
- The spool file is trimmed atomically using `ack_and_requeue_front()` and `os.replace()`, guaranteeing that if the process crashes mid-stream, unacknowledged records remain at the head of the file without duplication or data loss.

---

## 4. Resource Disposal & Cleanup

Always disconnect the client when your application shuts down to avoid dangling threads:

```python
client = DataStack()
try:
    client.send({"metric": "active"})
finally:
    client.disconnect()
```

Or use the context manager:
```python
with DataStack() as client:
    client.send({"metric": "active"})
```
