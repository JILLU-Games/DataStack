'use client';

import { Button } from '@/components/ui/Button';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

export default function RootErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error boundary:', error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg-main)] px-4 py-8 text-[var(--text)]">
      <section className="w-full max-w-[440px] border border-[var(--border-strong)] bg-[var(--surface)] p-5">
        <div className="mb-3 flex items-center gap-2 border-b border-[var(--border)] pb-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
          <h1 className="text-[13px] font-medium uppercase tracking-wider text-[var(--text)]">
            Runtime error
          </h1>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
          An unexpected rendering error occurred. You can retry the view or return to the overview page.
        </p>
        {error?.message && (
          <div className="mb-4 border border-[var(--border)] bg-[var(--bg-main)] px-2.5 py-2 font-mono text-[11px] text-[var(--danger)] break-words">
            {error.message}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
          <Link href="/">
            <Button type="button" size="xs" variant="ghost">
              Return home
            </Button>
          </Link>
          <Button type="button" size="xs" variant="primary" onClick={() => reset()}>
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Try again
          </Button>
        </div>
      </section>
    </main>
  );
}
