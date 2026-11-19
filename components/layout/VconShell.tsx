'use client';

import { MainLayout } from '@/components/layout/MainLayout';
import React from 'react';

export function VconShell({ children }: { children: React.ReactNode }) {
  return <MainLayout showSidebar={true}>{children}</MainLayout>;
}
