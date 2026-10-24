import { cn } from '@/lib/utils';
import React, { useEffect } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg';
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
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
    xs: 'max-w-[440px]',
    sm: 'max-w-[480px]',
    md: 'max-w-[640px]',
    lg: 'max-w-[800px]',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60">
      <div
        className={cn(
          'w-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] text-[var(--text)] flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(88dvh,800px)] overflow-hidden animate-in fade-in zoom-in-95 duration-150',
          maxWidthStyles[maxWidth]
        )}
      >
        <div className="flex items-start justify-between gap-4 p-4 sm:px-6 sm:py-5 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold text-[var(--text)] leading-snug">{title}</h2>
            {description && (
              <p className="text-[13px] text-[var(--text-muted)] mt-1.5">{description}</p>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="Close dialog"
            className="w-9 h-9 text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            <Icon name="X" size={14} />
          </Button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 text-[14px] flex flex-col gap-4">
          {children}
        </div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 p-4 sm:px-6 border-t border-[var(--border)] bg-[var(--bg-sidebar)] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
