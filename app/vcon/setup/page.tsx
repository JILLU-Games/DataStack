import { AdminSetup } from '@/components/sections/AdminSetup';
import { isAdminSetupComplete } from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  let databaseReady = true;
  try {
    if (await isAdminSetupComplete()) redirect('/vcon/login');
  } catch {
    databaseReady = false;
  }

  return (
    <AdminSetup
      databaseReady={databaseReady}
      initialEmail={process.env.DATASTACK_ADMIN_EMAIL?.trim().toLowerCase() ?? ''}
    />
  );
}
