'use client';

import { cn } from '@/lib/utils';
import React, { useState } from 'react';
import { Footer } from './Footer';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';

interface MainLayoutProps {
  children: React.ReactNode;
  showSidebar?: boolean;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  showSidebar = false,
}) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--bg-main)] text-[var(--text)] antialiased">
      <Navbar
        showSidebarToggle={showSidebar}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />

      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {showSidebar && (
          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        <main className="flex-1 min-h-0 overflow-y-auto flex flex-col min-w-0">
          <div className={cn(
            'flex-1 min-w-0 w-full mx-auto',
            showSidebar
              ? 'max-w-[1600px] px-4 py-4 sm:px-6 sm:py-6 xl:px-8 xl:py-7'
              : 'max-w-[var(--container-width)] px-6 py-0'
          )}>
            {children}
          </div>
          <Footer isAdmin={showSidebar} />
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
