import { MainLayout } from '@/components/layout/MainLayout';
import { Features } from '@/components/sections/Features';
import { Hero } from '@/components/sections/Hero';
import { LandingAbout } from '@/components/sections/LandingAbout';
import { SdkSection } from '@/components/sections/SdkSection';
import { isAdminSetupComplete } from '@/core/auth/adminUsers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const isConfigured = await isAdminSetupComplete().catch(() => false);
  if (!isConfigured) redirect('/vcon/setup');

  return (
    <MainLayout>
      <Hero />
      <Features />
      <SdkSection />
      <LandingAbout />
    </MainLayout>
  );
}
