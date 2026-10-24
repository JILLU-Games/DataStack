import { cn } from '@/lib/utils';
import React from 'react';

interface TextProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'span' | 'label' | 'code' | 'div';
  variant?: 'h1' | 'h2' | 'h3' | 'body' | 'muted' | 'dim' | 'label' | 'code' | 'badge';
  children: React.ReactNode;
}

export const Text: React.FC<TextProps> = ({
  as: Component = 'p',
  variant = 'body',
  className,
  children,
  ...props
}) => {
  const variantStyles = {
    h1: 'text-[24px] font-semibold text-[var(--text)]',
    h2: 'text-[20px] font-semibold text-[var(--text)]',
    h3: 'text-[17px] font-medium text-[var(--text)]',
    body: 'text-[14px] font-normal text-[var(--text)]',
    muted: 'text-[13px] font-normal text-[var(--text-muted)]',
    dim: 'text-[12px] font-normal text-[var(--text-dim)]',
    label: 'text-[12px] font-medium uppercase text-[var(--text-muted)]',
    code: 'text-[12px] font-mono text-[var(--accent)] bg-[var(--bg-hover)] px-2 py-1 border border-[var(--border)]',
    badge: 'text-[11.5px] font-medium px-2 py-1 border border-[var(--border)] text-[var(--text-muted)] inline-flex items-center gap-1',
  };

  return (
    <Component
      className={cn(variantStyles[variant], className)}
      {...props}
    >
      {children}
    </Component>
  );
};

export default Text;
