import { AdminSetup } from '@/components/sections/AdminSetup';
import {
  isAdminSetupComplete,
  requiresPersistentAdminDatabase,
} from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  let databaseReady = true;
  let databaseError = '';
  let setupComplete = false;

  if (requiresPersistentAdminDatabase()) {
    databaseReady = false;
    databaseError =
      'PostgreSQL DATABASE_URL is required in production before creating an administrator account.';
  } else {
    try {
      setupComplete = await isAdminSetupComplete();
    } catch {
      databaseReady = false;
      databaseError = 'Database connection unavailable.';
    }
  }

  if (databaseReady && setupComplete) {
    redirect('/vcon/login');
  }

  return (
    <AdminSetup
      databaseReady={databaseReady}
      databaseError={databaseError}
      initialEmail={process.env.DATASTACK_ADMIN_EMAIL?.trim().toLowerCase() ?? ''}
    />
  );
}
