import React from 'react';
import { Icon } from './Icon';

interface FeatureItemProps {
  icon: string;
  title: string;
  description: string;
}

export const FeatureItem: React.FC<FeatureItemProps> = ({ icon, title, description }) => (
  <article className="min-h-full bg-[var(--surface)] p-5">
    <div className="mb-3 grid h-[22px] w-[22px] place-items-center border border-[var(--border-strong)] text-[var(--accent)]">
      <Icon name={icon} size={13} />
    </div>
    <h3 className="mb-1 text-[13px] font-medium text-[var(--text)]">{title}</h3>
    <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">{description}</p>
  </article>
);

export default FeatureItem;
