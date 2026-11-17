import { MainLayout } from '@/components/layout/MainLayout';
import { buttonClassNames } from '@/components/ui/Button';
import Link from 'next/link';

export default function NotFound() {
  return (
    <MainLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-3">
        <h1 className="text-[28px] font-semibold text-[var(--text)] font-mono">404</h1>
        <p className="text-[13px] text-[var(--text-muted)] max-w-[400px]">
          The requested page or route does not exist on DataStack.
        </p>
        <div className="flex items-center gap-2 pt-2">
          <Link href="/" className={buttonClassNames({ variant: 'primary', size: 'sm' })}>
            Return Home
          </Link>
          <Link href="/vcon/dashboard" className={buttonClassNames({ variant: 'secondary', size: 'sm' })}>
            Open Console
          </Link>
        </div>
      </div>
    </MainLayout>
  );
}
