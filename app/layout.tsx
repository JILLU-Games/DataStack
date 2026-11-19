import { PwaLifecycle } from '@/components/pwa/PwaLifecycle';
import { ToastProvider } from '@/components/ui/Toast';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  themeColor: '#0a0a0b',
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'DataStack - Realtime Data Collection Platform',
  description: 'Self-hosted universal realtime data collection engine with Socket.IO ingestion, Redis buffer, JWT client auth, CSV batch rotation, and /vcon/ admin panel.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'DataStack',
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'DataStack - Realtime Data Collection Platform',
    description: 'Self-hosted universal realtime data collection engine with Socket.IO ingestion, Redis buffer, JWT client auth, CSV batch rotation, and /vcon/ admin panel.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DataStack - Realtime Data Collection Platform',
    description: 'Self-hosted universal realtime data collection engine with Socket.IO ingestion, Redis buffer, JWT client auth, CSV batch rotation, and /vcon/ admin panel.',
  },
};

const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem('datastack-theme');var r=document.documentElement;if(t==='light'){r.classList.remove('dark');r.classList.add('light');}else{r.classList.remove('light');r.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-[var(--bg-main)] text-[var(--text)] antialiased">
        <ToastProvider>
          {children}
          <PwaLifecycle />
        </ToastProvider>
      </body>
    </html>
  );
}
