'use client';

import { AdminPageHeader } from '@/components/layout/AdminPageHeader';
import { Button } from '@/components/ui/Button';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { SettingsField, SettingsGroup, SettingsTabs } from '@/components/ui/SettingsLayout';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
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
];

type TabId = (typeof TABS)[number]['id'];

export function SettingsWorkspace() {
  const { success, error } = useToast();
  const [settings, setSettings] = useState<EditableSettings>(() => getCached<EditableSettings>('vcon:settings', DEFAULT_SETTINGS));
  const [savedSettings, setSavedSettings] = useState<EditableSettings>(() => getCached<EditableSettings>('vcon:settings', DEFAULT_SETTINGS));
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [jwtSecret, setJwtSecret] = useState('');
  const [storagePath, setStoragePath] = useState(() => getCached<string>('vcon:storage-path', ''));
  const [baseUrl, setBaseUrl] = useState('');
  const [webSocketUrl, setWebSocketUrl] = useState('');
  const [serverPort, setServerPort] = useState(() => getCached<number>('vcon:server-port', 4000));
  const [loading, setLoading] = useState(() => !getCached<boolean>('vcon:settings-loaded', false));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseUrl(window.location.origin);
    const isLocalDev = window.location.port === '3000';
    const socketProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socketHost = isLocalDev
      ? `${window.location.hostname}:4000`
      : window.location.host;
    setWebSocketUrl(`${socketProtocol}://${socketHost}`);

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
        setSettings(setCached('vcon:settings', loaded));
        setSavedSettings(loaded);
        setServerPort(setCached('vcon:server-port', Number((settingsData.settings as PublicSettings).serverPort ?? 4000)));
        setStoragePath(setCached('vcon:storage-path', String(storageData.stats?.storageDirectory ?? '')));
        setCached('vcon:settings-loaded', true);
      })
      .catch(() => {
        error('Settings load failed', 'Using default runtime settings.');
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
    const normalized: EditableSettings = {
      maxEventsPerSec: Math.max(1, Math.min(10000, settings.maxEventsPerSec || DEFAULT_SETTINGS.maxEventsPerSec)),
      maxPayloadSizeKb: Math.max(1, Math.min(5120, settings.maxPayloadSizeKb || DEFAULT_SETTINGS.maxPayloadSizeKb)),
      batchFlushThreshold: Math.max(1, settings.batchFlushThreshold || DEFAULT_SETTINGS.batchFlushThreshold),
      batchFlushIntervalMs: Math.max(100, settings.batchFlushIntervalMs || DEFAULT_SETTINGS.batchFlushIntervalMs),
      fileRotationMb: Math.max(1, settings.fileRotationMb || DEFAULT_SETTINGS.fileRotationMb),
      enableIdempotency: settings.enableIdempotency,
      autoPruneDays: Math.max(1, Math.min(365, settings.autoPruneDays || DEFAULT_SETTINGS.autoPruneDays)),
    };
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...normalized,
          ...(jwtSecret.trim() ? { jwtSecret: jwtSecret.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Settings update failed');
      setSettings(setCached('vcon:settings', normalized));
      setSavedSettings(normalized);
      setJwtSecret('');
      success('Settings saved', 'Runtime settings updated.');
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
    <section className="w-full">
      <AdminPageHeader title="Settings" />

      <div className="max-w-[780px]">
        <SettingsTabs items={TABS} value={activeTab} onChange={(tab) => setActiveTab(tab as TabId)} />

        <form onSubmit={saveSettings}>
          <div
            id={`settings-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className="border border-t-0 border-[var(--border)] bg-[var(--surface)]"
          >
            <>
              {activeTab === 'general' && (
                <>
                  <SettingsGroup title="Identity">
                    <SettingsField label="Instance name">
                      <Input compact value="DataStack" readOnly className="border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="Base URL">
                      <Input compact value={baseUrl} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Throughput">
                    <SettingsField label="Events per second">
                      <Input compact type="number" min="1" max="10000" value={settings.maxEventsPerSec} onChange={(event) => updateNumber('maxEventsPerSec', event.target.value)} />
                    </SettingsField>
                    <SettingsField label="Idempotency">
                      <FormSwitch label="Deduplicate events" checked={settings.enableIdempotency} onChange={(enableIdempotency) => setSettings((current) => ({ ...current, enableIdempotency }))} />
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'connections' && (
                <>
                  <SettingsGroup title="WebSocket server">
                    <SettingsField label="WebSocket URL">
                      <Input compact value={webSocketUrl} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="Socket port">
                      <Input compact type="number" value={serverPort} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Event buffer">
                    <SettingsField label="Batch flush threshold">
                      <Input compact type="number" min="1" value={settings.batchFlushThreshold} onChange={(event) => updateNumber('batchFlushThreshold', event.target.value)} />
                    </SettingsField>
                    <SettingsField label="Flush interval">
                      <Input compact type="number" min="100" suffix="ms" value={settings.batchFlushIntervalMs} onChange={(event) => updateNumber('batchFlushIntervalMs', event.target.value)} className="font-mono" />
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'storage' && (
                <>
                  <SettingsGroup title="CSV files">
                    <SettingsField label="Root path">
                      <Input compact value={storagePath || 'Unavailable'} readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]" />
                    </SettingsField>
                    <SettingsField label="File rotation">
                      <Input compact type="number" min="1" suffix="MB" value={settings.fileRotationMb} onChange={(event) => updateNumber('fileRotationMb', event.target.value)} className="font-mono" />
                    </SettingsField>
                    <SettingsField label="Retention">
                      <Input compact type="number" min="1" max="365" suffix="days" value={settings.autoPruneDays} onChange={(event) => updateNumber('autoPruneDays', event.target.value)} className="font-mono" />
                    </SettingsField>
                  </SettingsGroup>
                  <SettingsGroup title="Schema">
                    <SettingsField label="Row format">
                      <Input compact value="clientId, eventId, timestamp, payload" readOnly className="border-[var(--border)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-muted)]" />
                    </SettingsField>
                  </SettingsGroup>
                </>
              )}

              {activeTab === 'security' && (
                <SettingsGroup title="Authentication">
                  <SettingsField label="JWT secret">
                    <Input compact type="password" autoComplete="new-password" value={jwtSecret} onChange={(event) => setJwtSecret(event.target.value)} placeholder="New secret..." />
                  </SettingsField>
                  <SettingsField label="Payload size limit">
                    <Input compact type="number" min="1" max="5120" suffix="KB" value={settings.maxPayloadSizeKb} onChange={(event) => updateNumber('maxPayloadSizeKb', event.target.value)} className="font-mono" />
                  </SettingsField>
                </SettingsGroup>
              )}
            </>
          </div>

          <footer className="flex flex-wrap items-center gap-2 border border-t-0 border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="flex flex-1 items-center gap-1.5 text-[11px] text-[var(--text-muted)]" role="status">
              <span className={`h-1.5 w-1.5 ${isDirty ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'}`} />
              {loading ? 'Loading' : isDirty ? 'Unsaved' : 'Saved'}
            </div>
            <Button type="button" size="xs" disabled={!isDirty || saving} onClick={discardChanges}>Discard</Button>
            <Button type="submit" variant="primary" size="xs" icon="Save" loading={saving} disabled={loading || !isDirty}>Save</Button>
          </footer>
        </form>
      </div>
    </section>
  );
}
