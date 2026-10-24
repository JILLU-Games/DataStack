import { CodeBlock } from '@/components/ui/CodeBlock';
import { SectionHeading } from '@/components/ui/SectionHeading';
import React from 'react';

export const SdkSection: React.FC = () => (
  <section id="sdk" className="border-b border-[var(--border)] py-10">
    <SectionHeading index="02" label="Python SDK" title="Drop in the SDK. Start streaming." />
    <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-2">
      <CodeBlock>
        <span className="text-[var(--text-faint)]"># Install the client</span>{'\n'}
        <span className="text-[var(--text)]">pip install ./sdk-python</span>{'\n\n'}
        <span className="text-[var(--text-faint)]"># Send an event</span>{'\n'}
        <span className="text-[var(--text)]">from datastack_sdk import DataStackClient</span>{'\n\n'}
        <span className="text-[var(--text)]">client = DataStackClient(</span>{'\n'}
        {'    '}server_url=<span className="text-[var(--accent)]">&quot;YOUR_SERVER_URL&quot;</span>,{'\n'}
        {'    '}token=<span className="text-[var(--accent)]">&quot;YOUR_CLIENT_TOKEN&quot;</span>,{'\n'}
        <span className="text-[var(--text)]">)</span>{'\n\n'}
        <span className="text-[var(--text)]">if client.connect():</span>{'\n'}
        {'    '}client.sync({'{'}<span className="text-[var(--accent)]">&quot;event&quot;</span>: <span className="text-[var(--accent)]">&quot;package_received&quot;</span>{'}'}){'\n'}
        {'    '}client.disconnect()
      </CodeBlock>
      <div className="bg-[var(--surface)] p-5 sm:p-6">
        <p className="mb-2 text-[11px] uppercase text-[var(--text-faint)]">How it works</p>
        <h3 className="mb-2 text-[14px] font-medium text-[var(--text)]">A small client. A clear workflow.</h3>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Connect a Python source, send individual or batched events, then review and export activity from one workspace.
        </p>
      </div>
    </div>
  </section>
);

export default SdkSection;
