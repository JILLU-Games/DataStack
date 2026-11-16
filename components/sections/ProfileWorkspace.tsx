'use client';

import { AdminPageHeader } from '@/components/layout/AdminPageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SettingsField, SettingsGroup } from '@/components/ui/SettingsLayout';
import { StatStrip } from '@/components/ui/StatStrip';
import { useToast } from '@/components/ui/Toast';
import { getCached, setCached } from '@/lib/vconCache';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface AdminProfileData {
  email: string;
  role: string;
  storageMode: string;
  createdAt: string;
  sessionExpiresAt: string;
}

const DEFAULT_PROFILE: AdminProfileData = {
  email: 'admin@datastack.dev',
  role: 'Owner',
  storageMode: 'In-Memory',
  createdAt: '',
  sessionExpiresAt: '',
};

export function ProfileWorkspace() {
  const { success, error } = useToast();
  const [profile, setProfile] = useState<AdminProfileData>(() => getCached<AdminProfileData>('vcon:profile', DEFAULT_PROFILE));
  const [email, setEmail] = useState(() => getCached<AdminProfileData>('vcon:profile', DEFAULT_PROFILE).email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(() => !getCached<boolean>('vcon:profile-loaded', false));
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    fetch('/api/auth/profile', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Unable to load profile');
        return res.json();
      })
      .then((data) => {
        if (data.profile) {
          setProfile(setCached('vcon:profile', data.profile));
          setEmail(data.profile.email);
          setCached('vcon:profile-loaded', true);
        }
      })
      .catch(() => {
        error('Profile load failed', 'Could not load administrator profile.');
      })
      .finally(() => setLoading(false));
  }, [error]);

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      error('Validation error', 'Admin email is required.');
      return;
    }
    if (!currentPassword) {
      error('Validation error', 'Enter your current password to save changes.');
      return;
    }
    if (newPassword && newPassword !== confirmPassword) {
      error('Validation error', 'New password and confirmation do not match.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: trimmedEmail,
          currentPassword,
          newPassword: newPassword || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Profile update failed');
      setProfile(setCached('vcon:profile', data.profile));
      setEmail(data.profile.email);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      success('Profile updated', 'Administrator credentials updated.');
    } catch (saveError) {
      error('Update failed', saveError instanceof Error ? saveError.message : 'Unable to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Unable to sign out');
      window.location.assign('/vcon/login');
    } catch {
      error('Sign out failed', 'Please try again.');
      setSigningOut(false);
    }
  };

  return (
    <section className="w-full">
      <AdminPageHeader
        title="Profile"
        actions={
          <>
            <Link href="/vcon/settings">
              <Button type="button" size="xs" variant="secondary" icon="Sliders">
                Settings
              </Button>
            </Link>
            <Button
              type="button"
              size="xs"
              variant="danger"
              icon="LogOut"
              loading={signingOut}
              onClick={handleSignOut}
            >
              Sign out
            </Button>
          </>
        }
      />

      <StatStrip
        items={[
          { label: 'Administrator', value: profile.email },
          { label: 'Role', value: profile.role, dot: 'ok' },
          { label: 'Auth Store', value: profile.storageMode },
          {
            label: 'Session Expires',
            value: profile.sessionExpiresAt
              ? new Date(profile.sessionExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : 'Active',
          },
        ]}
      />

      <form onSubmit={handleSave} className="max-w-[780px] border border-[var(--border)] bg-[var(--surface)]">
        <SettingsGroup title="Account identity">
          <SettingsField label="Admin email">
            <Input
              compact
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </SettingsField>
          <SettingsField label="Access role">
            <Input
              compact
              value={profile.role}
              readOnly
              className="border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
            />
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup title="Security & password">
          <SettingsField label="Current password">
            <Input
              compact
              type="password"
              autoComplete="current-password"
              placeholder="Required to confirm changes"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </SettingsField>
          <SettingsField label="New password">
            <Input
              compact
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep current"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </SettingsField>
          <SettingsField label="Confirm new password">
            <Input
              compact
              type="password"
              autoComplete="new-password"
              placeholder="Repeat new password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </SettingsField>
        </SettingsGroup>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <span className="text-[11px] text-[var(--text-muted)]">
            {loading ? 'Loading profile...' : 'Confirm current password to update credentials'}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              disabled={saving}
              onClick={() => {
                setEmail(profile.email);
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
              }}
            >
              Reset
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="xs"
              icon="Save"
              loading={saving}
              disabled={loading || saving}
            >
              Update profile
            </Button>
          </div>
        </footer>
      </form>
    </section>
  );
}
