"use client";

import { useState } from "react";

type Tab = "android" | "cloud";

type AndroidFeature = { title: string; body: string };

type Props = {
  tabs: { android: string; cloud: string };
  android: {
    eyebrow: string;
    headlineLine1: string;
    headlineLine2: string;
    subhead: string;
    ctaPrimary: string;
    ctaSecondary: string;
    features: Record<string, AndroidFeature>;
  };
  cloud: React.ReactNode;
  downloadUrl: string;
};

const FEATURE_ICONS: Record<string, React.ReactNode> = {
  noLaptop: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" strokeLinecap="round" />
    </svg>
  ),
  free: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 12h6M12 9v6" strokeLinecap="round" />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  ),
  previews: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <rect x="3" y="4.5" width="18" height="13" rx="2" />
      <path d="M3 8h18M8 21h8" strokeLinecap="round" />
    </svg>
  ),
  codeBrowser: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 15 3-3-3-3M13 15h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const FEATURE_ORDER = ["noLaptop", "free", "github", "previews", "codeBrowser", "terminal"];

export default function HeroTabs({ tabs, android, cloud, downloadUrl }: Props) {
  const [active, setActive] = useState<Tab>("android");

  return (
    <>
      {/* Tab toggle */}
      <div className="mx-auto mb-8 flex w-fit rounded-full border border-cream/[0.08] bg-ink-1 p-1">
        <button
          type="button"
          onClick={() => setActive("android")}
          className={`rounded-full px-5 py-2 text-sm font-medium transition-all ${
            active === "android"
              ? "bg-sodium text-ink"
              : "text-cream/55 hover:text-cream"
          }`}
        >
          {tabs.android}
        </button>
        <button
          type="button"
          onClick={() => setActive("cloud")}
          className={`rounded-full px-5 py-2 text-sm font-medium transition-all ${
            active === "cloud"
              ? "bg-sodium text-ink"
              : "text-cream/55 hover:text-cream"
          }`}
        >
          {tabs.cloud}
        </button>
      </div>

      {/* Android hero */}
      <div className={active === "android" ? "block" : "hidden"}>
        <div className="grid w-full items-center gap-10 sm:gap-16 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
              {android.eyebrow}
            </p>

            <h1 className="mt-5 text-[2.75rem] font-extralight leading-[1.02] tracking-[-0.03em] text-cream sm:text-[3rem] sm:tracking-[-0.035em] md:text-[3.5rem] lg:text-[4rem] lg:tracking-[-0.04em]">
              {android.headlineLine1}
              <br />
              <span className="text-sodium">{android.headlineLine2}</span>
            </h1>

            <p className="mt-7 max-w-[44ch] text-base leading-[1.7] text-cream/55 sm:text-lg sm:leading-[1.65]">
              {android.subhead}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={downloadUrl}
                className="inline-flex items-center gap-2 rounded-md bg-sodium px-7 py-3.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                  <path d="M17.523 2.24l-1.39 2.407a7.7 7.7 0 00-3.133-.659 7.7 7.7 0 00-3.133.659L8.477 2.24a.37.37 0 00-.507.136.37.37 0 00.136.507l1.356 2.349A7.67 7.67 0 005 11.86h16a7.67 7.67 0 00-4.462-6.628l1.356-2.349a.37.37 0 00-.136-.507.37.37 0 00-.235-.036zM10 9.24a.75.75 0 110-1.5.75.75 0 010 1.5zm6 0a.75.75 0 110-1.5.75.75 0 010 1.5zM5 12.86v8.12c0 .55.45 1 1 1h1v3.25c0 .69.56 1.25 1.25 1.25s1.25-.56 1.25-1.25V21.98h5v3.25c0 .69.56 1.25 1.25 1.25s1.25-.56 1.25-1.25V21.98h1c.55 0 1-.45 1-1V12.86H5zm-2.25-.5c-.69 0-1.25.56-1.25 1.25v5.5c0 .69.56 1.25 1.25 1.25S4 19.8 4 19.11v-5.5c0-.69-.56-1.25-1.25-1.25zm18.5 0c-.69 0-1.25.56-1.25 1.25v5.5c0 .69.56 1.25 1.25 1.25s1.25-.56 1.25-1.25v-5.5c0-.69-.56-1.25-1.25-1.25z" />
                </svg>
                {android.ctaPrimary}
              </a>
              <button
                type="button"
                onClick={() => setActive("cloud")}
                className="group inline-flex items-center gap-2 px-2 py-3.5 text-sm font-medium text-cream/65 transition hover:text-cream"
              >
                {android.ctaSecondary}
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                  →
                </span>
              </button>
            </div>
          </div>

          {/* Feature grid */}
          <div className="relative">
            <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_top,rgba(240,166,90,0.08),transparent_70%)] blur-2xl" />
            <ul className="relative grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-cream/[0.06] p-px">
              {FEATURE_ORDER.map((key) => {
                const f = android.features[key];
                if (!f) return null;
                return (
                  <li key={key} className="flex flex-col gap-2 bg-ink p-5 sm:p-6">
                    <div className="text-sodium">{FEATURE_ICONS[key]}</div>
                    <h3 className="text-sm font-semibold text-cream">{f.title}</h3>
                    <p className="text-[12.5px] leading-[1.6] text-cream/50">{f.body}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      {/* Cloud hero */}
      <div className={active === "cloud" ? "block" : "hidden"}>
        {cloud}
      </div>
    </>
  );
}
