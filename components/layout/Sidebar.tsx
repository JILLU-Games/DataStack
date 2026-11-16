'use client';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import { getCached, setCached } from '@/lib/vconCache';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useEffect, useState } from 'react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface CachedProfile {
  email?: string;
  role?: string;
}

const NAVIGATION_SECTIONS = [
  {
    group: 'Main',
    items: [
      { name: 'Dashboard', href: '/vcon/dashboard', icon: 'LayoutDashboard' },
      { name: 'Events', href: '/vcon/data', icon: 'Activity' },
      { name: 'Clients', href: '/vcon/clients', icon: 'Key' },
      { name: 'Export', href: '/vcon/export', icon: 'Download' },
      { name: 'Storage', href: '/vcon/storage', icon: 'HardDrive' },
    ],
  },
  {
    group: 'System',
    items: [
      { name: 'Python SDK', href: '/vcon/sdk', icon: 'FileCode2' },
      { name: 'Simulator', href: '/vcon/simulator', icon: 'Play' },
      { name: 'Settings', href: '/vcon/settings', icon: 'Sliders' },
      { name: 'Profile', href: '/vcon/profile', icon: 'User' },
    ],
  },
];

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen = false,
  onClose,
}) => {
  const pathname = usePathname();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [adminEmail, setAdminEmail] = useState<string>(
    () => getCached<CachedProfile>('vcon:profile', {}).email || 'Admin'
  );
  const [adminRole, setAdminRole] = useState<string>(
    () => getCached<CachedProfile>('vcon:profile', {}).role || 'Owner'
  );

  useEffect(() => {
    const saved = localStorage.getItem('datastack-theme') as 'dark' | 'light' | null;
    const initial = saved === 'light' ? 'light' : 'dark';
    setTheme(initial);
    document.documentElement.classList.toggle('light', initial === 'light');
    document.documentElement.classList.toggle('dark', initial === 'dark');
  }, []);

  useEffect(() => {
    const cached = getCached<CachedProfile>('vcon:profile', {});
    if (cached.email) {
      setAdminEmail(cached.email);
      if (cached.role) setAdminRole(cached.role);
    }

    fetch('/api/auth/profile', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profile?.email) {
          setCached('vcon:profile', data.profile);
          setCached('vcon:profile-loaded', true);
          setAdminEmail(data.profile.email);
          setAdminRole(data.profile.role || 'Owner');
        }
      })
      .catch(() => {
        // Keep cached or default identity label if offline
      });
  }, [pathname]);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('datastack-theme', nextTheme);
    document.documentElement.classList.toggle('light', nextTheme === 'light');
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Unable to sign out');
      window.location.assign('/vcon/login');
    } catch {
      setIsSigningOut(false);
    }
  };

  const avatarInitial = adminEmail.trim().charAt(0).toUpperCase() || 'A';

  return (
    <>
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/55 md:hidden"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[184px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform duration-150 ease-out md:sticky md:top-0 md:h-dvh md:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Brand Header (h-10 = 40px, aligned pixel-for-pixel with AdminPageHeader) */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
          <Link
            href="/vcon/dashboard"
            onClick={onClose}
            className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium text-[var(--text)]"
          >
            <span className="grid h-3 w-3 shrink-0 place-items-center bg-[var(--accent)]">
              <span className="h-1 w-1 bg-[var(--bg)]" />
            </span>
            <span className="truncate">DataStack</span>
          </Link>

          <Link
            href="/"
            title="Public Home"
            aria-label="Public Home"
            className="hidden text-[10.5px] text-[var(--text-faint)] hover:text-[var(--text)] md:inline"
          >
            Site ↗
          </Link>

          <Button
            type="button"
            variant="icon"
            size="icon"
            icon="X"
            onClick={onClose}
            aria-label="Close navigation"
            title="Close navigation"
            className="h-6 w-6 md:hidden"
          />
        </div>

        {/* Clean 2-Group Navigation */}
        <nav
          aria-label="Admin navigation"
          className="flex-1 overflow-y-auto px-2 py-2.5 flex flex-col gap-3.5"
        >
          {NAVIGATION_SECTIONS.map((section) => (
            <div key={section.group} className="flex flex-col gap-0.5">
              <div className="px-2 pb-1 text-[9.5px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
                {section.group}
              </div>
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className={cn(
                      'flex h-7 min-w-0 items-center gap-2 border-l-2 px-2 text-[12px] transition-colors select-none',
                      isActive
                        ? 'border-l-[var(--accent)] bg-[var(--surface-2)] font-medium text-[var(--text)]'
                        : 'border-l-transparent text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                    )}
                  >
                    <Icon
                      name={item.icon}
                      size={13}
                      className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}
                    />
                    <span className="truncate">{item.name}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Bottom Dock: Live Admin Identity + Theme Toggle + Sign Out */}
        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border)] bg-[var(--bg)] px-2.5 py-2">
          <Link
            href="/vcon/profile"
            onClick={onClose}
            className="flex flex-1 min-w-0 items-center gap-2 hover:opacity-90"
            title={`Admin Profile (${adminEmail})`}
          >
            <div className="grid h-6 w-6 shrink-0 place-items-center border border-[var(--border-strong)] bg-[var(--surface-3)] text-[10.5px] font-medium text-[var(--text)]">
              {avatarInitial}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[11px] font-medium text-[var(--text)]">
                {adminEmail}
              </div>
              <div className="truncate text-[9px] uppercase tracking-wider text-[var(--text-faint)]">
                {adminRole}
              </div>
            </div>
          </Link>

          <Button
            type="button"
            variant="icon"
            size="icon"
            icon={theme === 'dark' ? 'Sun' : 'Moon'}
            onClick={toggleTheme}
            title="Toggle theme"
            aria-label="Toggle theme"
            className="h-6 w-6 border border-[var(--border)] bg-[var(--surface)]"
          />

          <Button
            type="button"
            variant="icon"
            size="icon"
            icon="LogOut"
            loading={isSigningOut}
            disabled={isSigningOut}
            onClick={signOut}
            title="Sign out"
            aria-label="Sign out"
            className="h-6 w-6 border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--danger)] hover:text-[var(--danger)]"
          />
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
