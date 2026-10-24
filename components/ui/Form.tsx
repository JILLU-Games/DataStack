import { cn } from '@/lib/utils';
import React from 'react';

export const Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>> = ({
  className,
  children,
  ...props
}) => (
  <form className={cn('flex flex-col gap-5', className)} {...props}>
    {children}
  </form>
);

export const FormField: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('flex flex-col gap-2 w-full', className)} {...props}>
    {children}
  </div>
);

export const FormRow: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('grid grid-cols-1 sm:grid-cols-2 gap-4 w-full', className)} {...props}>
    {children}
  </div>
);

export const FormSwitch: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
}> = ({ label, checked, onChange, description, disabled = false }) => (
  <label
    className={cn(
      'flex items-center justify-between gap-4 p-4 border border-[var(--border)] bg-[var(--bg-main)] cursor-pointer select-none transition-colors hover:bg-[var(--bg-hover)]',
      disabled && 'opacity-50 cursor-not-allowed'
    )}
  >
    <div className="flex flex-col">
      <span className="text-[14px] font-medium text-[var(--text)]">{label}</span>
      {description && <span className="text-[12px] text-[var(--text-muted)]">{description}</span>}
    </div>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="w-5 h-5 accent-[var(--accent)] cursor-pointer shrink-0"
    />
  </label>
);

export default Form;
