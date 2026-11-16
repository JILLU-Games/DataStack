import { cn } from '@/lib/utils';
import React from 'react';

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children: React.ReactNode;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ children, className, ...props }) => (
  <pre
    className={cn(
      'overflow-x-auto bg-[var(--bg-main)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--text)]',
      className
    )}
    {...props}
  >
    <code>{children}</code>
  </pre>
);

export default CodeBlock;
