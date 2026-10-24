'use client';

import { MainLayout } from '@/components/layout/MainLayout';
import { usePathname } from 'next/navigation';
import React from 'react';

export default function VconLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/vcon/login') return <>{children}</>;

  return <MainLayout showSidebar={true}>{children}</MainLayout>;
}
