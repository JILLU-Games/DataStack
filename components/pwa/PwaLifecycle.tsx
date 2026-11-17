'use client';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import React, { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <Button
        type="button"
        size="xs"
        variant="secondary"
        icon="Download"
        onClick={() => void install()}
      >
        Install
      </Button>
    );
  }

  if (isIOS) {
    return (
      <>
        <Button
          type="button"
          size="xs"
          variant="secondary"
          icon="Download"
          onClick={() => setShowIOSGuide(true)}
        >
          Install
        </Button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-sm border border-[var(--border-strong)] bg-[var(--surface)] p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-medium text-[var(--text)]">
                  Install DataStack on iOS
                </h3>
                <button
                  type="button"
                  aria-label="Close install instructions"
                  onClick={() => setShowIOSGuide(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  <Icon name="X" size={14} />
                </button>
              </div>
              <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                1. Tap the <strong className="text-[var(--text)]">Share</strong> icon in Safari.
                <br />
                2. Select <strong className="text-[var(--text)]">Add to Home Screen</strong>.
              </p>
              <div className="mt-4 flex justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="primary"
                  onClick={() => setShowIOSGuide(false)}
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const PwaLifecycle: React.FC = () => {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Non-fatal in environments without SW origin permissions
      });
    }

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 border border-[var(--warning)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-mono text-[var(--text)]"
    >
      <Icon name="WifiOff" size={12} className="text-[var(--warning)]" />
      <span>Offline mode — cached shell active</span>
    </div>
  );
};

export default PwaLifecycle;
