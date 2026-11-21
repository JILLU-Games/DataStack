import { buttonClassNames } from '@/components/ui/Button';
import Link from 'next/link';
import React from 'react';

export const LandingAbout: React.FC = () => (
  <section id="about" className="flex flex-wrap items-center justify-between gap-6 py-10">
    <div>
      <h2 className="mb-1 text-[20px] font-medium text-[var(--text)]">Ready to simplify your data workflow?</h2>
      <p className="text-[13px] text-[var(--text-muted)]">Start with the SDK guide and make the workspace your own.</p>
    </div>
    <Link href="/#sdk" className={buttonClassNames({ variant: 'primary', size: 'sm' })}>
      View Client SDKs
    </Link>
  </section>
);

export default LandingAbout;
