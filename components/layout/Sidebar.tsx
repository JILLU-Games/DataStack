'use client';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen = false,
  onClose,
}) => {
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  const navigation = [
    {
      group: 'Monitoring',
      items: [
        { name: 'Dashboard', href: '/vcon/dashboard', icon: 'LayoutDashboard' },
        { name: 'Live Data Sync', href: '/vcon/data', icon: 'Activity', badge: 'Live' },
      ],
    },
    {
      group: 'Data',
      items: [
        { name: 'CSV Exporter', href: '/vcon/export', icon: 'Download' },
        { name: 'CSV Storage & Disk', href: '/vcon/storage', icon: 'HardDrive' },
      ],
    },
    {
      group: 'Administration',
      items: [
        { name: 'Client SDKs', href: '/vcon/clients', icon: 'Key' },
        { name: 'Engine Settings', href: '/vcon/settings', icon: 'Sliders' },
      ],
    },
    {
      group: 'Developer Tools',
      items: [
        { name: 'Python SDK Guide', href: '/vcon/sdk', icon: 'FileCode2' },
        { name: 'Live Simulator', href: '/vcon/simulator', icon: 'Play' },
      ],
    },
  ];
  const activeGroup = navigation.find((section) =>
    section.items.some((item) => item.href === pathname)
  )?.group;
  const [openGroup, setOpenGroup] = useState(activeGroup ?? navigation[0].group);

  useEffect(() => {
    if (activeGroup) setOpenGroup(activeGroup);
  }, [activeGroup]);

  const signOut = async () => {
    setIsSigningOut(true);
    setSignOutError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Unable to sign out. Please try again.');
      router.replace('/vcon/login');
      router.refresh();
    } catch (error) {
      setSignOutError(
        error instanceof Error ? error.message : 'Unable to sign out. Please try again.',
      );
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-x-0 top-14 bottom-0 z-40 bg-black/50 lg:hidden"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={cn(
          'fixed left-0 top-14 bottom-0 z-50 w-[264px] shrink-0 overflow-hidden bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex flex-col transition-transform duration-150 ease-in-out lg:static lg:w-[264px] lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Top Header */}
        <div className="h-[52px] px-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-activity)] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 bg-[var(--accent)] shrink-0" />
            <span className="text-[12px] font-semibold text-[var(--text)] uppercase truncate">
              VCON ADMIN
            </span>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-[var(--text-dim)] hover:text-[var(--text)] p-1 cursor-pointer"
            aria-label="Close menu"
          >
            <Icon name="X" size={13} />
          </button>
        </div>

        {/* Navigation items */}
        <nav aria-label="Admin navigation" className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col">
          {navigation.map((section) => {
            const isExpanded = openGroup === section.group;
            const groupId = `nav-${section.group.toLowerCase().replaceAll(' ', '-')}`;

            return (
              <div key={section.group} className="border-b border-[var(--border)] last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={groupId}
                  onClick={() => setOpenGroup(isExpanded ? '' : section.group)}
                  className="w-full min-h-[42px] px-3 flex items-center justify-between gap-2 text-left text-[12px] font-medium text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer"
                >
                  <span className="truncate">{section.group}</span>
                  <Icon
                    name="ChevronDown"
                    size={12}
                    className={cn('transition-transform', isExpanded && 'rotate-180')}
                  />
                </button>
                {isExpanded && (
                      <div id={groupId} className="pb-1.5 flex flex-col gap-1">
                {section.items.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={cn(
                        'flex min-h-10 min-w-0 items-center justify-between gap-2 px-3 py-2 text-[13px] transition-colors border',
                        isActive
                          ? 'bg-[var(--accent-soft)] text-[var(--accent-hover)] font-medium border-[var(--accent)]'
                          : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]'
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon
                          name={item.icon}
                          size={16}
                          className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-dim)]'}
                        />
                        <span className="truncate">{item.name}</span>
                      </div>
                      {item.badge && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-[var(--success-soft)] text-[var(--success)] font-mono border border-[var(--success)] shrink-0">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer info */}
        <div className="p-3 border-t border-[var(--border)] bg-[var(--bg-main)] text-[11px] text-[var(--text-dim)] font-mono flex flex-col gap-1.5 shrink-0">
          <div className="flex items-center justify-between">
            <span>Buffer Worker</span>
            <span className="text-[var(--success)] flex items-center gap-1 font-semibold">
              <span className="w-1.5 h-1.5 bg-[var(--success)] inline-block" />
              Active
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Storage Engine</span>
            <span className="text-[var(--text-muted)]">json2csv</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Auth Handshake</span>
            <span className="text-[var(--text-muted)]">JWT</span>
          </div>
          {pathname !== '/vcon/setup' && (
            <>
              {signOutError && (
                <p role="alert" className="text-[var(--danger)]">{signOutError}</p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="LogOut"
                loading={isSigningOut}
                disabled={isSigningOut}
                onClick={signOut}
                className="mt-1 w-full justify-start px-2 text-[11px]"
              >
                Sign out
              </Button>
            </>
          )}
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
