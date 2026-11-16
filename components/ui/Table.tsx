import { cn } from '@/lib/utils';
import React from 'react';

export const TableWrap: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'w-full overflow-x-auto border border-[var(--border)] bg-[var(--surface)]',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  className,
  children,
  ...props
}) => (
  <table
    className={cn(
      'w-full min-w-[640px] border-collapse text-left text-[11.5px] whitespace-nowrap',
      className
    )}
    {...props}
  >
    {children}
  </table>
);

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className,
  children,
  ...props
}) => (
  <thead
    className={cn(
      'border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]',
      className
    )}
    {...props}
  >
    {children}
  </thead>
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className,
  children,
  ...props
}) => <tbody className={cn('divide-y divide-[var(--border)]', className)} {...props}>{children}</tbody>;

export const TableRow: React.FC<React.HTMLAttributes<HTMLTableRowElement>> = ({
  className,
  children,
  ...props
}) => (
  <tr
    className={cn(
      'text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]',
      className
    )}
    {...props}
  >
    {children}
  </tr>
);

export const TableHead: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({
  className,
  children,
  ...props
}) => (
  <th className={cn('px-3 py-1.5 font-medium', className)} {...props}>
    {children}
  </th>
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({
  className,
  children,
  ...props
}) => (
  <td className={cn('px-3 py-1.5 align-middle text-[var(--text-muted)]', className)} {...props}>
    {children}
  </td>
);

export const TableEmpty: React.FC<{ colSpan: number; message?: string }> = ({
  colSpan,
  message = 'No data',
}) => (
  <tr>
    <td
      colSpan={colSpan}
      className="px-3 py-6 text-center text-[11.5px] text-[var(--text-dim)]"
    >
      {message}
    </td>
  </tr>
);

export default Table;
