# Streaming Data Export (`/vcon/export`)

The DataStack Export Workspace (`/vcon/export`) allows operators, data scientists, and business analysts to extract collected telemetry data into standardized CSV or JSON formats.

---

## 1. Streaming Architecture

Traditional analytics exports often fail when datasets grow large, triggering Out-Of-Memory (OOM) crashes on the server. DataStack uses **Streaming HTTP Responses**:

- **Zero-RAM Buffering**: Partition files are opened as read streams (`fs.createReadStream`) and piped directly through Node.js transform streams into the response socket.
- **Constant Memory Footprint**: Exporting 50 megabytes or 50 gigabytes consumes the same nominal RAM footprint (~15 MB) on the server.
- **Client Backpressure**: If the downloading client or network connection is slow, reading from disk pauses automatically to avoid memory saturation.

---

## 2. Export Configuration & Options

The export workspace provides targeted filtering:

| Option | Values | Description |
| :--- | :--- | :--- |
| **Client Filter** | `All Clients` or specific `clientId` | Filter by an individual registered application (e.g., `pos_terminal_01`) or export across the entire tenant. |
| **Start Date** | Date Picker (`YYYY-MM-DD`) | Earliest UTC date to include in the exported records. |
| **End Date** | Date Picker (`YYYY-MM-DD`) | Latest UTC date to include in the exported records. |
| **Format** | `CSV` or `JSON` | Output format for the downloaded file. |

---

## 3. Supported Formats & Tool Compatibility

### CSV Format (`text/csv`)
- **UTF-8 Byte Order Mark (BOM)**: DataStack prepends the `\uFEFF` marker to ensure Microsoft Excel correctly recognizes special characters and UTF-8 encodings when opened by double-clicking.
- **RFC 4180 Escaping**: Embedded JSON payloads are escaped according to standard CSV rules.

#### Importing CSV into Python (pandas)
```python
import pandas as pd
import json

# Load exported CSV
df = pd.read_csv("datastack_export_pos_terminal_01.csv")

# Parse JSON payloads into a structured DataFrame
df["parsed_payload"] = df["payload"].apply(json.loads)
print(df.head())
```

#### Importing CSV into DuckDB
```sql
-- Query directly from the exported CSV without importing
SELECT 
    clientId, 
    timestamp, 
    json_extract_string(payload, '$.temperature') AS temperature
FROM read_csv_auto('datastack_export.csv')
WHERE temperature > 25.0;
```

### JSON Format (`application/json`)
- Streams a valid JSON array (`[ ... ]`) of parsed event objects.
- Each event includes `clientId`, `eventId`, `timestamp`, and the native parsed JSON `payload` object.

---

## 4. Programmatic Export via API

You can automate data pipeline extraction via `curl` or cron scripts using your administrator session cookie:

```bash
curl -X GET "https://your-domain.example/api/export?clientId=pos_terminal_01&from=2026-11-01&to=2026-11-17&format=csv" \
     -H "Cookie: datastack_admin_session=YOUR_SESSION_COOKIE" \
     --output export.csv
```
