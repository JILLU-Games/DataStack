import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { MCP_PERMISSION_DEFINITIONS } from "../core/mcp/mcpSettings";
import { DataBufferEngine } from "../core/data/buffer";
import {
  applyCategoryPermissionToggle,
  applyMcpPermissionPreset,
  buildMcpClientConfigSnippet,
  buildMcpEndpointUrl,
  buildMcpSavePayload,
  countEnabledMcpPermissions,
  DEFAULT_PUBLIC_MCP_SETTINGS,
  describeMcpBridgeSync,
  groupMcpPermissionsByCategory,
  isMcpDraftDirty,
  MCP_CLIENT_TARGETS,
  type McpDraftState,
  type McpPermissionDefinitionView,
  type PublicMcpSettingsView,
} from "../lib/mcpUiHelpers";

const DEFINITIONS = MCP_PERMISSION_DEFINITIONS as readonly McpPermissionDefinitionView[];

test.after(async () => {
  await DataBufferEngine.shutdown();
});

test("R5-Phase-03 [lib/mcpUiHelpers.ts]: URL builder, AI client JSON snippets, permission grouping/presets, bridge status, and diff payload", () => {
  // 1. Endpoint URL builder
  assert.equal(
    buildMcpEndpointUrl("https://datastack.example.com/", "/mcp"),
    "https://datastack.example.com/mcp",
  );
  assert.equal(buildMcpEndpointUrl("", "mcp"), "/mcp");

  // 2. Client config snippets (4 targets, valid JSON, token vs placeholder)
  assert.equal(MCP_CLIENT_TARGETS.length, 4);
  for (const target of MCP_CLIENT_TARGETS) {
    const rawPlaceholder = buildMcpClientConfigSnippet(target.id, {
      endpointUrl: "https://telemetry.example.com/mcp",
    });
    const parsedPlaceholder = JSON.parse(rawPlaceholder) as Record<string, unknown>;
    assert.ok(parsedPlaceholder);
    assert.match(rawPlaceholder, /Bearer YOUR_MCP_BEARER_TOKEN/);

    const rawToken = buildMcpClientConfigSnippet(target.id, {
      endpointUrl: "https://telemetry.example.com/mcp",
      token: "dsmcp_1234567890abcdef",
    });
    const parsedToken = JSON.parse(rawToken) as Record<string, unknown>;
    assert.ok(parsedToken);
    assert.match(rawToken, /Bearer dsmcp_1234567890abcdef/);

    if (target.id === "vscode") {
      const servers = parsedToken.servers as Record<string, { type: string; url: string }>;
      assert.equal(servers.datastack.type, "http");
      assert.equal(servers.datastack.url, "https://telemetry.example.com/mcp");
    } else if (target.id === "windsurf") {
      const servers = parsedToken.mcpServers as Record<string, { serverUrl: string }>;
      assert.equal(servers.datastack.serverUrl, "https://telemetry.example.com/mcp");
    } else {
      const servers = parsedToken.mcpServers as Record<string, { url: string }>;
      assert.equal(servers.datastack.url, "https://telemetry.example.com/mcp");
    }
  }

  // 3. Permission grouping across all 17 definitions & 4 categories
  const defaultPerms = applyMcpPermissionPreset({}, DEFINITIONS, "defaults");
  const groups = groupMcpPermissionsByCategory(DEFINITIONS, defaultPerms);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.map((g) => [g.category, g.totalCount]),
    [
      ["Observability & Logs", 5],
      ["Clients & SDKs", 4],
      ["Files & Storage", 5],
      ["Admin & Maintenance", 3],
    ],
  );
  const defaultCounts = countEnabledMcpPermissions(defaultPerms, DEFINITIONS);
  assert.equal(defaultCounts.total, 17);
  assert.equal(defaultCounts.enabled, 9);

  // 4. Presets & category toggle
  const readOnlyPerms = applyMcpPermissionPreset(defaultPerms, DEFINITIONS, "read_only");
  assert.equal(readOnlyPerms.clients_create, false);
  assert.equal(readOnlyPerms.files_delete, false);
  assert.equal(readOnlyPerms.metrics_health_read, true);
  assert.equal(readOnlyPerms.files_download, true);

  const clientEnabled = applyCategoryPermissionToggle(
    readOnlyPerms,
    DEFINITIONS,
    "Clients & SDKs",
    true,
  );
  assert.equal(clientEnabled.clients_create, true);
  assert.equal(clientEnabled.clients_update, true);
  assert.equal(clientEnabled.clients_revoke_delete, true);
  assert.equal(clientEnabled.files_delete, false);

  const allOff = applyMcpPermissionPreset(clientEnabled, DEFINITIONS, "all_off");
  assert.equal(countEnabledMcpPermissions(allOff, DEFINITIONS).enabled, 0);

  // 5. Bridge sync summaries
  assert.equal(describeMcpBridgeSync(null).level, "idle");
  assert.equal(describeMcpBridgeSync({ attempted: true, ok: true, synced: true }).level, "success");
  assert.equal(
    describeMcpBridgeSync({ attempted: true, ok: false, status: 401 }).level,
    "error",
  );
  assert.equal(
    describeMcpBridgeSync({ attempted: true, ok: false, error: "ECONNREFUSED" }).level,
    "warning",
  );

  // 6. Save payload diffing
  const saved: PublicMcpSettingsView = {
    ...DEFAULT_PUBLIC_MCP_SETTINGS,
    enabled: false,
    allowedIps: "127.0.0.1",
    permissions: { ...defaultPerms },
    coolifyUrl: "",
    hasCoolifyToken: true,
    coolifyTokenMask: "••••1234",
    coolifyAppUuid: "app-1",
  };
  const cleanDraft: McpDraftState = {
    enabled: false,
    allowedIps: "127.0.0.1",
    permissions: { ...defaultPerms },
    coolifyUrl: "",
    coolifyTokenInput: "",
    clearCoolifyToken: false,
    coolifyAppUuid: "app-1",
  };
  assert.equal(isMcpDraftDirty(cleanDraft, saved, DEFINITIONS), false);
  assert.deepEqual(buildMcpSavePayload(cleanDraft, saved, DEFINITIONS), {});

  const editedDraft: McpDraftState = {
    ...cleanDraft,
    enabled: true,
    permissions: { ...defaultPerms, clients_create: true },
    clearCoolifyToken: true,
  };
  assert.equal(isMcpDraftDirty(editedDraft, saved, DEFINITIONS), true);
  assert.deepEqual(buildMcpSavePayload(editedDraft, saved, DEFINITIONS), {
    enabled: true,
    permissions: { clients_create: true },
    clearCoolifyToken: true,
  });
});

