'use client';

import { Button } from '@/components/ui/Button';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

function safeNextPath() {
  const value = new URLSearchParams(window.location.search).get('next');
  return value && value.startsWith('/') && !value.startsWith('//') && value !== '/vcon/login'
    ? value
    : '/vcon/dashboard';
}

export function AdminLogin({
  showDemoHint = false,
}: {
  showDemoHint?: boolean;
}) {
  const [email, setEmail] = useState(showDemoHint ? 'admin@datastack.dev' : '');
  const [password, setPassword] = useState(showDemoHint ? 'admin12345678' : '');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
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
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, remember }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Sign in failed.');
      const targetPath = safeNextPath();
      window.location.assign(targetPath);
      window.setTimeout(() => {
        setIsSubmitting(false);
      }, 2500);
    } catch (submitError) {
      setErrorMessage(submitError instanceof Error ? submitError.message : 'Unable to sign in.');
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
      <section className="z-0 w-full max-w-[300px] border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <Link href="/" className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--text)]">
            <span className="grid h-3 w-3 place-items-center bg-[var(--accent)]" aria-hidden="true">
              <span className="h-1 w-1 bg-[var(--bg)]" />
            </span>
            DataStack
          </Link>
          <h1 className="text-[12px] font-medium text-[var(--text-muted)]">Sign in</h1>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-2.5 p-4">
          {errorMessage && (
            <div role="alert" className="border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              {errorMessage}
            </div>
          )}

          <Input
            label="Email"
            type="email"
            autoComplete="username"
            placeholder="admin@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            compact
            required
          />

          <Input
            id="admin-password"
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            compact
            required
            rightElement={
              <Button
                type="button"
                variant="icon"
                size="icon"
                icon={showPassword ? 'EyeOff' : 'Eye'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                className="h-7.5 w-7.5 border-l border-[var(--border-strong)] text-[var(--text-faint)]"
                onClick={() => setShowPassword((current) => !current)}
              />
            }
          />

          <FormSwitch label="Remember me" checked={remember} onChange={setRemember} />

          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon="ArrowRight"
            iconPosition="right"
            loading={isSubmitting}
            disabled={isSubmitting}
            className="mt-0.5 w-full justify-center"
          >
            Sign in
          </Button>

          {showDemoHint && (
            <button
              type="button"
              onClick={() => {
                setEmail('admin@datastack.dev');
                setPassword('admin12345678');
              }}
              className="mt-0.5 text-center font-mono text-[10.5px] text-[var(--accent)] hover:underline cursor-pointer"
            >
              admin@datastack.dev / admin12345678
            </button>
          )}
        </form>

        <footer className="flex items-center justify-end border-t border-[var(--border)] px-4 py-2 text-[10.5px]">
          <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)]">Home <ArrowRight className="inline h-3 w-3" aria-hidden="true" /></Link>
        </footer>
      </section>
    </main>
  );
}
