import { cn } from '@/lib/utils';
import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'subtle' | 'dashed' | 'active';
  compact?: boolean;
}

export const Card: React.FC<CardProps> = ({
  children,
  variant = 'default',
  compact = false,
  className,
  ...props
}) => {
  const variantStyles = {
    default: 'bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text)]',
    subtle: 'bg-[var(--bg-main)] border border-[var(--border)] text-[var(--text)]',
    dashed: 'bg-[var(--bg-main)] border border-dashed border-[var(--border-strong)] text-[var(--text)]',
    active: 'bg-[var(--accent-soft)] border border-[var(--accent)] text-[var(--text)]',
  };

  return (
    <div
      className={cn(
        'transition-colors',
        variantStyles[variant],
        className,
        compact ? 'p-4' : 'p-5 sm:p-6'
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'flex items-center justify-between gap-3 pb-3 mb-3 border-b border-[var(--border)]',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
  className,
  children,
  ...props
}) => (
  <h3 className={cn('text-[15px] font-semibold text-[var(--text)] leading-snug', className)} {...props}>
    {children}
  </h3>
);

export const CardDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  className,
  children,
  ...props
}) => (
  <p className={cn('text-[13px] text-[var(--text-muted)] leading-relaxed', className)} {...props}>
    {children}
  </p>
);

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('text-[14px]', className)} {...props}>
    {children}
  </div>
);

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'flex items-center justify-between gap-3 pt-3 mt-3 border-t border-[var(--border)] text-[13px]',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export default Card;
