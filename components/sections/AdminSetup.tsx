'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AdminSetup({
  databaseReady = true,
  initialEmail = '',
}: {
  databaseReady?: boolean;
  initialEmail?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState(
    databaseReady ? '' : 'The setup service is unavailable. Check the database connection and try again.',
  );

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');

    if (password.length < 12) {
      setErrorMessage('Choose a password with at least 12 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('The passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, setupKey }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Admin setup failed.');
      router.replace('/vcon/dashboard');
      router.refresh();
    } catch (submitError) {
      setErrorMessage(
        submitError instanceof Error ? submitError.message : 'Admin setup failed.',
      );
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center bg-[var(--bg)] p-4 text-[var(--text)] sm:p-6">
      <section className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex flex-col gap-3.5 border-b border-[var(--border)] px-5 pb-4 pt-5">
          <Link href="/" className="flex items-center gap-2 text-[13px] font-medium text-[var(--text)]">
            <span className="grid h-3.5 w-3.5 place-items-center bg-[var(--accent)]" aria-hidden="true">
              <span className="h-1.5 w-1.5 bg-[var(--bg)]" />
            </span>
            DataStack
            <span className="ml-1 border border-[var(--border-strong)] px-1 py-px text-[9px] tracking-wider text-[var(--text-faint)]">INITIAL SETUP</span>
          </Link>
          <div>
            <h1 className="text-[15px] font-medium text-[var(--text)]">Create the first admin</h1>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
              This one-time setup creates the admin account stored in your database.
            </p>
          </div>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-4">
          {errorMessage && (
            <div role="alert" className="border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text-muted)]">
              {errorMessage}
            </div>
          )}

          <Input
            label="Admin email"
            type="email"
            autoComplete="username"
            placeholder="admin@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            compact
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            compact
            minLength={12}
            required
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            compact
            minLength={12}
            required
          />
          <Input
            label="Installation key"
            type="password"
            autoComplete="off"
            value={setupKey}
            onChange={(event) => setSetupKey(event.target.value)}
            compact
            required
          />

          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon="ArrowRight"
            iconPosition="right"
            loading={isSubmitting}
            disabled={isSubmitting || !databaseReady}
            className="mt-1 h-[34px] w-full justify-center text-[12.5px]"
          >
            Create admin account
          </Button>
        </form>

        <footer className="flex items-center justify-between border-t border-[var(--border)] px-5 py-2.5 text-[10.5px] text-[var(--text-faint)]">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3 w-3" aria-hidden="true" />One-time installation</span>
          <Link href="/vcon/login" className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)]">
            Sign in <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </footer>
      </section>
    </main>
  );
}
