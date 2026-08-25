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
          </div>
          <div className="container mx-auto px-4 mt-4 text-center">
            <p className="text-[10px] opacity-60 max-w-3xl mx-auto" style={{ color: 'var(--muted)' }}>
              Disclaimer & Privacy: This tool is provided "as is" without warranties of any kind. Any use of this platform for automated messaging or email sending is strictly at your own risk. Cuneihire assumes no liability for account bans, data loss, or misuse of this software.
            </p>
          </div>
        </footer>

        <Toaster position="bottom-right" containerStyle={{ zIndex: 999999 }} />
      </body>
    </html>
  );
}
