import { cn } from '@/lib/utils';
import React, { useEffect } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg';
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = 'md',
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const maxWidthStyles = {
    xs: 'max-w-[380px]',
    sm: 'max-w-[420px]',
    md: 'max-w-[540px]',
    lg: 'max-w-[680px]',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60">
      <div
        className={cn(
          'w-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] text-[var(--text)] flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(86dvh,720px)] overflow-hidden animate-in fade-in zoom-in-95 duration-150',
          maxWidthStyles[maxWidth]
        )}
      >
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-[var(--border)] shrink-0">
          <h2 className="text-[13px] font-medium text-[var(--text)] leading-snug truncate">{title}</h2>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="Close dialog"
            className="w-6.5 h-6.5 text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            <Icon name="X" size={12} />
          </Button>
        </div>

        <div className="p-3.5 overflow-y-auto flex-1 text-[12px] flex flex-col gap-3">
          {children}
        </div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-1.5 px-3.5 py-2 border-t border-[var(--border)] bg-[var(--bg-sidebar)] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
