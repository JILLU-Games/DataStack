import { AdminLogin } from '@/components/sections/AdminLogin';
import {
  isAdminSetupComplete,
  verifyRequestAdminSession,
} from '@/core/auth/adminUsers';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  let databaseReady = true;
  try {
    const isConfigured = await isAdminSetupComplete();
    if (!isConfigured) redirect('/vcon/setup');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'digest' in error &&
      String((error as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT')
    ) {
      throw error;
    }
    databaseReady = false;
  }

  if (databaseReady) {
    const cookieStore = await cookies();
    const token = cookieStore.get('datastack_admin_session')?.value;
    if (token) {
      const auth = await verifyRequestAdminSession(token);
      if (auth.valid) {
        redirect('/vcon/dashboard');
      }
    }
  }

  const showDemoHint =
    !process.env.DATABASE_URL &&
    process.env.NODE_ENV !== 'production' &&
    process.env.DATASTACK_ALLOW_DEMO_ADMIN !== 'false';

  return <AdminLogin showDemoHint={showDemoHint} databaseReady={databaseReady} />;
}
