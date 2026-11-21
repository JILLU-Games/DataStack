'use client';

import { PWAInstallButton } from '@/components/pwa/PwaLifecycle';
import { Button, buttonClassNames } from '@/components/ui/Button';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useEffect, useState } from 'react';

interface NavbarProps {
  onToggleSidebar?: () => void;
  showSidebarToggle?: boolean;
}

const VCON_LABELS: Record<string, string> = {
  '/vcon/dashboard': 'Dashboard',
  '/vcon/data': 'Events',
  '/vcon/clients': 'Clients',
  '/vcon/export': 'Export',
  '/vcon/storage': 'Storage',
  '/vcon/files': 'Files Manager',
  '/vcon/sdk': 'Client SDKs',
  '/vcon/simulator': 'Simulator',
  '/vcon/team': 'Team & RBAC',
  '/vcon/audit': 'Audit Log',
  '/vcon/profile': 'Profile',
  '/vcon/settings': 'Settings',
};

export const Navbar: React.FC<NavbarProps> = ({
  onToggleSidebar,
  showSidebarToggle = false,
}) => {
  const pathname = usePathname();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = localStorage.getItem('datastack-theme') as 'dark' | 'light' | null;
    const initial = saved === 'light' ? 'light' : 'dark';
    setTheme(initial);
    document.documentElement.classList.toggle('light', initial === 'light');
    document.documentElement.classList.toggle('dark', initial === 'dark');
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('datastack-theme', nextTheme);
    document.documentElement.classList.toggle('light', nextTheme === 'light');
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  const isVcon = pathname?.startsWith('/vcon');
  const currentSectionLabel = (pathname && VCON_LABELS[pathname]) || 'Console';

  if (showSidebarToggle && isVcon) {
    return (
      <header className="sticky top-0 z-30 flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 select-none md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="icon"
            size="icon"
            icon="Menu"
            onClick={onToggleSidebar}
            className="h-6.5 w-6.5 shrink-0 border border-[var(--border)] bg-[var(--surface-2)]"
            aria-label="Toggle Navigation"
            title="Toggle Navigation"
          />
          <span className="truncate text-[12px] font-medium text-[var(--text)]">
            {currentSectionLabel}
          </span>
        </div>

        <Button
          type="button"
          variant="icon"
          size="icon"
          icon={theme === 'dark' ? 'Sun' : 'Moon'}
          onClick={toggleTheme}
          aria-label="Toggle Theme"
          title="Toggle Theme"
          className="h-6.5 w-6.5 border border-[var(--border)] bg-[var(--surface-2)]"
        />
      </header>
    );
  }

  return (
    <header className="h-11 shrink-0 bg-[var(--bg-activity)] border-b border-[var(--border)] px-3.5 sm:px-5 flex items-center justify-between gap-4 z-40 select-none">
      <div className="flex items-center gap-2.5 min-w-0">
        <Link href="/" className="flex items-center gap-1.5 min-w-0 text-[13px] font-medium whitespace-nowrap shrink-0">
          <span className="grid h-3.5 w-3.5 shrink-0 place-items-center bg-[var(--accent)]">
            <span className="h-1.5 w-1.5 bg-[var(--bg)]" />
          </span>
          <span className="truncate text-[var(--text)]">
            DataStack
          </span>
        </Link>
      </div>

      <nav className="hidden sm:flex items-center gap-5 text-[12px]">
        <Link href="/#features" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">Features</Link>
        <Link href="/#sdk" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">SDK</Link>
        <Link href="/#about" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">About</Link>
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        <PWAInstallButton />

        <Button
          type="button"
          variant="icon"
          size="icon"
          icon={theme === 'dark' ? 'Sun' : 'Moon'}
          onClick={toggleTheme}
          aria-label="Toggle Theme"
          title="Toggle Theme"
          className="h-7 w-7 border border-[var(--border)] bg-[var(--bg-elevated)]"
        />

        <Link
          href="/vcon/dashboard"
          className={buttonClassNames({ size: 'xs', variant: 'primary' })}
        >
          Console
        </Link>
      </div>
    </header>
  );
};

export default Navbar;
