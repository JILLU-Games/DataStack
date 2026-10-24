import { FeatureItem } from '@/components/ui/FeatureItem';
import { SectionHeading } from '@/components/ui/SectionHeading';
import React from 'react';

export const Features: React.FC = () => {
  const items = [
    { icon: 'Activity', title: 'Realtime over WebSocket', description: 'Durable connections. No polling or repeated API calls.' },
    { icon: 'HardDrive', title: 'CSV-first storage', description: 'Compact per-day records that stay simple to export.' },
    { icon: 'ShieldCheck', title: 'Verified sources', description: 'Each registered client is checked before sending activity.' },
    { icon: 'Layers3', title: 'Buffered writes', description: 'Batch incoming events to keep collection steady.' },
    { icon: 'ChartNoAxesCombined', title: 'Live dashboard', description: 'Watch activity arrive and filter by source or content.' },
    { icon: 'Download', title: 'One-click export', description: 'Download the records you need without blocking the workflow.' },
  ];

  return (
    <section id="features" className="border-b border-[var(--border)] py-10">
      <SectionHeading index="01" label="Features" title="Built for ingestion at scale." />
      <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <FeatureItem key={item.title} {...item} />
        ))}
      </div>
    </section>
  );
};

export default Features;
