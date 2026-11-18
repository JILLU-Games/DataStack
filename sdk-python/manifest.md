# Python SDK Manifest (`datastack-sdk`)

## Purpose
Pip-installable Python client SDK compatibility alias (`datastack-sdk`), providing full backward compatibility for applications importing from `datastack_sdk` while sharing a single source of truth with the canonical `datastack` package (`sdk/python/datastack/`).

## Contents
- `setup.py`: Package distribution metadata and dependencies (`python-socketio[client]`, `requests`, `websocket-client`).
- `datastack_sdk/`:
  - `__init__.py`: Package entry point re-exporting all canonical symbols (`DataStack`, `DataStackClient`, `DataStackConfig`, exceptions, `HeartbeatMonitor`, `DiskSpooler`).
  - `client.py`: Re-export shim for `DataStack` / `DataStackClient`.
  - `config.py`: Re-export shim for `load_config` and `DataStackConfig`.
  - `exceptions.py`: Re-export shim for the full exception hierarchy.
  - `heartbeat.py`: Re-export shim for `ConnectionState` and `HeartbeatMonitor`.
  - `spool.py`: Re-export shim for `DiskSpooler`.
- `README.md`: Installation instructions, quickstart guide, API reference, and cross-references to the canonical documentation suite.

## Canonical Documentation
Full technical documentation (API reference, configuration, examples, error handling, and lifecycle) is maintained at:
`sdk/python/datastack/docs/`
