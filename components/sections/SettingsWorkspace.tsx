'use client';

import { Button } from '@/components/ui/Button';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { SettingsField, SettingsGroup, SettingsTabs } from '@/components/ui/SettingsLayout';
import { useToast } from '@/components/ui/Toast';
import { useEffect, useMemo, useState } from 'react';

interface EditableSettings {
  maxEventsPerSec: number;
  maxPayloadSizeKb: number;
  batchFlushThreshold: number;
  batchFlushIntervalMs: number;
  fileRotationMb: number;
  enableIdempotency: boolean;
  autoPruneDays: number;
}

interface PublicSettings extends EditableSettings {
  serverPort: number;
  webPort: number;
  updatedAt: string;
}

const DEFAULT_SETTINGS: EditableSettings = {
  maxEventsPerSec: 100,
  maxPayloadSizeKb: 100,
  batchFlushThreshold: 500,
  batchFlushIntervalMs: 2000,
  fileRotationMb: 100,
  enableIdempotency: true,
  autoPruneDays: 30,
};

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'storage', label: 'Storage' },
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
];

type TabId = (typeof TABS)[number]['id'];

export function SettingsWorkspace() {
  const { success, error } = useToast();
  const [settings, setSettings] = useState<EditableSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<EditableSettings>(DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [jwtSecret, setJwtSecret] = useState('');
  const [storagePath, setStoragePath] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [webSocketUrl, setWebSocketUrl] = useState('');
  const [serverPort, setServerPort] = useState(4000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseUrl(window.location.origin);
    setWebSocketUrl(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:4000`);

    Promise.all([
      fetch('/api/settings').then(async (response) => {
        if (!response.ok) throw new Error('Unable to load settings');
        return response.json();
      }),
      fetch('/api/storage').then(async (response) => {
        if (!response.ok) throw new Error('Unable to load storage information');
        return response.json();
      }),
    ])
      .then(([settingsData, storageData]) => {
        const loaded: EditableSettings = {
          maxEventsPerSec: Number(settingsData.settings.maxEventsPerSec ?? DEFAULT_SETTINGS.maxEventsPerSec),
          maxPayloadSizeKb: Number(settingsData.settings.maxPayloadSizeKb ?? DEFAULT_SETTINGS.maxPayloadSizeKb),
          batchFlushThreshold: Number(settingsData.settings.batchFlushThreshold ?? DEFAULT_SETTINGS.batchFlushThreshold),
          batchFlushIntervalMs: Number(settingsData.settings.batchFlushIntervalMs ?? DEFAULT_SETTINGS.batchFlushIntervalMs),
          fileRotationMb: Number(settingsData.settings.fileRotationMb ?? DEFAULT_SETTINGS.fileRotationMb),
          enableIdempotency: Boolean(settingsData.settings.enableIdempotency ?? DEFAULT_SETTINGS.enableIdempotency),
          autoPruneDays: Number(settingsData.settings.autoPruneDays ?? DEFAULT_SETTINGS.autoPruneDays),
        };
        setSettings(loaded);
        setSavedSettings(loaded);
        setServerPort(Number((settingsData.settings as PublicSettings).serverPort ?? 4000));
        setStoragePath(String(storageData.stats?.storageDirectory ?? ''));
      })
      .catch((loadError) => {
        error('Settings unavailable', loadError instanceof Error ? loadError.message : 'Unable to load settings');
      })
      .finally(() => setLoading(false));
  }, [error]);

  const isDirty = useMemo(
    () => jwtSecret.trim().length > 0 || JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [jwtSecret, savedSettings, settings]
  );

  const updateNumber = (key: keyof EditableSettings, value: string) => {
    setSettings((current) => ({ ...current, [key]: Number(value) || 0 }));
  };

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          ...(jwtSecret.trim() ? { jwtSecret: jwtSecret.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Settings update failed');
      setSavedSettings(settings);
      setJwtSecret('');
      success('Settings saved', 'Supported runtime settings have been applied.');
    } catch (saveError) {
      error('Save failed', saveError instanceof Error ? saveError.message : 'Unable to save settings');
    } finally {
      setSaving(false);
    }
  };

  const discardChanges = () => {
    setSettings(savedSettings);
    setJwtSecret('');
  };

  return (
    <section className="mx-auto w-full max-w-[var(--container-width)]">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-xs text-[var(--text-faint)]">
        <span>Console</span>
        <span aria-hidden="true" className="text-[var(--border-strong)]">/</span>
        <span aria-current="page" className="text-[var(--text)]">Settings</span>
      </nav>
      <header className="mb-4">
        <h1 className="text-base font-medium tracking-tight text-[var(--text)]">Settings</h1>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">Configure your DataStack instance</p>
      </header>

      <SettingsTabs items={TABS} value={activeTab} onChange={(tab) => setActiveTab(tab as TabId)} />

      <form onSubmit={saveSettings}>
        <div
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          className="border border-t-0 border-[var(--border)] bg-[var(--surface)]"
        >
          {loading ? (
            <p className="p-4 text-xs text-[var(--text-faint)]">Loading settings...</p>
          ) : (
            <>
              {activeTab === 'general' && (
                <>
                  <SettingsGroup title="Identity">
                    <SettingsField label="Instance name" hint="Shown in dashboard headers and emails">
                      <Input compact value="DataStack" readOnly className="border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="Base URL" hint="Current browser origin">
                      <Input compact value={baseUrl} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11.5px] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="Instance ID" hint="Instance identifier is not configured">
                      <Input compact value="Not configured" readOnly className="border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Throughput">
                    <SettingsField label="Events per second" hint="Global cap; client limits may be lower">
                      <Input compact type="number" min="1" max="10000" value={settings.maxEventsPerSec} onChange={(event) => updateNumber('maxEventsPerSec', event.target.value)} />
                    </SettingsField>
                    <SettingsField label="Enable idempotency" hint="Reject duplicate clientId + eventId combinations">
                      <FormSwitch label="Deduplicate incoming events" checked={settings.enableIdempotency} onChange={(enableIdempotency) => setSettings((current) => ({ ...current, enableIdempotency }))} />
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'connections' && (
                <>
                  <SettingsGroup title="WebSocket server">
                    <SettingsField label="Public WebSocket URL" hint="Clients connect through the configured host">
                      <Input compact value={webSocketUrl} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11.5px] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="Socket port" hint="Express process port">
                      <Input compact type="number" value={serverPort} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Event buffer">
                    <SettingsField label="Batch flush threshold" hint="Write buffered rows to CSV at this count">
                      <Input compact type="number" min="1" value={settings.batchFlushThreshold} onChange={(event) => updateNumber('batchFlushThreshold', event.target.value)} />
                    </SettingsField>
                    <SettingsField label="Flush interval" hint="Maximum time before buffered rows are written">
                      <div className="flex items-center gap-0">
                        <Input compact type="number" min="100" value={settings.batchFlushIntervalMs} onChange={(event) => updateNumber('batchFlushIntervalMs', event.target.value)} className="border-[var(--border)] font-mono" />
                        <span className="flex h-9 items-center border border-l-0 border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text-muted)]">ms</span>
                      </div>
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'storage' && (
                <>
                  <SettingsGroup title="CSV files">
                    <SettingsField label="Root path" hint="Current server storage directory">
                      <Input compact value={storagePath || 'Unavailable'} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11.5px] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="File rotation" hint="Files rotate daily and at the configured size limit">
                      <div className="flex items-center gap-0">
                        <Input compact type="number" min="1" value={settings.fileRotationMb} onChange={(event) => updateNumber('fileRotationMb', event.target.value)} className="border-[var(--border)] font-mono" />
                        <span className="flex h-9 items-center border border-l-0 border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text-muted)]">MB</span>
                      </div>
                    </SettingsField>
                    <SettingsField label="Retention" hint="Retention value is stored; automatic pruning is not enabled">
                      <div className="flex items-center gap-0">
                        <Input compact type="number" min="1" max="365" value={settings.autoPruneDays} onChange={(event) => updateNumber('autoPruneDays', event.target.value)} className="border-[var(--border)] font-mono" />
                        <span className="flex h-9 items-center border border-l-0 border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text-muted)]">days</span>
                      </div>
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Schema">
                    <SettingsField label="Row format" hint="Fixed CSV schema">
                      <Input compact value="clientId, eventId, timestamp, payload" readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11.5px] text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'security' && (
                <>
                  <SettingsGroup title="Authentication">
                    <SettingsField label="JWT secret" hint="Changing the secret invalidates existing client tokens">
                      <Input compact type="password" autoComplete="new-password" value={jwtSecret} onChange={(event) => setJwtSecret(event.target.value)} placeholder="Leave blank to keep the current secret" />
                    </SettingsField>
                    <SettingsField label="Payload size limit" hint="Maximum accepted event payload size">
                      <div className="flex items-center gap-0">
                        <Input compact type="number" min="1" max="5120" value={settings.maxPayloadSizeKb} onChange={(event) => updateNumber('maxPayloadSizeKb', event.target.value)} className="border-[var(--border)] font-mono" />
                        <span className="flex h-9 items-center border border-l-0 border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text-muted)]">KB</span>
                      </div>
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Configuration">
                    <p className="text-xs leading-relaxed text-[var(--text-faint)]">Allowed origins and token expiration are controlled by deployment configuration and are not editable from this console.</p>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'notifications' && (
                <SettingsGroup title="Delivery">
                  <p className="text-xs leading-relaxed text-[var(--text-faint)]">Email and webhook notification delivery are not configured for this instance.</p>
                </SettingsGroup>
              )}
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border border-t-0 border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          <div className="flex flex-1 items-center gap-1.5 text-xs text-[var(--text-muted)]" role="status">
            <span className={`h-1.5 w-1.5 ${isDirty ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'}`} />
            {loading ? 'Loading settings' : isDirty ? 'Unsaved changes' : 'All changes saved'}
          </div>
          <Button type="button" size="xs" disabled={!isDirty || saving} onClick={discardChanges}>Discard</Button>
          <Button type="submit" variant="primary" size="xs" icon="Save" loading={saving} disabled={loading || !isDirty}>Save changes</Button>
        </footer>
      </form>

      <p className="mt-3 text-[11px] text-[var(--text-faint)]">Some settings require a service restart to take effect.</p>
    </section>
  );
}
