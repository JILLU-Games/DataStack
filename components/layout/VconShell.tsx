'use client';

import { MainLayout } from '@/components/layout/MainLayout';
import type { VconAdminRole } from '@/lib/vconUiHelpers';
import React, { createContext, useContext } from 'react';

const VconRoleContext = createContext<VconAdminRole>('owner');

export function useVconRole(): VconAdminRole {
  return useContext(VconRoleContext);
}

export function VconShell({
  role = 'owner',
  children,
}: {
  role?: VconAdminRole;
  children: React.ReactNode;
}) {
  return (
    <VconRoleContext.Provider value={role}>
      <MainLayout showSidebar={true}>{children}</MainLayout>
    </VconRoleContext.Provider>
  );
}
