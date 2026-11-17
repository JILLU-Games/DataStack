import { cn } from '@/lib/utils';
import React from 'react';
import { Icon } from './Icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
  size?: 'default' | 'sm' | 'xs' | 'icon';
  icon?: string;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
}

const BUTTON_BASE_STYLES =
  'inline-flex items-center justify-center font-normal transition-colors select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed border border-transparent whitespace-nowrap outline-none';

const BUTTON_VARIANT_STYLES = {
  primary:
    'bg-[var(--text)] text-[var(--bg)] hover:opacity-90 border-[var(--text)]',
  secondary:
    'bg-[var(--bg-elevated)] text-[var(--text)] border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
  ghost:
    'bg-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] border-transparent',
  danger:
    'bg-transparent text-[var(--danger)] border-[var(--danger)] hover:bg-[var(--danger-soft)]',
  icon:
    'bg-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] border-transparent p-0',
} as const;

const BUTTON_SIZE_STYLES = {
  default: 'min-h-8.5 px-3 text-[12px] gap-1.5',
  sm: 'h-7.5 px-2.5 text-[11.5px] gap-1.5',
  xs: 'h-7 px-2 text-[11px] gap-1',
  icon: 'w-7.5 h-7.5 p-0',
} as const;

export function buttonClassNames({
  variant = 'secondary',
  size = 'default',
  className,
}: {
  variant?: keyof typeof BUTTON_VARIANT_STYLES;
  size?: keyof typeof BUTTON_SIZE_STYLES;
  className?: string;
} = {}): string {
  return cn(
    BUTTON_BASE_STYLES,
    BUTTON_VARIANT_STYLES[variant],
    size === 'icon' ? BUTTON_SIZE_STYLES.icon : BUTTON_SIZE_STYLES[size],
    className
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      variant = 'secondary',
      size = 'default',
      icon,
      iconPosition = 'left',
      loading = false,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={buttonClassNames({ variant, size, className })}
        {...props}
      >
        {loading ? (
          <Icon name="Loader2" size={11} className="animate-spin" />
        ) : (
          icon && iconPosition === 'left' && (
            <Icon name={icon} size={11} />
          )
        )}
        {children && <span>{children}</span>}
        {!loading && icon && iconPosition === 'right' && (
          <Icon name={icon} size={11} />
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
export default Button;
