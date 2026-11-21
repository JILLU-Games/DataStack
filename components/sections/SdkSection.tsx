import { CodeBlock } from '@/components/ui/CodeBlock';
import { SectionHeading } from '@/components/ui/SectionHeading';
import React from 'react';

export const SdkSection: React.FC = () => (
  <section id="sdk" className="border-b border-[var(--border)] py-10">
    <SectionHeading index="02" label="Client SDKs" title="Drop in the SDK. Start streaming." />
    <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] md:grid-cols-2">
      <CodeBlock>
        <span className="text-[var(--text-faint)]"># Python SDK (datastack v2.2.0) — auto-loads config.datastack.py</span>{'\n'}
        <span className="text-[var(--text)]">pip install ./sdk/python/datastack</span>{'\n\n'}
        <span className="text-[var(--text)]">from datastack import DataStack</span>{'\n\n'}
        <span className="text-[var(--text)]">client = DataStack()</span>{'\n'}
        <span className="text-[var(--text)]">client.send({'{'}<span className="text-[var(--accent)]">&quot;event_type&quot;</span>: <span className="text-[var(--accent)]">&quot;sensor_telemetry&quot;</span>, <span className="text-[var(--accent)]">&quot;temperature&quot;</span>: 24.8, <span className="text-[var(--accent)]">&quot;status&quot;</span>: <span className="text-[var(--accent)]">&quot;NOMINAL&quot;</span>{'}'})</span>{'\n'}
        <span className="text-[var(--text)]">client.send_file(<span className="text-[var(--accent)]">&quot;telemetry_batch.csv&quot;</span>)</span>{'\n'}
        <span className="text-[var(--text)]">client.disconnect()</span>
      </CodeBlock>
      <CodeBlock>
        <span className="text-[var(--text-faint)]">{'// Node.js / TypeScript SDK (@datastack/sdk v2.2.0)'}</span>{'\n'}
        <span className="text-[var(--text)]">npm install ./sdk/node/datastack</span>{'\n\n'}
        <span className="text-[var(--text)]">import {'{'} DataStack {'}'} from <span className="text-[var(--accent)]">&apos;@datastack/sdk&apos;</span>;</span>{'\n\n'}
        <span className="text-[var(--text)]">const client = new DataStack();</span>{'\n'}
        <span className="text-[var(--text)]">await client.send({'{'} <span className="text-[var(--accent)]">event_type</span>: <span className="text-[var(--accent)]">&apos;sensor_telemetry&apos;</span>, <span className="text-[var(--accent)]">temperature</span>: 24.8 {'}'});</span>{'\n'}
        <span className="text-[var(--text)]">await client.sendFile(<span className="text-[var(--accent)]">&apos;telemetry_batch.csv&apos;</span>);</span>{'\n'}
        <span className="text-[var(--text)]">await client.shutdown(5000);</span>
      </CodeBlock>
    </div>
    <div className="border-x border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 sm:px-6">
      <p className="mb-1 text-[11px] uppercase text-[var(--text-faint)]">Zero-boilerplate config · Auto-recovery built in</p>
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        Install either <code className="text-[var(--text)]">sdk/python/datastack</code> (<code className="text-[var(--text)]">config.datastack.py</code>) or <code className="text-[var(--text)]">@datastack/sdk</code> in <code className="text-[var(--text)]">sdk/node/datastack</code> (<code className="text-[var(--text)]">datastack.config.json</code>) to stream single events, batches, or <code className="text-[var(--text)]">.csv</code> / <code className="text-[var(--text)]">.json</code> / <code className="text-[var(--text)]">.jsonl</code> files—with automatic HTTP fallback, offline disk spooling, and graceful shutdown drain.
      </p>
    </div>
  </section>
);

export default SdkSection;
