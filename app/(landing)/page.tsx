import { MainLayout } from '@/components/layout/MainLayout';
import { Features } from '@/components/sections/Features';
import { Hero } from '@/components/sections/Hero';
import { LandingAbout } from '@/components/sections/LandingAbout';
import { SdkSection } from '@/components/sections/SdkSection';
import { isAdminSetupComplete } from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
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
    // Keep public landing accessible on transient DB outage instead of redirecting to setup
  }

  return (
    <MainLayout>
      <Hero />
      <Features />
      <SdkSection />
      <LandingAbout />
    </MainLayout>
  );
}
