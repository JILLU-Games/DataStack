import React from 'react';

interface SectionHeadingProps {
  index: string;
  label: string;
  title: string;
}

export const SectionHeading: React.FC<SectionHeadingProps> = ({ index, label, title }) => (
  <div className="mb-5 flex items-baseline justify-between gap-4">
    <h2 className="text-[16px] font-medium text-[var(--text)]">{title}</h2>
    <span className="shrink-0 text-[11px] uppercase text-[var(--text-faint)]">
      {index} / {label}
    </span>
  </div>
);

export default SectionHeading;
