import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';

import { AppFrame } from '@/components/app/app-frame';

import './globals.css';

const heading = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'Barraqueiro Legal Assistant',
  description: 'Controlled legal document production for Grupo Barraqueiro.',
};

// Runs synchronously in <head> during HTML parsing so the resolved theme is applied to
// <html> on the very first frame (avoids a light-theme flash). Naten design-system pattern.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var key = 'legal-theme-preference-v1';
    var stored = window.localStorage.getItem(key);
    var preference = (stored === 'light' || stored === 'night' || stored === 'system')
      ? stored
      : 'system';
    if (stored !== 'light' && stored !== 'night' && stored !== 'system') {
      window.localStorage.setItem(key, 'system');
    }
    var theme = preference === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'light')
      : preference;
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${heading.variable} ${mono.variable}`}>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
