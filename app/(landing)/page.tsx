import { MainLayout } from '@/components/layout/MainLayout';
import { Features } from '@/components/sections/Features';
import { Hero } from '@/components/sections/Hero';
import { LandingAbout } from '@/components/sections/LandingAbout';
import { SdkSection } from '@/components/sections/SdkSection';

export default function LandingPage() {
  return (
    <MainLayout>
      <Hero />
      <Features />
      <SdkSection />
      <LandingAbout />
    </MainLayout>
  );
}