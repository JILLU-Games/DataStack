import { CodeBlock } from '@/components/ui/CodeBlock';
import { SectionHeading } from '@/components/ui/SectionHeading';
import React from 'react';

export const SdkSection: React.FC = () => (
  <section id="sdk" className="border-b border-[var(--border)] py-10">
    <SectionHeading index="02" label="Python SDK" title="Drop in the SDK. Start streaming." />
    <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-2">
      <CodeBlock>
        <span className="text-[var(--text-faint)]"># Install the official Python SDK</span>{'\n'}
        <span className="text-[var(--text)]">pip install ./sdk/python/datastack</span>{'\n\n'}
        <span className="text-[var(--text-faint)]"># Auto-loads config.datastack.py from project root</span>{'\n'}
        <span className="text-[var(--text)]">from datastack import DataStack</span>{'\n\n'}
        <span className="text-[var(--text)]">client = DataStack()</span>{'\n'}
        <span className="text-[var(--text)]">client.send({'{'}<span className="text-[var(--accent)]">&quot;event&quot;</span>: <span className="text-[var(--accent)]">&quot;package_received&quot;</span>{'}'})</span>{'\n'}
        <span className="text-[var(--text)]">client.send_file(<span className="text-[var(--accent)]">&quot;telemetry_batch.csv&quot;</span>)</span>{'\n'}
        <span className="text-[var(--text)]">client.disconnect()</span>
      </CodeBlock>
      <div className="bg-[var(--surface)] p-5 sm:p-6">
        <p className="mb-2 text-[11px] uppercase text-[var(--text-faint)]">How it works</p>
        <h3 className="mb-2 text-[14px] font-medium text-[var(--text)]">Zero-boilerplate config. Auto-recovery built in.</h3>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Drop <code className="text-[var(--text)]">config.datastack.py</code> into your Python project to stream single events, batches, or <code className="text-[var(--text)]">.csv</code> / <code className="text-[var(--text)]">.json</code> files directly—with automatic HTTP fallback, offline disk spooling, and Heartbeat IDLE recovery.
        </p>
      </div>
    </div>
  </section>
);

export default SdkSection;
