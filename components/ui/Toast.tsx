'use client';

import { cn } from '@/lib/utils';
import React, { createContext, useCallback, useContext, useState } from 'react';
import { Icon } from './Icon';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextType {
  toast: (options: Omit<ToastMessage, 'id'>) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    ({ type = 'info', title, message, duration = 3500 }: Omit<ToastMessage, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      setToasts((prev) => [...prev, { id, type, title, message, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
    },
    [removeToast]
  );

  const success = useCallback((title: string, message?: string) => addToast({ type: 'success', title, message }), [addToast]);
  const error = useCallback((title: string, message?: string) => addToast({ type: 'error', title, message }), [addToast]);
  const warning = useCallback((title: string, message?: string) => addToast({ type: 'warning', title, message }), [addToast]);
  const info = useCallback((title: string, message?: string) => addToast({ type: 'info', title, message }), [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error, warning, info }}>
      {children}
      <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 z-[9999] flex flex-col gap-2 max-w-[420px] pointer-events-none">
        {toasts.map((t) => {
          const typeBorder = {
            success: 'border-l-[3px] border-l-[var(--success)]',
            error: 'border-l-[3px] border-l-[var(--danger)]',
            warning: 'border-l-[3px] border-l-[var(--warning)]',
            info: 'border-l-[3px] border-l-[var(--accent)]',
          }[t.type];

          const typeIcon = {
            success: 'CheckCircle2',
            error: 'AlertCircle',
            warning: 'AlertTriangle',
            info: 'Info',
          }[t.type];

          const iconColor = {
            success: 'var(--success)',
            error: 'var(--danger)',
            warning: 'var(--warning)',
            info: 'var(--accent)',
          }[t.type];

          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex items-start gap-3 p-4 bg-[var(--bg-elevated)] border border-[var(--border-strong)] text-[var(--text)] text-[13px] transition-all',
                typeBorder
              )}
            >
              <div className="mt-0.5 shrink-0">
                <Icon name={typeIcon} size={17} color={iconColor} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[var(--text)] leading-tight">{t.title}</div>
                {t.message && (
                  <div className="text-[12px] text-[var(--text-muted)] mt-1 leading-normal break-words">
                    {t.message}
                  </div>
                )}
              </div>
              <button
                onClick={() => removeToast(t.id)}
                className="shrink-0 text-[var(--text-dim)] hover:text-[var(--text)] p-0.5 cursor-pointer"
                aria-label="Dismiss toast"
              >
                <Icon name="X" size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

export default ToastProvider;
