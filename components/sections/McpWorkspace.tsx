'use client';

import { PageShell } from '@/components/layout/PageShell';
import { useVconRole } from '@/components/layout/VconShell';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Panel } from '@/components/ui/Panel';
import {
  SettingsField,
  SettingsFooter,
  SettingsGroup,
  SettingsPanel,
  SettingsTabs,
} from '@/components/ui/SettingsLayout';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
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
  type McpBridgeSyncView,
  type McpClientTargetId,
  type McpDraftState,
  type McpPermissionDefinitionView,
  type PublicMcpSettingsView,
} from '@/lib/mcpUiHelpers';
import { getCached, setCached } from '@/lib/vconCache';
import { getVconRoleCapabilities } from '@/lib/vconUiHelpers';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MCP_TABS = [
  { id: 'connection', label: 'Connection & Token' },
  { id: 'permissions', label: 'Permissions (17)' },
  { id: 'clients', label: 'AI Client Setup' },
  { id: 'coolify', label: 'Build Logs (Coolify)' },
];

type McpTabId = (typeof MCP_TABS)[number]['id'];

function settingsToDraft(settings: PublicMcpSettingsView): McpDraftState {
  return {
    enabled: Boolean(settings.enabled),
    allowedIps: String(settings.allowedIps || ''),
    permissions: { ...(settings.permissions || {}) },
    coolifyUrl: String(settings.coolifyUrl || ''),
    coolifyTokenInput: '',
    clearCoolifyToken: false,
    coolifyAppUuid: String(settings.coolifyAppUuid || ''),
  };
}

