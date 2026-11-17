import { AdminLogin } from '@/components/sections/AdminLogin';
import { isAdminSetupComplete } from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const isConfigured = await isAdminSetupComplete().catch(() => false);
  if (!isConfigured) redirect('/vcon/setup');

  const showDemoHint =
    !process.env.DATABASE_URL &&
    process.env.NODE_ENV !== 'production' &&
    process.env.DATASTACK_ALLOW_DEMO_ADMIN !== 'false';

  return <AdminLogin showDemoHint={showDemoHint} />;
}
