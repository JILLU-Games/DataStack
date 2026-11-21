export type McpPermissionCategory =
  | 'Observability & Logs'
  | 'Clients & SDKs'
  | 'Files & Storage'
  | 'Admin & Maintenance';

export type McpPermissionRisk = 'read' | 'write' | 'destructive';

export interface McpPermissionDefinitionView {
  key: string;
  label: string;
  description: string;
  category: McpPermissionCategory;
  defaultEnabled: boolean;
  risk: McpPermissionRisk;
}

export interface PublicMcpSettingsView {
  enabled: boolean;
  hasToken: boolean;
  tokenPreview: string;
  allowedIps: string;
  permissions: Record<string, boolean>;
  coolifyUrl: string;
  hasCoolifyToken: boolean;
  coolifyTokenMask: string;
  coolifyAppUuid: string;
  endpointPath: string;
  updatedAt: string;
}

export interface McpBridgeSyncView {
  attempted?: boolean;
  ok?: boolean;
  synced?: boolean;
  status?: number;
  error?: string;
  checkedAt?: string;
}

export type McpClientTargetId = 'claude' | 'cursor' | 'vscode' | 'windsurf';

export interface McpClientTargetMeta {
  id: McpClientTargetId;
  label: string;
  configPath: string;
  transportLabel: string;
}

export const MCP_CLIENT_TARGETS: readonly McpClientTargetMeta[] = [
  {
    id: 'claude',
    label: 'Claude Desktop / Code',
    configPath: '~/.claude.json or claude_desktop_config.json',
    transportLabel: 'Streamable HTTP (type: "http")',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: '.cursor/mcp.json',
    transportLabel: 'Streamable HTTP (url + headers)',
  },
  {
    id: 'vscode',
    label: 'VS Code Copilot',
    configPath: '.vscode/mcp.json',
    transportLabel: 'VS Code MCP (servers + type: "http")',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    transportLabel: 'Windsurf MCP (serverUrl + headers)',
  },
] as const;

export const MCP_PERMISSION_CATEGORIES: readonly McpPermissionCategory[] = [
  'Observability & Logs',
  'Clients & SDKs',
  'Files & Storage',
  'Admin & Maintenance',
] as const;

export const DEFAULT_PUBLIC_MCP_SETTINGS: PublicMcpSettingsView = {
  enabled: false,
  hasToken: false,
  tokenPreview: '',
  allowedIps: '',
  permissions: {},
  coolifyUrl: '',
  hasCoolifyToken: false,
  coolifyTokenMask: '',
  coolifyAppUuid: '',
  endpointPath: '/mcp',
  updatedAt: '',
};

export function buildMcpEndpointUrl(
  origin: string,
  endpointPath: string = '/mcp',
): string {
  const cleanOrigin = String(origin || '').trim().replace(/\/+$/, '');
  const cleanPath = String(endpointPath || '/mcp').trim();
  const normalizedPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
  if (!cleanOrigin) return normalizedPath;
  return `${cleanOrigin}${normalizedPath}`;
}

export function buildMcpClientConfigSnippet(
  target: McpClientTargetId,
  options: {
    endpointUrl: string;
    token?: string;
  },
): string {
  const url = String(options.endpointUrl || 'http://localhost:3000/mcp').trim();
  const rawToken = String(options.token || '').trim();
  const authValue = `Bearer ${rawToken || 'YOUR_MCP_BEARER_TOKEN'}`;

  if (target === 'vscode') {
    return JSON.stringify(
      {
        servers: {
          datastack: {
            type: 'http',
            url,
            headers: {
              Authorization: authValue,
            },
          },
        },
      },
      null,
      2,
    );
  }

  if (target === 'cursor') {
    return JSON.stringify(
      {
        mcpServers: {
          datastack: {
            url,
            headers: {
              Authorization: authValue,
            },
          },
        },
      },
      null,
      2,
    );
  }

  if (target === 'windsurf') {
    return JSON.stringify(
      {
        mcpServers: {
          datastack: {
            serverUrl: url,
            headers: {
              Authorization: authValue,
            },
          },
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      mcpServers: {
        datastack: {
          type: 'http',
          url,
          headers: {
            Authorization: authValue,
          },
        },
      },
    },
    null,
    2,
  );
}

export interface GroupedMcpPermissions {
  category: McpPermissionCategory;
  items: McpPermissionDefinitionView[];
  enabledCount: number;
  totalCount: number;
}

export function groupMcpPermissionsByCategory(
  definitions: readonly McpPermissionDefinitionView[],
  permissions: Record<string, boolean>,
): GroupedMcpPermissions[] {
  const groups = new Map<McpPermissionCategory, McpPermissionDefinitionView[]>();
  for (const cat of MCP_PERMISSION_CATEGORIES) {
    groups.set(cat, []);
  }
  for (const def of definitions) {
    const bucket = groups.get(def.category) ?? [];
    bucket.push(def);
    groups.set(def.category, bucket);
  }

  const result: GroupedMcpPermissions[] = [];
  for (const cat of MCP_PERMISSION_CATEGORIES) {
    const items = groups.get(cat) ?? [];
    if (items.length === 0) continue;
    const enabledCount = items.filter((item) => Boolean(permissions[item.key])).length;
    result.push({
      category: cat,
      items,
      enabledCount,
      totalCount: items.length,
    });
  }
  return result;
}

export function countEnabledMcpPermissions(
  permissions: Record<string, boolean>,
  definitions: readonly McpPermissionDefinitionView[],
): { enabled: number; total: number } {
  const total = definitions.length;
  const enabled = definitions.filter((def) => Boolean(permissions[def.key])).length;
  return { enabled, total };
}

export function applyMcpPermissionPreset(
  permissions: Record<string, boolean>,
  definitions: readonly McpPermissionDefinitionView[],
  preset: 'read_only' | 'defaults' | 'all_off',
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...permissions };
  for (const def of definitions) {
    if (preset === 'read_only') {
      next[def.key] = def.risk === 'read';
    } else if (preset === 'defaults') {
      next[def.key] = def.defaultEnabled;
    } else {
      next[def.key] = false;
    }
  }
  return next;
}

export function applyCategoryPermissionToggle(
  permissions: Record<string, boolean>,
  definitions: readonly McpPermissionDefinitionView[],
  category: McpPermissionCategory,
  enabled: boolean,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...permissions };
  for (const def of definitions) {
    if (def.category === category) {
      next[def.key] = enabled;
    }
  }
  return next;
}