export function McpWorkspace() {
  const currentRole = useVconRole();
  const { isOwner } = getVconRoleCapabilities(currentRole);
  const { success, warning, error } = useToast();

  const [saved, setSaved] = useState<PublicMcpSettingsView>(() =>
    getCached<PublicMcpSettingsView>('vcon:mcp-settings', DEFAULT_PUBLIC_MCP_SETTINGS),
  );
  const [draft, setDraft] = useState<McpDraftState>(() =>
    settingsToDraft(
      getCached<PublicMcpSettingsView>('vcon:mcp-settings', DEFAULT_PUBLIC_MCP_SETTINGS),
    ),
  );
  const [definitions, setDefinitions] = useState<McpPermissionDefinitionView[]>(() =>
    getCached<McpPermissionDefinitionView[]>('vcon:mcp-defs', []),
  );
  const [bridgeSync, setBridgeSync] = useState<McpBridgeSyncView | null>(() =>
    getCached<McpBridgeSyncView | null>('vcon:mcp-bridge', null),
  );

  // Security: one-time token stays strictly in component state (never cached globally).
  const [issuedToken, setIssuedToken] = useState<string>('');
  const tokenBannerRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<McpTabId>('connection');
  const [selectedClientTarget, setSelectedClientTarget] =
    useState<McpClientTargetId>('claude');
  const [origin, setOrigin] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(
    () => isOwner && !getCached<boolean>('vcon:mcp-loaded', false),
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [tokenBusy, setTokenBusy] = useState<boolean>(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState<boolean>(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState<boolean>(false);

  const loadMcpSettings = useCallback(async () => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/mcp', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to load MCP settings.');
      }

      const nextSettings = (data.settings ??
        DEFAULT_PUBLIC_MCP_SETTINGS) as PublicMcpSettingsView;
      const nextDefs = Array.isArray(data.permissionDefinitions)
        ? (data.permissionDefinitions as McpPermissionDefinitionView[])
        : [];
      const nextBridge = (data.bridgeSync ?? null) as McpBridgeSyncView | null;

      setCached('vcon:mcp-settings', nextSettings);
      setCached('vcon:mcp-defs', nextDefs);
      setCached('vcon:mcp-bridge', nextBridge);
      setCached('vcon:mcp-loaded', true);

      setSaved(nextSettings);
      setDraft(settingsToDraft(nextSettings));
      setDefinitions(nextDefs);
      setBridgeSync(nextBridge);
    } catch (err: unknown) {
      error(
        'Failed to load MCP settings',
        err instanceof Error ? err.message : 'Unable to fetch /api/mcp',
      );
    } finally {
      setLoading(false);
    }
  }, [isOwner, error]);

  useEffect(() => {
    setOrigin(window.location.origin);
    void loadMcpSettings();
  }, [loadMcpSettings]);

  const applyPostResult = (data: {
    settings?: PublicMcpSettingsView;
    issuedToken?: string;
    bridgeSync?: McpBridgeSyncView | null;
  }) => {
    if (data.settings) {
      setCached('vcon:mcp-settings', data.settings);
      setSaved(data.settings);
      setDraft(settingsToDraft(data.settings));
    }
    if (data.bridgeSync !== undefined) {
      setCached('vcon:mcp-bridge', data.bridgeSync);
      setBridgeSync(data.bridgeSync);
    }
    if (data.issuedToken) {
      setIssuedToken(data.issuedToken);
      requestAnimationFrame(() => {
        tokenBannerRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      });
    }
  };

  const notifySyncOutcome = (
    nextBridge: McpBridgeSyncView | null | undefined,
    successTitle: string,
    successDetail: string,
  ) => {
    const syncInfo = describeMcpBridgeSync(nextBridge);
    if (syncInfo.level === 'error') {
      error(syncInfo.title, syncInfo.detail);
    } else if (syncInfo.level === 'warning') {
      warning(syncInfo.title, syncInfo.detail);
    } else {
      success(successTitle, successDetail);
    }
  };

  const isDirty = useMemo(
    () => isMcpDraftDirty(draft, saved, definitions),
    [draft, saved, definitions],
  );

  const permCounts = useMemo(
    () => countEnabledMcpPermissions(draft.permissions, definitions),
    [draft.permissions, definitions],
  );

  const groupedPermissions = useMemo(
    () => groupMcpPermissionsByCategory(definitions, draft.permissions),
    [definitions, draft.permissions],
  );

  const endpointUrl = useMemo(
    () => buildMcpEndpointUrl(origin, saved.endpointPath || '/mcp'),
    [origin, saved.endpointPath],
  );

  const activeClientMeta = useMemo(
    () =>
      MCP_CLIENT_TARGETS.find((item) => item.id === selectedClientTarget) ??
      MCP_CLIENT_TARGETS[0],
    [selectedClientTarget],
  );

  const clientConfigJson = useMemo(
    () =>
      buildMcpClientConfigSnippet(selectedClientTarget, {
        endpointUrl,
        token: issuedToken,
      }),
    [selectedClientTarget, endpointUrl, issuedToken],
  );

  const copyText = async (value: string, label: string) => {
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable in this browser context');
      }
      await navigator.clipboard.writeText(value);
      success('Copied', `${label} copied to clipboard.`);
    } catch (copyErr: unknown) {
      error(
        'Copy failed',
        copyErr instanceof Error ? copyErr.message : 'Unable to copy to clipboard.',
      );
    }
  };

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isOwner) return;

    const payload = buildMcpSavePayload(draft, saved, definitions);
    if (Object.keys(payload).length === 0) {
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to save MCP settings.');
      }

      applyPostResult(data);
      notifySyncOutcome(
        data.bridgeSync,
        data.issuedToken ? 'MCP enabled & token issued' : 'MCP settings saved',
        data.issuedToken
          ? 'Bearer token revealed at the top of MCP Server — copy it into your AI client config.'
          : 'Configuration synced to live Port 4000 MCP server.',
      );
    } catch (saveErr: unknown) {
      error(
        'Save failed',
        saveErr instanceof Error ? saveErr.message : 'Unable to save MCP settings.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleTokenAction = async (mode: 'rotate' | 'revoke') => {
    if (!isOwner) return;
    setTokenBusy(true);
    try {
      const body =
        mode === 'rotate' ? { rotateToken: true } : { revokeToken: true };
      const response = await fetch('/api/mcp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Unable to ${mode} MCP token.`);
      }

      if (mode === 'revoke') {
        setIssuedToken('');
      }
      applyPostResult(data);
      setRotateConfirmOpen(false);
      setRevokeConfirmOpen(false);

      notifySyncOutcome(
        data.bridgeSync,
        mode === 'rotate' ? 'MCP token rotated' : 'MCP access revoked',
        mode === 'rotate'
          ? 'New one-time Bearer token generated below; old token invalidated.'
          : 'Bearer token cleared and Streamable HTTP /mcp endpoint disabled.',
      );
    } catch (tokErr: unknown) {
      error(
        mode === 'rotate' ? 'Token rotation failed' : 'Token revocation failed',
        tokErr instanceof Error ? tokErr.message : 'MCP token operation failed.',
      );
    } finally {
      setTokenBusy(false);
    }
  };

  const bridgeSummary = describeMcpBridgeSync(bridgeSync);

  return (
    <PageShell
      title="MCP Server"
      actions={
        isOwner ? (
          <Button
            size="xs"
            variant="secondary"
            icon="RefreshCw"
            loading={loading}
            onClick={() => void loadMcpSettings()}
          >
            Refresh
          </Button>
        ) : undefined
      }
    >
      <StatStrip
        items={[
          {
            label: 'MCP Status',
            value: !isOwner
              ? 'Owner-only'
              : saved.enabled
                ? 'Enabled'
                : 'Disabled',
            dot: !isOwner ? undefined : saved.enabled ? 'ok' : 'off',
          },
          {
            label: 'Bearer Token',
            value: !isOwner
              ? 'Restricted'
              : saved.hasToken
                ? saved.tokenPreview || 'Provisioned'
                : 'Not provisioned',
            dot: !isOwner ? undefined : saved.hasToken ? 'ok' : 'off',
          },
          {
            label: 'Tool Permissions',
            value: !isOwner
              ? '—'
              : `${permCounts.enabled} / ${permCounts.total || 17} enabled`,
          },
          {
            label: 'Port 4000 Sync',
            value: !isOwner ? '—' : bridgeSummary.title,
            dot: !isOwner
              ? undefined
              : bridgeSummary.level === 'success'
                ? 'ok'
                : bridgeSummary.level === 'warning' || bridgeSummary.level === 'error'
                  ? 'off'
                  : undefined,
          },
        ]}
      />

      {!isOwner ? (
        <div
          role="status"
          data-testid="mcp-non-owner-banner"
          className="border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2.5 text-[12px] text-[var(--text)]"
        >
          Owner-only workspace ({currentRole}) — MCP configuration, Bearer
          tokens, and AI agent permissions are restricted to Owner accounts.
        </div>
      ) : (
        <div className="w-full">
          {issuedToken && (
            <div
              ref={tokenBannerRef}
              role="status"
              data-testid="mcp-issued-token-banner"
              className="mb-3 flex flex-col gap-2 border border-[var(--accent)] bg-[var(--surface)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] font-medium text-[var(--text)]">
                  One-Time MCP Bearer Token (copy now — hidden after page reload)
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    variant="primary"
                    icon="Copy"
                    onClick={() => void copyText(issuedToken, 'MCP Bearer Token')}
                  >
                    Copy Token
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setIssuedToken('')}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
              <code className="break-all border border-[var(--border)] bg-[var(--bg-main)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--accent-text)]">
                {issuedToken}
              </code>
            </div>
          )}

          <SettingsTabs
            items={MCP_TABS.map((tab) =>
              tab.id === 'permissions'
                ? {
                    ...tab,
                    label: `Permissions (${permCounts.enabled}/${permCounts.total || 17})`,
                  }
                : tab,
            )}
            value={activeTab}
            onChange={(tab) => setActiveTab(tab as McpTabId)}
          />

          <form onSubmit={handleSave} noValidate className="w-full">
            <SettingsPanel
              id={`settings-panel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${activeTab}`}
            >
              {activeTab === 'connection' && (
                <>
                  <SettingsGroup title="MCP Endpoint Control">
                    <SettingsField label="Master Switch">
                      <FormSwitch
                        label="Enable Streamable HTTP MCP Server (/mcp)"
                        checked={draft.enabled}
                        disabled={loading || saving}
                        onChange={(checked) =>
                          setDraft((prev) => ({ ...prev, enabled: checked }))
                        }
                      />
                    </SettingsField>

                    <SettingsField label="MCP Endpoint URL">
                      <div className="flex items-center gap-1.5">
                        <Input
                          compact
                          readOnly
                          value={endpointUrl}
                          aria-label="MCP Endpoint URL"
                          className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text)]"
                        />
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          icon="Copy"
                          aria-label="Copy MCP Endpoint URL"
                          onClick={() => void copyText(endpointUrl, 'MCP Endpoint URL')}
                        >
                          Copy
                        </Button>
                      </div>
                    </SettingsField>

                    <SettingsField label="IP / CIDR Allowlist">
                      <Input
                        compact
                        placeholder="Optional: 127.0.0.1, 10.0.0.0/8 (blank = allow all IPs)"
                        value={draft.allowedIps}
                        disabled={loading || saving}
                        aria-label="IP or CIDR allowlist"
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, allowedIps: e.target.value }))
                        }
                        className="font-mono text-[11.5px]"
                      />
                    </SettingsField>
                  </SettingsGroup>

                  <SettingsGroup title="Bearer Authentication">
                    <SettingsField label="Active Token">
                      <div className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5">
                        <span className="font-mono text-[11.5px] text-[var(--text)]">
                          {saved.hasToken
                            ? saved.tokenPreview || 'Provisioned (dsmcp_...)'
                            : 'Not provisioned (auto-mints on enable)'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            icon="Key"
                            loading={tokenBusy}
                            disabled={loading || tokenBusy || saving}
                            onClick={() => {
                              if (saved.hasToken) {
                                setRotateConfirmOpen(true);
                              } else {
                                void handleTokenAction('rotate');
                              }
                            }}
                          >
                            {saved.hasToken ? 'Rotate Token' : 'Mint Token'}
                          </Button>
                          {saved.hasToken && (
                            <Button
                              type="button"
                              size="xs"
                              variant="danger"
                              disabled={loading || tokenBusy || saving}
                              onClick={() => setRevokeConfirmOpen(true)}
                            >
                              Revoke & Disable
                            </Button>
                          )}
                        </div>
                      </div>
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'permissions' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2">
                    <span className="font-mono text-[11px] text-[var(--text-muted)]">
                      {permCounts.enabled} of {permCounts.total || 17} MCP tools enabled
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        disabled={loading || saving}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            permissions: applyMcpPermissionPreset(
                              prev.permissions,
                              definitions,
                              'read_only',
                            ),
                          }))
                        }
                      >
                        Read-Only
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        disabled={loading || saving}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            permissions: applyMcpPermissionPreset(
                              prev.permissions,
                              definitions,
                              'defaults',
                            ),
                          }))
                        }
                      >
                        Defaults
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={loading || saving}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            permissions: applyMcpPermissionPreset(
                              prev.permissions,
                              definitions,
                              'all_off',
                            ),
                          }))
                        }
                      >
                        Disable All
                      </Button>
                    </div>
                  </div>

                  {groupedPermissions.length === 0 ? (
                    <div className="p-4 text-[12px] text-[var(--text-muted)]">
                      {loading
                        ? 'Loading MCP tool permissions...'
                        : 'No MCP permission definitions available.'}
                    </div>
                  ) : (
                    groupedPermissions.map((group) => (
                      <SettingsGroup
                        key={group.category}
                        title={`${group.category} (${group.enabledCount}/${group.totalCount})`}
                        action={
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={loading || saving}
                              onClick={() =>
                                setDraft((prev) => ({
                                  ...prev,
                                  permissions: applyCategoryPermissionToggle(
                                    prev.permissions,
                                    definitions,
                                    group.category,
                                    true,
                                  ),
                                }))
                              }
                            >
                              Enable All
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={loading || saving}
                              onClick={() =>
                                setDraft((prev) => ({
                                  ...prev,
                                  permissions: applyCategoryPermissionToggle(
                                    prev.permissions,
                                    definitions,
                                    group.category,
                                    false,
                                  ),
                                }))
                              }
                            >
                              Disable
                            </Button>
                          </>
                        }
                      >
                        {group.items.map((def) => (
                          <SettingsField
                            key={def.key}
                            label={`${def.label} [${def.risk.toUpperCase()}]`}
                          >
                            <div className="flex flex-col gap-1">
                              <FormSwitch
                                label={def.key}
                                checked={Boolean(draft.permissions[def.key])}
                                disabled={loading || saving}
                                onChange={(checked) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    permissions: {
                                      ...prev.permissions,
                                      [def.key]: checked,
                                    },
                                  }))
                                }
                              />
                              <span className="text-[10.5px] text-[var(--text-faint)]">
                                {def.description}
                              </span>
                            </div>
                          </SettingsField>
                        ))}
                      </SettingsGroup>
                    ))
                  )}
                </>
              )}

              {activeTab === 'clients' && (
                <div className="flex flex-col gap-3 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      role="tablist"
                      aria-label="AI MCP Client Config Target"
                    >
                      {MCP_CLIENT_TARGETS.map((target) => (
                        <Button
                          key={target.id}
                          type="button"
                          size="xs"
                          variant={
                            selectedClientTarget === target.id
                              ? 'primary'
                              : 'secondary'
                          }
                          onClick={() => setSelectedClientTarget(target.id)}
                        >
                          {target.label}
                        </Button>
                      ))}
                    </div>
                    <span className="font-mono text-[10.5px] text-[var(--text-faint)]">
                      {activeClientMeta.configPath}
                    </span>
                  </div>

                  <Panel
                    title={`${activeClientMeta.label} — ${activeClientMeta.transportLabel}`}
                    meta={
                      issuedToken
                        ? 'USING NEWLY ISSUED TOKEN'
                        : 'PLACEHOLDER TOKEN'
                    }
                    action={
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        icon="Copy"
                        onClick={() =>
                          void copyText(
                            clientConfigJson,
                            `${activeClientMeta.label} MCP JSON`,
                          )
                        }
                      >
                        Copy JSON
                      </Button>
                    }
                  >
                    <CodeBlock data-testid="mcp-client-config-code">
                      {clientConfigJson}
                    </CodeBlock>
                  </Panel>

                  {!issuedToken && (
                    <div className="text-[11px] text-[var(--text-muted)]">
                      Replace <code className="font-mono">YOUR_MCP_BEARER_TOKEN</code>{' '}
                      with your saved <code className="font-mono">dsmcp_</code> token,
                      or rotate the token under Connection &amp; Token to populate it
                      here automatically.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'coolify' && (
                <SettingsGroup title="Optional Coolify Deployment Log Bridge">
                  <SettingsField label="Coolify Base URL">
                    <Input
                      compact
                      type="url"
                      placeholder="https://coolify.example.com"
                      value={draft.coolifyUrl}
                      disabled={loading || saving}
                      aria-label="Coolify Base URL"
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, coolifyUrl: e.target.value }))
                      }
                      className="font-mono text-[11.5px]"
                    />
                  </SettingsField>

                  <SettingsField label="Coolify API Token">
                    <div className="flex flex-col gap-1.5">
                      <Input
                        compact
                        type="password"
                        placeholder={
                          saved.hasCoolifyToken
                            ? `Saved (${saved.coolifyTokenMask || '••••'}) — enter new token to replace`
                            : 'Enter Coolify API Bearer token'
                        }
                        value={draft.coolifyTokenInput}
                        disabled={loading || saving || draft.clearCoolifyToken}
                        aria-label="Coolify API Token"
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            coolifyTokenInput: e.target.value,
                            clearCoolifyToken: false,
                          }))
                        }
                        className="font-mono text-[11.5px]"
                      />
                      {saved.hasCoolifyToken && (
                        <FormSwitch
                          label="Clear saved Coolify API token"
                          checked={draft.clearCoolifyToken}
                          disabled={loading || saving}
                          onChange={(checked) =>
                            setDraft((prev) => ({
                              ...prev,
                              clearCoolifyToken: checked,
                              ...(checked ? { coolifyTokenInput: '' } : {}),
                            }))
                          }
                        />
                      )}
                    </div>
                  </SettingsField>

                  <SettingsField label="Coolify App UUID">
                    <Input
                      compact
                      placeholder="e.g. x8k2p9m4q1"
                      value={draft.coolifyAppUuid}
                      disabled={loading || saving}
                      aria-label="Coolify App UUID"
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          coolifyAppUuid: e.target.value,
                        }))
                      }
                      className="font-mono text-[11.5px]"
                    />
                  </SettingsField>
                </SettingsGroup>
              )}

              <SettingsFooter
                status={
                  isDirty
                    ? 'Unsaved MCP configuration changes'
                    : bridgeSummary.detail || bridgeSummary.title
                }
              >
                {isDirty && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setDraft(settingsToDraft(saved))}
                  >
                    Discard
                  </Button>
                )}
                <Button
                  type="submit"
                  size="xs"
                  variant="primary"
                  loading={saving}
                  disabled={!isDirty || loading || saving}
                >
                  Save MCP Settings
                </Button>
              </SettingsFooter>
            </SettingsPanel>
          </form>
        </div>
      )}

      <Modal
        isOpen={rotateConfirmOpen}
        onClose={() => {
          if (!tokenBusy) setRotateConfirmOpen(false);
        }}
        title="Rotate MCP Bearer Token"
        maxWidth="sm"
        footer={
          <>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={tokenBusy}
              onClick={() => setRotateConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              variant="primary"
              data-testid="confirm-rotate-mcp-token"
              loading={tokenBusy}
              disabled={tokenBusy}
              onClick={() => void handleTokenAction('rotate')}
            >
              Rotate Token
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
          Generating a new <code className="font-mono text-[var(--text)]">dsmcp_</code>{' '}
          Bearer token immediately invalidates the previous token across Port 4000{' '}
          <code className="font-mono text-[var(--text)]">/mcp</code> sessions. Update
          connected AI clients with the new token shown afterward.
        </p>
      </Modal>

      <Modal
        isOpen={revokeConfirmOpen}
        onClose={() => {
          if (!tokenBusy) setRevokeConfirmOpen(false);
        }}
        title="Revoke MCP Token & Disable Server"
        maxWidth="sm"
        footer={
          <>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={tokenBusy}
              onClick={() => setRevokeConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              variant="danger"
              data-testid="confirm-revoke-mcp-token"
              loading={tokenBusy}
              disabled={tokenBusy}
              onClick={() => void handleTokenAction('revoke')}
            >
              Revoke & Disable
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
          Revoking deletes the active Bearer token and sets the{' '}
          <code className="font-mono text-[var(--text)]">/mcp</code> server to
          Disabled (<code className="font-mono text-[var(--text)]">503 MCP_DISABLED</code>).
        </p>
      </Modal>
    </PageShell>
  );
}

export default McpWorkspace;
