'use client';

import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useEffect, useState } from 'react';

interface NavbarProps {
  onToggleSidebar?: () => void;
  showSidebarToggle?: boolean;
}

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

  return (
    <header className="h-11 shrink-0 bg-[var(--bg-activity)] border-b border-[var(--border)] px-3.5 sm:px-5 flex items-center justify-between gap-4 z-40 select-none">
      {/* Left: Mobile hamburger + Brand */}
      <div className="flex items-center gap-2.5 min-w-0">
        {showSidebarToggle && (
          <Button
            type="button"
            variant="icon"
            size="icon"
            icon="Menu"
            onClick={onToggleSidebar}
            className="lg:hidden h-7 w-7 shrink-0 border border-[var(--border)] bg-[var(--bg-elevated)]"
            aria-label="Toggle Navigation"
            title="Toggle Navigation"
          />
        )}

        <Link href="/" className="flex items-center gap-1.5 min-w-0 text-[13px] font-medium whitespace-nowrap shrink-0">
          <span className="grid h-3.5 w-3.5 shrink-0 place-items-center bg-[var(--accent)]">
            <span className="h-1.5 w-1.5 bg-[var(--bg)]" />
          </span>
          <span className="truncate text-[var(--text)]">
            DataStack
          </span>
        </Link>
      </div>

      {/* Middle: Links */}
      <nav className="hidden sm:flex items-center gap-5 text-[12px]">
        {isVcon ? (
          <>
            <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">
              Overview
            </Link>
            <Link
              href="/vcon/dashboard"
              className={`px-2 py-1.5 transition-colors border-b-2 whitespace-nowrap shrink-0 ${
                pathname !== '/vcon/export'
                  ? 'border-[var(--accent)] text-[var(--text)] font-medium'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              Console
            </Link>
            <Link
              href="/vcon/export"
              className={`px-2 py-1.5 transition-colors border-b-2 whitespace-nowrap shrink-0 ${
                pathname === '/vcon/export'
                  ? 'border-[var(--accent)] text-[var(--text)] font-medium'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              Export
            </Link>
          </>
        ) : (
          <>
            <Link href="#features" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">Features</Link>
            <Link href="#sdk" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">SDK</Link>
            <Link href="#about" className="text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap shrink-0">About</Link>
          </>
        )}
      </nav>

      {/* Right: Theme switcher or public CTA */}
      <div className="flex items-center gap-2 shrink-0">
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

        {!isVcon && (
          <Link href="#sdk">
            <Button size="xs" variant="primary">
              SDK Guide
            </Button>
          </Link>
        )}
      </div>
    </header>
  );
};

export default Navbar;
