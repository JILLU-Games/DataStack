import { ToastProvider } from '@/components/ui/Toast';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DataStack - Realtime Data Collection Platform',
  description: 'A self-hosted workspace for collecting, reviewing, and exporting realtime data.',
  manifest: '/manifest.json',
  openGraph: {
    title: 'DataStack - Realtime Data Collection Platform',
    description: 'Collect, review, and export realtime data from one clear workspace.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DataStack - Realtime Data Collection Platform',
    description: 'A clear workspace for collecting, reviewing, and exporting realtime data.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0a0a0b" />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-[var(--bg-main)] text-[var(--text)] antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
