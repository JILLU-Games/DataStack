import React from 'react';

interface CodeBlockProps {
  children: React.ReactNode;
  className?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ children, className = '' }) => (
  <pre className={`overflow-x-auto bg-[var(--surface)] p-4 font-mono text-[12px] leading-relaxed text-[var(--text-muted)] ${className}`}>
    <code>{children}</code>
  </pre>
);

export default CodeBlock;
