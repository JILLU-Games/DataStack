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
        compact ? 'p-3' : 'p-4 sm:p-5',
        className
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
      'flex items-center justify-between gap-2 pb-2 mb-2 border-b border-[var(--border)]',
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
  <h3 className={cn('text-[12px] font-medium text-[var(--text)] leading-snug', className)} {...props}>
    {children}
  </h3>
);

export const CardDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  className,
  children,
  ...props
}) => (
  <p className={cn('text-[11.5px] text-[var(--text-muted)] leading-relaxed', className)} {...props}>
    {children}
  </p>
);

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('text-[12px]', className)} {...props}>
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
      'flex items-center justify-between gap-2 pt-2 mt-2 border-t border-[var(--border)] text-[11.5px]',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export default Card;
