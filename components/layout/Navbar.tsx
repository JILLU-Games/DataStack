'use client';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
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
    const initial = saved || 'dark';
    setTheme(initial);
    if (initial === 'light') {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    }
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('datastack-theme', nextTheme);
    if (nextTheme === 'light') {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    }
  };

  const isVcon = pathname?.startsWith('/vcon');

  return (
    <header className="h-14 shrink-0 bg-[var(--bg-activity)] border-b border-[var(--border)] px-4 sm:px-6 flex items-center justify-between gap-3 z-40 select-none">
      {/* Left: Mobile hamburger + Brand */}
      <div className="flex items-center gap-3 min-w-0">
        {showSidebarToggle && (
          <button
            onClick={onToggleSidebar}
            className="lg:hidden w-9 h-9 shrink-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] bg-[var(--bg-elevated)] cursor-pointer"
            aria-label="Toggle Navigation"
          >
            <Icon name="Menu" size={13} />
          </button>
        )}

        <Link href="/" className="flex items-center gap-2 min-w-0 text-[14px] font-medium">
          <span className="grid h-4 w-4 shrink-0 place-items-center bg-[var(--accent)]">
            <span className="h-1.5 w-1.5 bg-[var(--bg)]" />
          </span>
          <span className="truncate text-[var(--text)]">
            DataStack
          </span>
          {isVcon && (
            <span className="hidden lg:inline text-[11px] text-[var(--text-dim)] font-mono border border-[var(--border)] px-1.5 py-1">
              v2.4
            </span>
          )}
        </Link>
      </div>

      {/* Middle: Links */}
      <nav className="hidden sm:flex items-center gap-6 text-[13px]">
        {isVcon ? (
          <>
            <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)]">
              Overview
            </Link>
            <Link
              href="/vcon/dashboard"
              className="px-3 py-2 transition-colors border-b-2 flex items-center gap-2 border-[var(--accent)] text-[var(--text)] font-medium"
            >
              <span>Admin Console</span>
              <span className="w-1.5 h-1.5 bg-[var(--success)] shrink-0" />
            </Link>
            <Link
              href="/vcon/export"
              className={`px-3 py-2 transition-colors border-b-2 ${
                pathname === '/vcon/export'
                  ? 'border-[var(--accent)] text-[var(--text)] font-medium'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              CSV Exporter
            </Link>
          </>
        ) : (
          <>
            <Link href="#features" className="text-[var(--text-muted)] hover:text-[var(--text)]">Features</Link>
            <Link href="#sdk" className="text-[var(--text-muted)] hover:text-[var(--text)]">SDK</Link>
            <Link href="#about" className="text-[var(--text-muted)] hover:text-[var(--text)]">About</Link>
          </>
        )}
      </nav>

      {/* Right: Admin runtime indicators or public feature action */}
      <div className="flex items-center gap-2 shrink-0">
        {isVcon && (
          <div className="hidden xl:flex items-center gap-2 text-[11px] text-[var(--text-dim)] font-mono border border-[var(--border)] px-2.5 py-1.5 bg-[var(--bg-main)]">
            <span className="w-1.5 h-1.5 bg-[var(--success)] inline-block" />
            <span>:4000</span>
            <span className="text-[var(--border-strong)]">|</span>
            <span className="w-1.5 h-1.5 bg-[var(--accent)] inline-block" />
            <span>:3000</span>
          </div>
        )}

        <button
          onClick={toggleTheme}
          aria-label="Toggle Theme"
          className="w-9 h-9 flex items-center justify-center border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
        >
          <Icon name={theme === 'dark' ? 'Sun' : 'Moon'} size={12} />
        </button>

        {!isVcon && (
          <Link href="#sdk">
            <Button size="sm" variant="primary">
              Read the SDK guide
            </Button>
          </Link>
        )}
      </div>
    </header>
  );
};

export default Navbar;
