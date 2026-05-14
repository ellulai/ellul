"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";

function reportOnce(eventName: string, props: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  // PostHog with disable_persistence + memory persistence does not
  // reliably replay pre-init capture() calls. We poll briefly for __loaded
  // (the init effect runs in the same tick) and fire once it flips.
  const fire = () => posthog.capture(eventName, props);
  if (posthog.__loaded) {
    fire();
    return;
  }
  // Poll for up to 3 seconds for posthog.init() to complete.
  let tries = 0;
  const id = window.setInterval(() => {
    tries += 1;
    if (posthog.__loaded) {
      window.clearInterval(id);
      fire();
    } else if (tries > 30) {
      window.clearInterval(id);
    }
  }, 100);
}

export function ComparisonViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("comparison_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

export function UseCaseViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("use_case_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

export function GlossaryTermViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("glossary_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

export function PillarViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("pillar_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

export function AgentViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("agent_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

export function McpViewedReporter({ slug }: { slug: string }) {
  useEffect(() => {
    reportOnce("mcp_viewed", { slug, surface: "web" });
  }, [slug]);
  return null;
}

// Detects when a visitor lands from an LLM (ChatGPT, Claude, Perplexity, Gemini,
// Copilot, You.com, Kagi, Brave) so the AI Citation Tracking dashboard can plot
// referral volume by source. document.referrer reads the previous page's URL;
// when the URL matches a known LLM origin, fire `llm_referral`.
const LLM_REFERRER_HOSTS: Array<{ host: string; source: string }> = [
  { host: "chat.openai.com", source: "chatgpt" },
  { host: "chatgpt.com", source: "chatgpt" },
  { host: "claude.ai", source: "claude" },
  { host: "perplexity.ai", source: "perplexity" },
  { host: "www.perplexity.ai", source: "perplexity" },
  { host: "gemini.google.com", source: "gemini" },
  { host: "copilot.microsoft.com", source: "copilot" },
  { host: "you.com", source: "you" },
  { host: "kagi.com", source: "kagi" },
  { host: "search.brave.com", source: "brave" },
];

export function LlmReferralReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof document === "undefined") return;
    const ref = document.referrer;
    if (!ref) return;
    let host: string;
    try {
      host = new URL(ref).host.toLowerCase();
    } catch {
      return;
    }
    const match = LLM_REFERRER_HOSTS.find(
      (e) => host === e.host || host.endsWith(`.${e.host}`),
    );
    if (!match) return;
    reportOnce("llm_referral", {
      source: match.source,
      landing_page: window.location.pathname,
      surface: "web",
    });
  }, []);
  return null;
}

const SCROLL_THRESHOLDS = [25, 50, 75, 100] as const;

export function BlogPostScrollReporter({ slug }: { slug: string }) {
  const fired = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;

    function readDepth() {
      const scrollTop =
        window.scrollY || document.documentElement.scrollTop || 0;
      const docHeight =
        document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return 100;
      return Math.min(100, Math.max(0, (scrollTop / docHeight) * 100));
    }

    function handleScroll() {
      const depth = readDepth();
      for (const t of SCROLL_THRESHOLDS) {
        if (depth >= t && !fired.current.has(t)) {
          fired.current.add(t);
          reportOnce("blog_post_read", {
            slug,
            scroll_depth: String(t),
            surface: "web",
          });
        }
      }
    }

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [slug]);
  return null;
}

export function CtaClickReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const cta = target.closest<HTMLElement>("[data-cta]");
      if (!cta) return;
      const ctaId = cta.dataset.cta || "unknown";
      const sourcePage = cta.dataset.sourcePage || window.location.pathname;
      const ctaTarget =
        cta.getAttribute("href") || cta.dataset.target || "unknown";
      reportOnce("cta_clicked", {
        cta_id: ctaId,
        cta_target: ctaTarget,
        source_page: sourcePage,
        surface: "web",
      });
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);
  return null;
}
