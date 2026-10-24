'use client';

import { Button } from '@/components/ui/Button';
import { FormSwitch } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

function safeNextPath() {
  const value = new URLSearchParams(window.location.search).get('next');
  return value && value.startsWith('/') && !value.startsWith('//') && value !== '/vcon/login'
    ? value
    : '/vcon/dashboard';
}

export function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ email, password, remember }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Sign in failed.');
      router.replace(safeNextPath());
      router.refresh();
    } catch (submitError) {
      setErrorMessage(submitError instanceof Error ? submitError.message : 'Unable to sign in.');
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center bg-[var(--bg)] p-4 text-[var(--text)] sm:p-6">
      <Button
        type="button"
        variant="icon"
        size="icon"
        icon={theme === 'dark' ? 'Sun' : 'Moon'}
        aria-label="Toggle theme"
        title="Toggle theme"
        className="fixed right-4 top-4 z-10 h-7 w-7 border border-[var(--border)] text-[var(--text-muted)]"
        onClick={toggleTheme}
      />
      <section className="z-0 w-full max-w-xs border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex flex-col gap-3.5 border-b border-[var(--border)] px-5 pb-4 pt-5">
          <Link href="/" className="flex items-center gap-2 text-[13px] font-medium text-[var(--text)]">
            <span className="grid h-3.5 w-3.5 place-items-center bg-[var(--accent)]" aria-hidden="true">
              <span className="h-1.5 w-1.5 bg-[var(--bg)]" />
            </span>
            DataStack
            <span className="ml-1 border border-[var(--border-strong)] px-1 py-px text-[9px] tracking-wider text-[var(--text-faint)]">CONSOLE</span>
          </Link>
          <div>
            <h1 className="text-[15px] font-medium tracking-tight text-[var(--text)]">Sign in</h1>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">Access your admin console</p>
          </div>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-4">
          {errorMessage && (
            <div role="alert" className="flex items-start gap-2 border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text-muted)]">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 bg-[var(--text-muted)]" aria-hidden="true" />
              <span>{errorMessage}</span>
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
            className="h-8 border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12.5px] focus:border-[var(--border-strong)]"
            required
          />

          <div className="flex flex-col gap-1">
            <label htmlFor="admin-password" className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">Password</label>
            <div className="relative">
              <Input
                id="admin-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                compact
                className="h-8 border-[var(--border)] bg-[var(--bg)] px-2.5 pr-10 text-[12.5px] focus:border-[var(--border-strong)]"
                required
              />
              <Button
                type="button"
                variant="icon"
                size="icon"
                icon={showPassword ? 'EyeOff' : 'Eye'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-0 top-0 h-8 w-8 border-l border-[var(--border)] text-[var(--text-faint)]"
                onClick={() => setShowPassword((current) => !current)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <FormSwitch label="Remember me" checked={remember} onChange={setRemember} />
            <span className="shrink-0 text-[11px] text-[var(--text-faint)]">Server-managed access</span>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon="ArrowRight"
            iconPosition="right"
            loading={isSubmitting}
            disabled={isSubmitting}
            className="mt-1 h-[34px] w-full justify-center text-[12.5px]"
          >
            Sign in
          </Button>

          <div className="my-0.5 flex items-center gap-2.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            <span className="h-px flex-1 bg-[var(--border)]" />
            Admin access
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <p className="text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
            Credentials are configured by the server operator.
          </p>
        </form>

        <footer className="flex items-center justify-between border-t border-[var(--border)] px-5 py-2.5 text-[10.5px] text-[var(--text-faint)]">
          <span><span className="mr-1.5 inline-block h-1 w-1 bg-[var(--accent)] align-middle" />Protected session</span>
          <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)]">Home <ArrowRight className="inline h-3 w-3" aria-hidden="true" /></Link>
        </footer>
      </section>

      <footer className="fixed bottom-3 left-0 right-0 flex items-center justify-center gap-2 text-[10.5px] text-[var(--text-faint)]">
        <span>DataStack</span>
        <span className="text-[var(--border-strong)]">·</span>
        <span>Self-hosted</span>
      </footer>
    </main>
  );
}
