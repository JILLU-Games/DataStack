'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setState('idle'), 1200);
  };

  const label = state === 'copied'
    ? 'Copied to clipboard'
    : state === 'failed'
      ? 'Clipboard unavailable'
      : 'Copy to clipboard';

  return (
    <button
      type="button"
      onClick={copyValue}
      aria-label={label}
      title={label}
      className="grid h-5 w-5 shrink-0 place-items-center text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
    >
      {state === 'copied'
        ? <Check className="h-3 w-3" aria-hidden="true" />
        : <Copy className="h-3 w-3" aria-hidden="true" />}
    </button>
  );
}

export default CopyButton;
