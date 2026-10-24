import React from 'react';

const sampleRows = [
  { time: '14:28:01', source: 'Source A', payload: '{ metric: "temperature", value: 22.4 }', size: '42 B' },
  { time: '14:28:01', source: 'Source B', payload: '{ action: "package_received", count: 3 }', size: '38 B' },
  { time: '14:28:02', source: 'Source A', payload: '{ metric: "humidity", value: 61 }', size: '40 B' },
  { time: '14:28:02', source: 'Source C', payload: '{ status: "complete", duration_ms: 184 }', size: '44 B' },
];

export const ActivityPreview: React.FC = () => (
  <section aria-label="Example activity" className="mt-8 overflow-hidden border border-[var(--border)] bg-[var(--surface)]">
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        <span className="h-1.5 w-1.5 bg-[var(--accent)]" />
        Example activity
      </div>
      <span className="text-[11px] text-[var(--text-faint)]">Sample records</span>
    </div>
    <div className="divide-y divide-[var(--border)]">
      {sampleRows.map((row) => (
        <div
          key={`${row.time}-${row.source}-${row.payload}`}
          className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-x-3 px-3 py-2 font-mono text-[11px] sm:grid-cols-[5rem_6rem_minmax(0,1fr)_3.5rem] sm:px-4"
        >
          <span className="text-[var(--text-faint)]">{row.time}</span>
          <span className="hidden text-[var(--accent)] sm:block">{row.source}</span>
          <span className="truncate text-[var(--text)]">{row.payload}</span>
          <span className="text-right text-[var(--text-faint)]">{row.size}</span>
        </div>
      ))}
    </div>
  </section>
);

export default ActivityPreview;
