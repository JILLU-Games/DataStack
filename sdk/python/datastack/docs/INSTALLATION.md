# Installation & Environment Setup

This guide details installation options, supported runtimes, package requirements, and environment verification for the DataStack Python SDK.

---

## 1. Supported Environments & Runtime Requirements

- **Python Version**: `>= 3.8` (Tested on Python `3.8`, `3.9`, `3.10`, `3.11`, and `3.12`).
- **Operating Systems**: Linux, macOS, Windows (OS-independent).
- **Network Access**:
  - Ingestion WebSocket: `Port 4000` (or reverse proxy `/socket.io/`).
  - HTTP REST API & Fallback: `Port 3000` (or reverse proxy `/api/*`).

---

## 2. Package Installation

### Option A: From PyPI
```bash
pip install datastack
```

### Option B: From Local Repository Directory
Install directly from the root of the repository:
```bash
pip install ./sdk/python/datastack
```

### Option C: Editable Development Mode
Use this mode when contributing to or testing local modifications:
```bash
pip install -e ./sdk/python/datastack
```

### Option D: Compatibility Alias (`datastack-sdk`)
For existing codebases using the `datastack_sdk` namespace:
```bash
pip install datastack-sdk
# Or from local repository:
pip install ./sdk-python
```

Both `from datastack import DataStack` and `from datastack_sdk import DataStackClient` point to the identical underlying engine.

---

## 3. Dependencies

The SDK specifies the following dependencies in `pyproject.toml` and `setup.py`:

| Dependency | Minimum Version | Purpose |
| :--- | :--- | :--- |
| `python-socketio[client]` | `>= 5.8.0` | High-performance Socket.IO client for WebSocket communication. |
| `requests` | `>= 2.28.0` | Robust HTTP transport for REST ingestion and automatic fallback. |
| `websocket-client` | `>= 1.5.0` | Low-level WebSocket transport engine for Python Socket.IO. |

> **Minimal Environments**: If `requests` is absent in a stripped-down embedded container, the SDK automatically falls back to Python's built-in `urllib.request` standard library.

---

## 4. Verifying Installation

Verify that the package is correctly installed and accessible in your environment:

```bash
python3 -c "import datastack; print('DataStack SDK Version:', datastack.__version__)"
```

Expected output:
```text
DataStack SDK Version: 2.2.0
```
