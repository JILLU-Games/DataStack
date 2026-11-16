import Link from 'next/link';
import React from 'react';

interface FooterProps {
  isAdmin?: boolean;
}

export const Footer: React.FC<FooterProps> = ({ isAdmin = false }) => {
  if (isAdmin) return null;

  return (
    <footer className="shrink-0 min-h-9 bg-[var(--bg-activity)] border-t border-[var(--border)] px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-dim)] select-none">
      <span>DataStack</span>
      <nav aria-label="Footer navigation" className="flex items-center gap-5">
        <Link href="#features" className="hover:text-[var(--text-muted)]">Features</Link>
        <Link href="#sdk" className="hover:text-[var(--text-muted)]">SDK</Link>
        <Link href="#about" className="hover:text-[var(--text-muted)]">About</Link>
      </nav>
    </footer>
  );
};

export default Footer;
