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
        { name: 'Events', href: '/vcon/data', icon: 'Activity' },
      ],
    },
    {
      group: 'Data',
      items: [
        { name: 'Export', href: '/vcon/export', icon: 'Download' },
        { name: 'Storage', href: '/vcon/storage', icon: 'HardDrive' },
      ],
    },
    {
      group: 'Administration',
      items: [
        { name: 'Clients', href: '/vcon/clients', icon: 'Key' },
        { name: 'Settings', href: '/vcon/settings', icon: 'Sliders' },
      ],
    },
    {
      group: 'Tools',
      items: [
        { name: 'Python SDK', href: '/vcon/sdk', icon: 'FileCode2' },
        { name: 'Simulator', href: '/vcon/simulator', icon: 'Play' },
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
          className="fixed inset-x-0 top-11 bottom-0 z-40 bg-black/50 lg:hidden"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={cn(
          'fixed left-0 top-11 bottom-0 z-50 w-[216px] shrink-0 overflow-hidden bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex flex-col transition-transform duration-150 ease-in-out lg:static lg:w-[216px] lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Mobile Close Header */}
        <div className="h-9 px-3 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-activity)] shrink-0 lg:hidden">
          <span className="text-[11px] font-medium text-[var(--text-muted)]">Menu</span>
          <button
            onClick={onClose}
            className="text-[var(--text-dim)] hover:text-[var(--text)] p-1 cursor-pointer"
            aria-label="Close menu"
          >
            <Icon name="X" size={12} />
          </button>
        </div>

        {/* Navigation items */}
        <nav aria-label="Admin navigation" className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col">
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
                  className="w-full h-8 px-2.5 flex items-center justify-between gap-2 text-left text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer"
                >
                  <span className="truncate">{section.group}</span>
                  <Icon
                    name="ChevronDown"
                    size={11}
                    className={cn('transition-transform', isExpanded && 'rotate-180')}
                  />
                </button>
                {isExpanded && (
                  <div id={groupId} className="pb-1 flex flex-col gap-0.5">
                    {section.items.map((item) => {
                      const isActive = pathname === item.href;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={onClose}
                          className={cn(
                            'flex h-8 min-w-0 items-center gap-2 px-2.5 text-[12px] transition-colors border',
                            isActive
                              ? 'bg-[var(--accent-soft)] text-[var(--accent-hover)] font-medium border-[var(--accent)]'
                              : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]'
                          )}
                        >
                          <Icon
                            name={item.icon}
                            size={13}
                            className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-dim)]'}
                          />
                          <span className="truncate">{item.name}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Sign out action */}
        {pathname !== '/vcon/setup' && (
          <div className="p-1.5 border-t border-[var(--border)] bg-[var(--bg-main)] shrink-0">
            {signOutError && (
              <p role="alert" className="px-2 pb-1 text-[11px] text-[var(--danger)]">{signOutError}</p>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="LogOut"
              loading={isSigningOut}
              disabled={isSigningOut}
              onClick={signOut}
              className="w-full justify-start px-2.5 text-[11.5px] h-7"
            >
              Sign out
            </Button>
          </div>
        )}
      </aside>
    </>
  );
};

export default Sidebar;
