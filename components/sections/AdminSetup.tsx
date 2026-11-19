'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export function AdminSetup({
  databaseReady = true,
  databaseError = '',
  initialEmail = '',
}: {
  databaseReady?: boolean;
  databaseError?: string;
  initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail || 'admin@datastack.dev');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState(
    databaseReady ? '' : databaseError || 'Database connection unavailable.',
  );
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const savedTheme = localStorage.getItem('datastack-theme');
    const initialTheme = savedTheme === 'light' ? 'light' : 'dark';
    setTheme(initialTheme);
    document.documentElement.classList.toggle('light', initialTheme === 'light');
    document.documentElement.classList.toggle('dark', initialTheme === 'dark');
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('datastack-theme', nextTheme);
    document.documentElement.classList.toggle('light', nextTheme === 'light');
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, setupKey }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Admin setup failed.');
      window.location.assign('/vcon/dashboard');
      window.setTimeout(() => {
        setIsSubmitting(false);
      }, 2500);
    } catch (submitError) {
      setErrorMessage(
        submitError instanceof Error ? submitError.message : 'Admin setup failed.',
      );
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center bg-[var(--bg)] p-4 text-[var(--text)]">
      <Button
        type="button"
        variant="icon"
        size="icon"
        icon={theme === 'dark' ? 'Sun' : 'Moon'}
        aria-label="Toggle theme"
        title="Toggle theme"
        className="fixed right-3 top-3 z-10 h-7 w-7 border border-[var(--border)] text-[var(--text-muted)]"
        onClick={toggleTheme}
      />
      <section className="z-0 w-full max-w-[320px] border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <Link href="/" className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--text)]">
            <span className="grid h-3 w-3 place-items-center bg-[var(--accent)]" aria-hidden="true">
              <span className="h-1 w-1 bg-[var(--bg)]" />
            </span>
            DataStack
          </Link>
          <h1 className="text-[12px] font-medium text-[var(--text-muted)]">Admin Setup</h1>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-2.5 p-4">
          {errorMessage && (
            <div role="alert" className="border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              {errorMessage}
            </div>
          )}

          <Input
            label="Admin email"
            type="email"
            autoComplete="username"
            placeholder="admin@datastack.dev"
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
            minLength={8}
            required
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            compact
            minLength={8}
            required
          />
          <Input
            label="Installation key"
            type="password"
            autoComplete="off"
            placeholder="Installation key"
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
            className="mt-0.5 w-full justify-center"
          >
            Create admin
          </Button>
        </form>

        <footer className="flex items-center justify-end border-t border-[var(--border)] px-4 py-2 text-[10.5px]">
          <Link href="/vcon/login" className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)]">
            Sign in <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </footer>
      </section>
    </main>
  );
}