test("R5-Phase-03 [Routes, Sidebar, Navbar & UI Architecture]: /vcon/mcp, McpWorkspace, Sidebar, and Navbar comply with project single-source-of-truth & security rules", () => {
  const pagePath = path.resolve(process.cwd(), "app/vcon/mcp/page.tsx");
  assert.equal(existsSync(pagePath), true);
  const pageSrc = readFileSync(pagePath, "utf8");
  assert.match(pageSrc, /McpWorkspace/);

  const sidebarSrc = readFileSync(
    path.resolve(process.cwd(), "components/layout/Sidebar.tsx"),
    "utf8",
  );
  assert.match(sidebarSrc, /name:\s*['"]MCP Server['"]/);
  assert.match(sidebarSrc, /href:\s*['"]\/vcon\/mcp['"]/);

  const navbarSrc = readFileSync(
    path.resolve(process.cwd(), "components/layout/Navbar.tsx"),
    "utf8",
  );
  assert.match(navbarSrc, /['"]\/vcon\/mcp['"]:\s*['"]MCP Server['"]/);

  const workspaceSrc = readFileSync(
    path.resolve(process.cwd(), "components/sections/McpWorkspace.tsx"),
    "utf8",
  );
  // Uses shared single-source-of-truth UI primitives
  for (const symbol of [
    "PageShell",
    "StatStrip",
    "SettingsTabs",
    "SettingsPanel",
    "SettingsGroup",
    "SettingsField",
    "SettingsFooter",
    "Panel",
    "Button",
    "Input",
    "FormSwitch",
    "CodeBlock",
    "Modal",
  ]) {
    assert.ok(workspaceSrc.includes(symbol), `Expected ${symbol} inside McpWorkspace.tsx`);
  }

  // Enforces Owner RBAC guard without caching raw issuedToken to localStorage/vconCache
  assert.match(workspaceSrc, /isOwner/);
  assert.match(workspaceSrc, /mcp-non-owner-banner/);
  assert.match(workspaceSrc, /mcp-issued-token-banner/);
  assert.equal(/localStorage/.test(workspaceSrc), false);
  assert.equal(/setCached\([^)]*issuedToken/.test(workspaceSrc), false);
  assert.equal(/\brounded-/.test(workspaceSrc), false);
  assert.equal(/\bshadow-/.test(workspaceSrc), false);
});
