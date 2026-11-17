import { ActivityPreview } from '@/components/ui/ActivityPreview';
import { buttonClassNames } from '@/components/ui/Button';
import Link from 'next/link';
import React from 'react';

export const Hero: React.FC = () => (
  <section aria-labelledby="hero-title" className="border-b border-[var(--border)] py-10 sm:py-14">
    <span className="mb-5 inline-flex items-center gap-2 border border-[var(--border-strong)] px-2.5 py-1 text-[11px] uppercase text-[var(--text-muted)]">
      <span className="h-1.5 w-1.5 bg-[var(--accent)]" />
      Self-hosted event collection
    </span>
    <h1 id="hero-title" className="mb-4 max-w-[640px] text-[28px] font-medium leading-tight text-[var(--text)] sm:text-[36px]">
      Realtime data collection,<br />
      <span className="text-[var(--text-muted)]">without the operational clutter.</span>
    </h1>
    <p className="mb-6 max-w-[520px] text-[15px] leading-relaxed text-[var(--text-muted)]">
      Keep activity organized, review the records that matter, and export them when you need them.
    </p>
    <div className="flex flex-wrap gap-2">
      <Link href="/#features" className={buttonClassNames({ variant: 'primary', size: 'sm' })}>
        Explore features
      </Link>
      <Link href="/#sdk" className={buttonClassNames({ variant: 'secondary', size: 'sm' })}>
        Python SDK
      </Link>
    </div>
    <ActivityPreview />
  </section>
);

export default Hero;
