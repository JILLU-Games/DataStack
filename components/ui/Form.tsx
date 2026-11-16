import { cn } from '@/lib/utils';
import React from 'react';

export const Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>> = ({
  className,
  children,
  ...props
}) => (
  <form className={cn('flex flex-col gap-3', className)} {...props}>
    {children}
  </form>
);

export const FormField: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('flex flex-col gap-1.5 w-full', className)} {...props}>
    {children}
  </div>
);

export const FormRow: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('grid grid-cols-1 sm:grid-cols-2 gap-3 w-full', className)} {...props}>
    {children}
  </div>
);

export const FormSwitch: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ label, checked, onChange, disabled = false }) => (
  <label
    className={cn(
      'flex items-center justify-between gap-3 px-2.5 py-1.5 border border-[var(--border)] bg-[var(--bg-main)] cursor-pointer select-none transition-colors hover:bg-[var(--bg-hover)]',
      disabled && 'opacity-50 cursor-not-allowed'
    )}
  >
    <span className="text-[11.5px] text-[var(--text)]">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="w-3.5 h-3.5 accent-[var(--accent)] cursor-pointer shrink-0"
    />
  </label>
);

export default Form;
