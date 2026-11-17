import { AdminLogin } from '@/components/sections/AdminLogin';
import { isAdminSetupComplete } from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (process.env.DATABASE_URL) {
    const isConfigured = await isAdminSetupComplete().catch(() => false);
    if (!isConfigured) redirect('/vcon/setup');
  }

  const showDemoHint = !process.env.DATABASE_URL && process.env.NODE_ENV !== 'production';

  return <AdminLogin showDemoHint={showDemoHint} />;
}