export function describeMcpBridgeSync(
  bridgeSync: McpBridgeSyncView | null | undefined,
): { level: 'idle' | 'success' | 'warning' | 'error'; title: string; detail?: string } {
  if (!bridgeSync) {
    return { level: 'idle', title: 'Pending verification' };
  }
  const attempted =
    bridgeSync.attempted !== undefined
      ? bridgeSync.attempted
      : typeof bridgeSync.synced === 'boolean';
  const ok =
    bridgeSync.ok !== undefined
      ? bridgeSync.ok
      : Boolean(bridgeSync.synced);

  if (!attempted) {
    return { level: 'idle', title: 'Sync skipped (standalone)' };
  }
  if (ok) {
    return { level: 'success', title: 'Synced (Port 4000)' };
  }
  if (bridgeSync.status === 401 || bridgeSync.status === 503) {
    return {
      level: 'error',
      title: 'Port 4000 bridge rejected MCP sync',
      detail:
        bridgeSync.error ||
        `HTTP ${bridgeSync.status}. Verify DATASTACK_INTERNAL_SECRET matches across runtimes.`,
    };
  }
  return {
    level: 'warning',
    title: 'Port 4000 MCP bridge unreachable',
    detail:
      bridgeSync.error ||
      'Saved to control-plane storage; Port 4000 will hydrate once online.',
  };
}

export interface McpDraftState {
  enabled: boolean;
  allowedIps: string;
  permissions: Record<string, boolean>;
  coolifyUrl: string;
  coolifyTokenInput: string;
  clearCoolifyToken: boolean;
  coolifyAppUuid: string;
}

export function buildMcpSavePayload(
  draft: McpDraftState,
  saved: PublicMcpSettingsView,
  definitions: readonly McpPermissionDefinitionView[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (draft.enabled !== saved.enabled) {
    payload.enabled = draft.enabled;
  }

  const trimmedIps = draft.allowedIps.trim();
  if (trimmedIps !== (saved.allowedIps || '').trim()) {
    payload.allowedIps = trimmedIps;
  }

  const permDelta: Record<string, boolean> = {};
  for (const def of definitions) {
    const nextVal = Boolean(draft.permissions[def.key]);
    const prevVal = Boolean(saved.permissions?.[def.key]);
    if (nextVal !== prevVal) {
      permDelta[def.key] = nextVal;
    }
  }
  if (Object.keys(permDelta).length > 0) {
    payload.permissions = permDelta;
  }

  const trimmedCoolifyUrl = draft.coolifyUrl.trim();
  if (trimmedCoolifyUrl !== (saved.coolifyUrl || '').trim()) {
    payload.coolifyUrl = trimmedCoolifyUrl;
  }

  const trimmedCoolifyUuid = draft.coolifyAppUuid.trim();
  if (trimmedCoolifyUuid !== (saved.coolifyAppUuid || '').trim()) {
    payload.coolifyAppUuid = trimmedCoolifyUuid;
  }

  if (draft.clearCoolifyToken && saved.hasCoolifyToken) {
    payload.clearCoolifyToken = true;
  } else if (draft.coolifyTokenInput.trim().length > 0) {
    payload.coolifyToken = draft.coolifyTokenInput.trim();
  }

  return payload;
}

export function isMcpDraftDirty(
  draft: McpDraftState,
  saved: PublicMcpSettingsView,
  definitions: readonly McpPermissionDefinitionView[],
): boolean {
  return Object.keys(buildMcpSavePayload(draft, saved, definitions)).length > 0;
}
