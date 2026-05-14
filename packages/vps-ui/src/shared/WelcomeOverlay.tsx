// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Welcome overlay (Phase 7a-NATIVE Layer 4)
 *
 * Renders once on the user's first session for each project. Two-button
 * CTA: dismiss into chat, or surface the code panel via the
 * `request_panel` outgoing message (console decides whether to focus
 * the code iframe in studio mode or swap the active iframe in focus
 * mode).
 *
 * Persistence: `welcomeShownAt` field on `.ellul/project.json`, read +
 * written via the file-api `/api/project-meta` endpoint. Survives
 * across devices because the file lives in the project workspace, not
 * in browser localStorage.
 *
 * Renders nothing until the active project is known and `welcomeShownAt`
 * has been read — prevents a flash of overlay on cached pages.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { sendToParent } from './postMessage';

interface ActiveAppEntry {
  directory: string;
}

interface AppsApiResponse {
  active?: { app?: string | null };
}

interface ProjectMeta {
  welcomeShownAt?: string | null;
  [key: string]: unknown;
}

async function fetchActiveProject(): Promise<string | null> {
  try {
    const res = await fetch('/api/apps', { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as AppsApiResponse;
    return data.active?.app ?? null;
  } catch {
    return null;
  }
}

async function fetchProjectMeta(projectId: string): Promise<ProjectMeta | null> {
  try {
    const url = `/api/project-meta?project=${encodeURIComponent(projectId)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data as ProjectMeta | null;
  } catch {
    return null;
  }
}

async function recordWelcomeShown(projectId: string): Promise<void> {
  try {
    const url = `/api/project-meta?project=${encodeURIComponent(projectId)}`;
    await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ welcomeShownAt: new Date().toISOString() }),
    });
  } catch {
    // Non-fatal; the overlay just shows again next session if persistence
    // fails (e.g., transient network blip, scratch project without meta dir).
  }
}

type Phase = 'loading' | 'show' | 'hidden';

export function WelcomeOverlay() {
  const t = useTranslations('welcome');
  const [phase, setPhase] = useState<Phase>('loading');
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const proj = await fetchActiveProject();
      if (cancelled) return;
      if (!proj) {
        // No active project (cold start, sandbox empty) — no overlay yet.
        setPhase('hidden');
        return;
      }
      setProjectId(proj);
      const meta = await fetchProjectMeta(proj);
      if (cancelled) return;
      if (meta && typeof meta.welcomeShownAt === 'string' && meta.welcomeShownAt.length > 0) {
        setPhase('hidden');
      } else {
        setPhase('show');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'show') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function dismiss() {
    setPhase('hidden');
    if (projectId) {
      void recordWelcomeShown(projectId);
    }
  }

  function dismissAndOpenCode() {
    sendToParent({ type: 'request_panel', panel: 'code' });
    dismiss();
  }

  if (phase !== 'show') return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      onClick={dismiss}
      className="fixed inset-0 z-[2147483646] flex items-center justify-center p-6 bg-black/55 backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] bg-card border border-cream/[0.08] rounded-2xl p-7 shadow-2xl"
      >
        <h2
          id="welcome-title"
          className="text-cream text-xl font-semibold tracking-tight m-0"
        >
          {t('title')}
        </h2>
        <p className="text-cream/85 text-sm leading-relaxed mt-3 mb-1.5">
          {t('greeting')}
        </p>
        <p className="text-cream/60 text-[13px] leading-relaxed mt-0 mb-6">
          {t('orientation')}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={dismiss}
            autoFocus
            className="flex-1 py-2.5 px-3.5 rounded-lg bg-cream text-card text-[13px] font-semibold transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-sodium"
          >
            {t('buttonChat')}
          </button>
          <button
            type="button"
            onClick={dismissAndOpenCode}
            className="flex-1 py-2.5 px-3.5 rounded-lg bg-transparent text-cream text-[13px] font-medium border border-cream/[0.12] transition-colors hover:bg-cream/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-sodium"
          >
            {t('buttonCode')}
          </button>
        </div>
      </div>
    </div>
  );
}
