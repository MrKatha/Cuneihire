import type { Metadata } from "next";
import { DM_Sans, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cuneihire",
  description: "Cuneihire — AI-automated job applications, by Cuneihive",
  keywords: ["job applications", "automation", "ai", "cuneihire", "cuneihive"],
};

import { Toaster } from "react-hot-toast";
import Link from "next/link";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="antialiased flex flex-col min-h-screen">
        <main className="flex-grow flex flex-col">
          {children}
        </main>

        <footer className="w-full py-8 mt-auto" style={{ borderTop: '1px solid var(--line)', backgroundColor: 'transparent' }}>
          <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-4 text-sm" style={{ color: 'var(--muted)' }}>
            <div>
              &copy; 2026 Cuneihire — built by <a href="https://cuneihive.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }} className="hover:underline">Cuneihive</a>
            </div>
            <nav className="flex items-center gap-5">
              <Link href="/terms" className="hover:underline" style={{ color: 'var(--muted)' }}>Terms</Link>
              <Link href="/privacy" className="hover:underline" style={{ color: 'var(--muted)' }}>Privacy</Link>
              <Link href="/refund-policy" className="hover:underline" style={{ color: 'var(--muted)' }}>Refunds</Link>
              <a href="mailto:help@cuneihive.com" className="hover:underline" style={{ color: 'var(--muted)' }}>Support</a>
            </nav>
          </div>
          <div className="container mx-auto px-4 mt-4 text-center">
            <p className="text-[10px] opacity-60 max-w-3xl mx-auto" style={{ color: 'var(--muted)' }}>
              Automated messaging and email sending carry inherent risk (rate-limiting, account restriction,
              deliverability) and are used at your own risk — see our <Link href="/terms" className="underline">Terms</Link> for the full disclaimer.
            </p>
          </div>
        </footer>

        <Toaster position="bottom-right" containerStyle={{ zIndex: 999999 }} />
      </body>
    </html>
  );
}
