import { VconShell } from '@/components/layout/VconShell';
import { verifyRequestAdminSession } from '@/core/auth/adminUsers';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import React from 'react';

export const dynamic = 'force-dynamic';

export default async function VconLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const pathname = headerList.get('x-datastack-pathname') || '';

  if (pathname === '/vcon/login' || pathname === '/vcon/setup') {
    return <>{children}</>;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get('datastack_admin_session')?.value;
  const auth = await verifyRequestAdminSession(token);

  if (!auth.valid) {
    if (auth.reason === 'UNAUTHORIZED') {
      const loginTarget = pathname
        ? `/vcon/login?next=${encodeURIComponent(pathname)}`
        : '/vcon/login';
      redirect(loginTarget);
    }

    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--bg)] p-4 text-[var(--text)]">
        <section className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5">
          <h1 className="text-[13px] font-medium text-[var(--text)]">
            Console authentication unavailable
          </h1>
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            {auth.reason === 'UNCONFIGURED'
              ? 'Admin session secret is not configured.'
              : 'Database authentication check is temporarily unavailable. Please retry shortly.'}
          </p>
        </section>
      </main>
    );
  }

  return <VconShell>{children}</VconShell>;
}
