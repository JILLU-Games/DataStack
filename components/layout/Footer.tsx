import Link from 'next/link';
import React from 'react';

interface FooterProps {
  isAdmin?: boolean;
}

export const Footer: React.FC<FooterProps> = ({ isAdmin = false }) => {
  return (
    <footer className="shrink-0 min-h-10 bg-[var(--bg-activity)] border-t border-[var(--border)] px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-dim)] select-none">
      {isAdmin ? (
        <>
          <div className="flex items-center gap-1.5 truncate min-w-0 pr-2">
            <span className="font-semibold text-[var(--text-muted)] tracking-tight">DataStack</span>
            <span className="text-[var(--border-strong)]">/</span>
            <span className="hidden sm:inline font-mono text-[10px] truncate">
              storage/data/&#123;clientId&#125;/&#123;YYYY-MM-DD&#125;.csv
            </span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10.5px] shrink-0 ml-auto">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[var(--success)] inline-block" />
              <span className="text-[var(--text-muted)]">:4000</span>
            </span>
            <span className="text-[var(--border-strong)]">|</span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[var(--accent)] inline-block" />
              <span className="text-[var(--text-muted)]">:3000</span>
            </span>
          </div>
        </>
      ) : (
        <>
          <span>DataStack · Self-hosted</span>
          <nav aria-label="Footer navigation" className="flex items-center gap-5">
            <Link href="#features" className="hover:text-[var(--text-muted)]">Features</Link>
            <Link href="#sdk" className="hover:text-[var(--text-muted)]">SDK</Link>
            <Link href="#about" className="hover:text-[var(--text-muted)]">About</Link>
          </nav>
        </>
      )}
    </footer>
  );
};

export default Footer;
