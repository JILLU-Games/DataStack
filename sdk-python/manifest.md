# Python SDK Manifest

## Purpose
Pip-installable Python client SDK (`datastack-sdk`) enabling Python services, IoT telemetry agents, and analytics applications to stream structured real-time events to DataStack.

## Contents
- `setup.py`: Package metadata and dependencies (`python-socketio[client]`, `requests`).
- `datastack_sdk/__init__.py`: Exports `DataStackClient`.
- `datastack_sdk/client.py`: `DataStackClient` implementation featuring JWT handshake authentication, automatic reconnection, and thread-safe acknowledgment waiting (`threading.Event`) for `sync()` and `batch_sync()`.
- `README.md`: Installation instructions, quickstart example, and API reference.
