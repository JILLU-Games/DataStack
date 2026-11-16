'use client';

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

  if (showSidebar) {
    return (
      <div className="min-h-dvh bg-[var(--bg-main)] text-[var(--text)] antialiased md:grid md:grid-cols-[184px_1fr]">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <div className="flex min-h-dvh min-w-0 flex-col">
          <Navbar
            showSidebarToggle={true}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          />
          <main className="flex flex-1 min-w-0 flex-col">
            <div className="w-full max-w-[var(--console-width)] flex-1 px-3.5 pb-4 pt-0 sm:px-5">
              {children}
            </div>
            <Footer isAdmin={true} />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--bg-main)] text-[var(--text)] antialiased">
      <Navbar showSidebarToggle={false} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 min-w-0 w-full mx-auto max-w-[var(--container-width)] px-6 py-0">
          {children}
        </div>
        <Footer isAdmin={false} />
      </main>
    </div>
  );
};

export default MainLayout;
