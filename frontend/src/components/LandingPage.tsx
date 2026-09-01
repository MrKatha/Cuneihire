"use client";

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Zap, Shield, ChevronRight, Settings, Search, UserPlus, FileText, Send, CheckCircle2 } from 'lucide-react';
import HexMark from '@/components/ui/HexMark';

function FadeIn({ children, delay = 0, className = "", style = {} }: { children: React.ReactNode, delay?: number, className?: string, style?: React.CSSProperties }) {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.15 });

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(30px)',
        transition: `opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 0.8s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`
      }}
    >
      {children}
    </div>
  );
}

function StepBadge({ label }: { label: string }) {
  return (
    <span
      className="text-xs font-bold tracking-[0.2em] uppercase px-3 py-1 border"
      style={{ color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)', fontFamily: 'var(--font-mono), monospace' }}
    >
      {label}
    </span>
  );
}

function StepMarker({ children }: { children: React.ReactNode }) {
  return (
    <FadeIn className="flex items-center justify-center w-10 h-10 rounded-full shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 relative z-10" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
      {children}
    </FadeIn>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen font-sans overflow-x-hidden" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>

      {/* Navigation */}
      <FadeIn>
        <nav className="flex items-center justify-between px-6 py-4 md:px-12 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <HexMark variant="outline" size={30} />
            <span className="font-bold text-xl tracking-tight" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Cuneihire</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/resume-builder" className="font-medium text-sm transition-colors hidden sm:inline" style={{ color: 'var(--muted)' }}>
              Free Resume Builder
            </Link>
            <Link href="/login" className="font-medium text-sm transition-colors" style={{ color: 'var(--muted)' }}>
              Log in
            </Link>
            <Link href="/signup" className="px-4 py-2 font-medium text-sm transition-colors" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              Get started
            </Link>
          </div>
        </nav>
      </FadeIn>

      {/* Hero Section */}
      <section className="pt-24 pb-16 px-6 text-center max-w-5xl mx-auto relative">
        <FadeIn delay={100}>
          <p className="label-eyebrow accent mb-5">AI application infrastructure</p>
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>
            Run your job search <br />
            on <span style={{ color: 'var(--accent)' }}>autopilot</span>.
          </h1>
        </FadeIn>
        <FadeIn delay={200}>
          <p className="text-lg md:text-xl mb-10 max-w-2xl mx-auto" style={{ color: 'var(--muted)' }}>
            Cuneihire finds the right people, writes the outreach, and applies for you automatically — while you sleep.
          </p>
        </FadeIn>

        <FadeIn delay={300}>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 max-w-md mx-auto mb-20">
            <Link href="/signup" className="w-full sm:w-auto whitespace-nowrap px-8 py-4 font-bold text-lg transition-all flex items-center justify-center gap-2" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              Start Your Free Trial <ChevronRight className="w-5 h-5" />
            </Link>
          </div>
        </FadeIn>

        {/* Dashboard Mockup */}
        <FadeIn delay={400}>
          <div className="relative mx-auto overflow-hidden border max-w-4xl aspect-[16/9] flex flex-col" style={{ borderColor: 'var(--line)', background: 'var(--bg-elevated)' }}>
            {/* Mac-like Header */}
            <div className="border-b p-3 flex items-center gap-2" style={{ borderColor: 'var(--line)' }}>
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5" style={{ background: 'var(--danger)' }}></div>
                <div className="w-2.5 h-2.5" style={{ background: 'var(--warn)' }}></div>
                <div className="w-2.5 h-2.5" style={{ background: 'var(--ok)' }}></div>
              </div>
              <div className="mx-auto px-4 py-1 text-xs flex items-center gap-2" style={{ background: 'var(--bg)', color: 'var(--muted)', fontFamily: 'var(--font-mono), monospace' }}>
                <Shield className="w-3 h-3" /> cuneihire.com
              </div>
            </div>
            {/* Dashboard Body */}
            <div className="flex-1 p-6 flex gap-6" style={{ background: 'var(--bg)' }}>
              <div className="w-48 hidden md:flex flex-col gap-3">
                <div className="flex items-center gap-2 mb-4">
                  <HexMark variant="outline" size={18} />
                  <span className="font-bold" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Cuneihire</span>
                </div>
                <div className="h-8 w-full" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', borderLeft: '2px solid var(--accent)' }}></div>
                <div className="h-8 border w-full" style={{ borderColor: 'var(--line)' }}></div>
                <div className="h-8 border w-full" style={{ borderColor: 'var(--line)' }}></div>
                <div className="h-8 border w-full" style={{ borderColor: 'var(--line)' }}></div>
              </div>
              <div className="flex-1 flex flex-col gap-6">
                <div className="flex justify-between items-center">
                  <div className="h-8 w-1/4" style={{ background: 'var(--line)' }}></div>
                  <div className="h-8 w-32" style={{ background: 'var(--accent)' }}></div>
                </div>
                <div className="flex-1 border p-4 relative overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--bg-elevated)' }}>
                  <div className="h-10 mb-4 border" style={{ background: 'var(--bg)', borderColor: 'var(--line)' }}></div>
                  <div className="space-y-3">
                    {[1, 2, 3, 4, 5].map(i => (
                      <div key={i} className="flex gap-4 items-center p-2 border border-transparent">
                        <div className="h-4 w-1/4" style={{ background: 'var(--line)' }}></div>
                        <div className="h-4 flex-1" style={{ background: 'color-mix(in srgb, var(--line) 60%, transparent)' }}></div>
                        <div className="h-4 w-16" style={{ background: 'color-mix(in srgb, var(--ok) 25%, transparent)' }}></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </FadeIn>
      </section>

      {/* Feature Grid */}
      <section className="py-24 px-6 relative">
        <div className="max-w-6xl mx-auto">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="label-eyebrow mb-3" style={{ justifyContent: 'center', display: 'flex' }}>What it does</p>
              <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>
                Powerful automation, zero busywork.
              </h2>
              <p className="text-lg max-w-2xl mx-auto" style={{ color: 'var(--muted)' }}>
                Cuneihire connects directly to LinkedIn and your inbox to automate the entire outreach pipeline, from finding recruiters to writing the emails.
              </p>
            </div>
          </FadeIn>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-px" style={{ background: 'var(--line)', border: '1px solid var(--line)' }}>
            {[
              { icon: Search, title: 'LinkedIn Keyword Scraper', body: 'Automatically search LinkedIn for specific keywords and instantly pull targeted profiles and emails into your contact list.' },
              { icon: UserPlus, title: 'Auto-Extract Recruiters', body: 'Find hiring managers and recruiters from any company page. Let the system pull their contact info while you sleep.' },
              { icon: FileText, title: 'AI Mail Sender', body: 'Our AI analyzes every single LinkedIn profile and writes a highly personalized, custom email for each person automatically.' },
              { icon: Send, title: 'Auto Job Apply', body: "Don't waste time clicking apply. Automatically submit applications and send follow-up emails to the hiring team in the background." },
            ].map((f, i) => (
              <FadeIn key={f.title} delay={100 * (i + 1)} className="p-8" style={{ background: 'var(--bg-elevated)' }}>
                <div className="w-11 h-11 flex items-center justify-center mb-6" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}>
                  <f.icon className="w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold mb-3">{f.title}</h3>
                <p className="text-sm" style={{ color: 'var(--muted)' }}>{f.body}</p>
              </FadeIn>
            ))}
          </div>

          {/* LinkedIn Image Showcase */}
          <FadeIn delay={500}>
            <div className="mt-16 p-8 md:p-12 overflow-hidden relative" style={{ background: 'var(--ink)' }}>
              <div className="md:flex items-center gap-12 relative z-10">
                <div className="md:w-1/2 mb-8 md:mb-0">
                  <p className="label-eyebrow mb-3" style={{ color: 'color-mix(in srgb, var(--bg) 60%, var(--muted))' }}>Deep integration</p>
                  <h3 className="text-3xl font-bold mb-4" style={{ color: 'var(--bg)', fontFamily: 'var(--font-display), Georgia, serif' }}>Runs alongside your LinkedIn session</h3>
                  <p className="text-lg" style={{ color: 'color-mix(in srgb, var(--bg) 70%, var(--muted))' }}>
                    Cuneihire runs invisibly alongside your LinkedIn session. We automatically fetch cookies, search queries, and profiles without requiring complex API keys or manual data entry.
                  </p>
                </div>
                <div className="md:w-1/2">
                  <div className="p-2 border" style={{ borderColor: 'color-mix(in srgb, var(--bg) 20%, transparent)' }}>
                    {/* Dummy LinkedIn Image UI */}
                    <div className="overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                      <div className="text-white p-3 flex items-center gap-3" style={{ background: '#0077b5' }}>
                        <div className="font-bold text-xl ml-2 tracking-tighter">in</div>
                        <div className="bg-white/20 h-8 flex-1 text-sm px-3 flex items-center">Search &quot;Software Engineer&quot;</div>
                      </div>
                      <div className="p-4 flex gap-4 border-b" style={{ borderColor: 'var(--line)' }}>
                        <div className="w-16 h-16 shrink-0" style={{ background: 'var(--line)', borderRadius: '50%' }}></div>
                        <div>
                          <div className="h-5 w-40 mb-2" style={{ background: 'var(--muted)' }}></div>
                          <div className="h-3 w-60 mb-2" style={{ background: 'var(--line)' }}></div>
                          <div className="h-3 w-32" style={{ background: 'var(--line)' }}></div>
                        </div>
                        <div className="ml-auto">
                          <div className="text-xs px-3 py-1.5 font-bold flex items-center gap-1" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                            <Zap className="w-3 h-3" /> Auto-Extracting...
                          </div>
                        </div>
                      </div>
                      <div className="p-4 flex gap-4">
                        <div className="w-16 h-16 shrink-0" style={{ background: 'var(--line)', borderRadius: '50%' }}></div>
                        <div>
                          <div className="h-5 w-32 mb-2" style={{ background: 'var(--muted)' }}></div>
                          <div className="h-3 w-48 mb-2" style={{ background: 'var(--line)' }}></div>
                          <div className="h-3 w-24" style={{ background: 'var(--line)' }}></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Dummy's Guide Section */}
      <section className="py-24 px-6 border-y relative overflow-hidden" style={{ background: 'var(--ink)', color: 'var(--bg)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
        <div className="max-w-5xl mx-auto relative z-10">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="label-eyebrow mb-3" style={{ justifyContent: 'center', display: 'flex', color: 'color-mix(in srgb, var(--bg) 60%, var(--muted))' }}>Getting started</p>
              <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>
                How It Works (Step-by-Step)
              </h2>
              <p className="text-lg max-w-2xl mx-auto" style={{ color: 'color-mix(in srgb, var(--bg) 70%, var(--muted))' }}>
                We&apos;ve made Cuneihire so simple that anyone can use it. No coding, no complicated tech. Just follow these 5 easy steps to put your outreach on autopilot.
              </p>
            </div>
          </FadeIn>

          <div className="space-y-12 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-px before:bg-[color-mix(in_srgb,var(--bg)_20%,transparent)]">

            {/* Step 1 */}
            <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
              <StepMarker><UserPlus className="w-5 h-5" /></StepMarker>
              <FadeIn delay={150} className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-8 border transition-all" style={{ background: 'color-mix(in srgb, var(--bg) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <StepBadge label="Step 1" />
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Create Your Account</h3>
                <p className="leading-relaxed" style={{ color: 'color-mix(in srgb, var(--bg) 75%, var(--muted))' }}>
                  Click the <strong>Get Started</strong> button above. Enter your email address and create a password. That&apos;s it! You now have a Cuneihire account. It&apos;s completely free to sign up and look around.
                </p>
              </FadeIn>
            </div>

            {/* Step 2 */}
            <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
              <StepMarker><Settings className="w-5 h-5" /></StepMarker>
              <FadeIn delay={150} className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-8 border transition-all" style={{ background: 'color-mix(in srgb, var(--bg) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <StepBadge label="Step 2" />
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Connect Your Email (Configuration)</h3>
                <p className="leading-relaxed" style={{ color: 'color-mix(in srgb, var(--bg) 75%, var(--muted))' }}>
                  Before Cuneihire can send emails for you, you need to give it permission. Go to the <strong>Settings</strong> tab, open the Email Accounts card, and add your email details. Think of this like giving a robot the keys to your mailbox!
                </p>
              </FadeIn>
            </div>

            {/* Step 3 */}
            <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
              <StepMarker><Search className="w-5 h-5" /></StepMarker>
              <FadeIn delay={150} className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-8 border transition-all" style={{ background: 'color-mix(in srgb, var(--bg) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <StepBadge label="Step 3" />
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Find Contacts & Leads</h3>
                <p className="leading-relaxed" style={{ color: 'color-mix(in srgb, var(--bg) 75%, var(--muted))' }}>
                  Now you need people to email! Go to the <strong>Roles</strong> tab to set up what you&apos;re looking for, then turn on LinkedIn auto-fetch in <strong>Settings</strong>. Once it&apos;s on, Cuneihire acts like a detective and automatically finds new people for you!
                </p>
              </FadeIn>
            </div>

            {/* Step 4 */}
            <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
              <StepMarker><FileText className="w-5 h-5" /></StepMarker>
              <FadeIn delay={150} className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-8 border transition-all" style={{ background: 'color-mix(in srgb, var(--bg) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <StepBadge label="Step 4" />
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Set up AI Templates</h3>
                <p className="leading-relaxed" style={{ color: 'color-mix(in srgb, var(--bg) 75%, var(--muted))' }}>
                  Instead of writing the same email 100 times, you create a &quot;Template&quot;. Go to the <strong>Email Templates</strong> tab. Write a basic message like &quot;Hi, I love your work!&quot;. Our Artificial Intelligence will automatically read your template and customize it perfectly for every single person.
                </p>
              </FadeIn>
            </div>

            {/* Step 5 */}
            <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
              <StepMarker><Send className="w-5 h-5" /></StepMarker>
              <FadeIn delay={150} className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-8 border transition-all" style={{ background: 'color-mix(in srgb, var(--bg) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--bg) 15%, transparent)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <StepBadge label="Step 5" />
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>Press Send (Automail)</h3>
                <p className="leading-relaxed" style={{ color: 'color-mix(in srgb, var(--bg) 75%, var(--muted))' }}>
                  Finally, go to <strong>Settings</strong> and turn on Automation. Once you do this, you can close your computer and go to the beach. Cuneihire will automatically write the emails using AI, and send them out one by one in the background for you. It&apos;s magic!
                </p>
              </FadeIn>
            </div>

          </div>
        </div>
      </section>

      {/* Massive CTA */}
      <section className="py-32 px-6 text-center relative overflow-hidden border-t" style={{ background: 'var(--bg)', borderColor: 'var(--line)' }}>
        <FadeIn className="relative z-10">
          <h2 className="text-5xl md:text-7xl font-black leading-[1.1] mb-8 tracking-tight max-w-4xl mx-auto" style={{ fontFamily: 'var(--font-display), Georgia, serif' }}>
            Ready to take control of your time?
          </h2>
          <p className="text-xl max-w-2xl mx-auto font-medium" style={{ color: 'var(--muted)' }}>
            Join the founders and job-seekers who use Cuneihire to automate their outreach and scale their pipeline on autopilot.
          </p>
        </FadeIn>

        <FadeIn delay={200} className="mt-14 relative z-10">
          <Link href="/signup" className="inline-block px-12 py-5 font-bold text-xl transition-all border" style={{ background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }}>
            Get Started Now &rarr;
          </Link>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-6 md:gap-10 font-semibold text-sm" style={{ color: 'var(--muted)' }}>
            <span className="flex items-center gap-2 px-4 py-2 border" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--line)' }}><CheckCircle2 className="w-5 h-5" style={{ color: 'var(--ok)' }} /> Free Trial</span>
            <span className="flex items-center gap-2 px-4 py-2 border" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--line)' }}><CheckCircle2 className="w-5 h-5" style={{ color: 'var(--ok)' }} /> No Credit Card</span>
            <span className="flex items-center gap-2 px-4 py-2 border" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--line)' }}><CheckCircle2 className="w-5 h-5" style={{ color: 'var(--ok)' }} /> Cancel Anytime</span>
          </div>
        </FadeIn>
      </section>

    </div>
  );
}
