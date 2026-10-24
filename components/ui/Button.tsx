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
    const baseStyles =
      'inline-flex items-center justify-center font-normal transition-colors select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed border border-transparent whitespace-nowrap outline-none';

    const variantStyles = {
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
    };

    const sizeStyles = {
      default: 'min-h-10 px-4 text-[13.5px] gap-2',
      sm: 'h-9 px-3 text-[12.5px] gap-1.5',
      xs: 'h-8 px-2.5 text-[12px] gap-1.5',
      icon: 'w-9 h-9 p-0',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          baseStyles,
          variantStyles[variant],
          size === 'icon' ? sizeStyles.icon : sizeStyles[size],
          className
        )}
        {...props}
      >
        {loading ? (
          <Icon name="Loader2" size={size === 'sm' || size === 'xs' ? 12 : 14} className="animate-spin" />
        ) : (
          icon && iconPosition === 'left' && (
            <Icon name={icon} size={size === 'sm' || size === 'xs' ? 12 : 14} />
          )
        )}
        {children && <span>{children}</span>}
        {!loading && icon && iconPosition === 'right' && (
          <Icon name={icon} size={size === 'sm' || size === 'xs' ? 12 : 14} />
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
export default Button;
