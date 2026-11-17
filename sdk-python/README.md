# DataStack Python SDK (`datastack-sdk`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![Python 3.8+](https://img.shields.io/badge/Python-3.8%2B-3776AB)](https://www.python.org/)
[![Maintained by Vib Tools](https://img.shields.io/badge/Maintained%20by-Vib%20Tools-0f172a)](https://vib.tools/)

Official Python client library for **DataStack — Self-Hosted Real-Time Telemetry & Event Logging Platform**, developed by **[Vib Tools](https://vib.tools/)**.

`datastack-sdk` enables Python services, IoT sensor nodes, microservice workers, and research pipelines to stream structured JSON telemetry events to a DataStack server over Socket.IO with deterministic `threading.Event` acknowledgments.

---

## Installation

Install directly from the `sdk-python` directory:

```bash
pip install ./sdk-python
```

For editable development mode:

```bash
cd sdk-python && pip install -e .
```

---

## Quick Start

```python
from datastack_sdk import DataStackClient

# 1. Initialize the client with a signed JWT token from /vcon/clients or /vcon/sdk
client = DataStackClient(
    server_url="http://localhost:4000",
    token="YOUR_CLIENT_JWT_TOKEN",
)

# 2. Connect to the DataStack Socket.IO server
if client.connect():
    # 3. Stream a single structured event and wait for server acknowledgment
    res = client.sync(
        data={
            "event_type": "service_heartbeat",
            "service": "billing-worker",
            "latency_ms": 18.4,
            "status": "healthy",
        },
        timeout=5.0,
    )
    print("Sync result:", res)

    # 4. Stream a batch of events in a single round-trip
    batch_res = client.batch_sync(
        records=[
            {"metric": "cpu_load", "value": 42.1, "unit": "%"},
            {"metric": "mem_usage", "value": 68.5, "unit": "%"},
            {"metric": "disk_free_gb", "value": 124.0, "unit": "GB"},
        ],
        timeout=10.0,
    )
    print("Batch result:", batch_res)

    # 5. Disconnect cleanly
    client.disconnect()
```

---

## API Reference

### `DataStackClient(server_url="http://localhost:4000", token="", reconnection_attempts=5, reconnection_delay=1)`
Creates a new Socket.IO client instance configured for DataStack handshake authentication.

### `client.connect(wait_timeout=5) -> bool`
Establishes a WebSocket/Socket.IO connection to the DataStack Port 4000 ingestion server using `auth={"token": self.token}`. Returns `True` on success or `False` on connection failure.

### `client.sync(data, event_id=None, timeout=5.0) -> dict`
Emits a single event (`sync_data`) and blocks via `threading.Event.wait(timeout)` until the server responds.
- **Returns**: `{"success": True, "eventId": "evt_..."}` or `{"success": False, "eventId": "evt_...", "error": "..."}`.

### `client.batch_sync(records, timeout=10.0) -> dict`
Emits a list of event dictionaries (`batch_sync`) and blocks via `threading.Event.wait(timeout)` until the server acknowledges the batch.
- **Returns**: `{"success": True, "processed": N, "rejected": M}`.

### `client.disconnect()`
Cleanly closes the active Socket.IO connection.

---

## Author & Support

Developed and maintained by **[Vib Tools](https://vib.tools/)**:
- **Website**: [https://vib.tools/](https://vib.tools/)
- **GitHub**: [https://github.com/vibtoolshq](https://github.com/vibtoolshq)
- **General Email**: [hello@vibtools.io](mailto:hello@vibtools.io)
- **Technical Support**: [support@vibtools.io](mailto:support@vibtools.io)

## License

Released under the [MIT License](../LICENSE).
