# DataStack User & Operator Guide

Welcome to the **DataStack User Documentation**. This guide is designed for operators, administrators, product teams, and engineers who wish to deploy, operate, and collect real-time telemetry using DataStack.

---

## What is DataStack?

**DataStack** is a self-hosted, lightweight telemetry and data collection platform. It enables your applications to stream events in real time, securely buffers them with Redis and in-memory batching, and persists them into clean, partitioned daily CSV files without overloading a relational database.

---

## Documentation Navigation

Explore the following sections to get up and running:

### 1. [Installation & Deployment](./installation.md)
Step-by-step instructions for deploying DataStack in production:
- Running with **Docker Compose**
- 1-Click deployment on **Coolify**
- Configuring environment variables & persistent volumes
- Reverse proxy and SSL configuration

### 2. [Feature Walkthrough](./features.md)
Comprehensive overview of all platform capabilities:
- **Admin Console (`/vcon/`)**: Dashboard overview, live activity preview, and storage monitors.
- **Client SDK Management**: Registering client applications, issuing JWT tokens, and instant revocation.
- **Data Simulator**: Interactive in-browser telemetry generation for testing without writing code.
- **Partitioned Storage**: Size-based file rotation and automatic daily retention pruning.
- **Streaming Export**: High-performance streaming of filtered CSV or JSON datasets.

### 3. [Usage Tutorials](./tutorials.md)
Hands-on walkthroughs for common tasks:
- Sending your first telemetry event via HTTP REST
- Streaming real-time events using the official Python SDK
- Streaming local `.csv`, `.json`, and `.jsonl` data files
- Exporting datasets for analysis in Excel, pandas, or DuckDB

### 4. [Frequently Asked Questions & Troubleshooting](./faq.md)
Answers to common operational questions:
- How does DataStack prevent data loss during container restarts?
- How to rotate client credentials safely without downtime
- What to do if WebSocket handshakes fail or time out
- How to adjust event rate limits and payload size thresholds

---

## Quick Reference Links
- [Developer & Contributor Guide](../dev/README.md)
- [Architecture Blueprint](../dev/architecture.md)
- [Documentation Index](../MANIFEST.md)
- [Official Website](https://vib.tools/)
