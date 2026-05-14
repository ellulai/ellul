// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Locale-mismatch banner (Phase 7a-NATIVE Layer 6)
 *
 * Renders when the user's current chrome locale (from
 * window.__SHIELD_SETTINGS__.locale) differs from the active project's
 * createdLocale (recorded in .ellul/project.json by the scaffolder).
 * Tells the user that their CLAUDE.md / AGENTS.md / .cursor rules are
 * still in the project's authored language.
 *
 * Detection inputs:
 *   - Current locale: useLocale() — listens for set_locale postMessages
 *     so a runtime toggle re-evaluates without a reload.
 *   - createdLocale: fetched from /api/project-meta. Null for
 *     cloned/imported projects → banner does NOT render.
 *
 * Dismissal: localStorage scoped to (projectId, newLocale). Re-renders
 * if the user toggles to yet another locale on the same project.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useLocale } from './i18n/useLocale';
import { ALL_LOCALES, type Locale } from '@ellul.ai/i18n-consts';

const STORAGE_PREFIX = 'ellul:locale-mismatch-dismissed';

function dismissKey(projectId: string, newLocale: string): string {
  return `${STORAGE_PREFIX}:${projectId}:${newLocale}`;
}

function isDismissed(projectId: string, newLocale: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(projectId, newLocale)) === '1';
  } catch {
    return false;
  }
}

function markDismissed(projectId: string, newLocale: string): void {
  try {
    window.localStorage.setItem(dismissKey(projectId, newLocale), '1');
  } catch {
    // private mode / quota — banner just won't persist dismissal
  }
}

interface AppsApiResponse {
  active?: { app?: string | null };
}

interface ProjectMeta {
  createdLocale?: string | null;
}

interface ActiveProject {
  projectId: string;
  createdLocale: Locale;
}

async function fetchActiveProject(): Promise<ActiveProject | null> {
  try {
    const appsRes = await fetch('/api/apps', { credentials: 'include' });
    if (!appsRes.ok) return null;
    const appsData = (await appsRes.json()) as AppsApiResponse;
    const activeApp = appsData.active?.app;
    if (!activeApp) return null;

    const metaUrl = `/api/project-meta?project=${encodeURIComponent(activeApp)}`;
    const metaRes = await fetch(metaUrl, { credentials: 'include' });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as ProjectMeta | null;
    if (!meta || typeof meta.createdLocale !== 'string') return null;
    if (!(ALL_LOCALES as readonly string[]).includes(meta.createdLocale)) return null;

    return { projectId: activeApp, createdLocale: meta.createdLocale as Locale };
  } catch {
    return null;
  }
}

export function LocaleMismatchBanner() {
  const t = useTranslations('localeMismatch');
  const currentLocale = useLocale();
  const [active, setActive] = useState<ActiveProject | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchActiveProject().then((res) => {
      if (cancelled) return;
      setActive(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-evaluate dismissal whenever the active project resolves OR the
  // current locale changes (mid-session toggle via set_locale postMessage).
  // The dismiss key is per-(projectId, newLocale), so toggling to a third
  // locale brings the banner back even if the prior locale was dismissed.
  useEffect(() => {
    if (!active) {
      setDismissed(false);
      return;
    }
    setDismissed(isDismissed(active.projectId, currentLocale));
  }, [active, currentLocale]);

  if (!active) return null;
  if (active.createdLocale === currentLocale) return null;
  if (dismissed) return null;

  function handleDismiss() {
    if (!active) return;
    markDismissed(active.projectId, currentLocale);
    setDismissed(true);
  }

  // Type-safe localized locale-name lookup. Each branch references a
  // statically-known message id so the IntlMessages type-check is honoured —
  // no `as never` escape hatches. Order matches ALL_LOCALES for review ease.
  function localeName(code: Locale): string {
    switch (code) {
      case 'en': return t('localeNames.en');
      case 'ja': return t('localeNames.ja');
      case 'ko': return t('localeNames.ko');
      case 'de': return t('localeNames.de');
      case 'pt-BR': return t('localeNames.pt-BR');
      case 'fr': return t('localeNames.fr');
    }
  }

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-50 flex items-start gap-2.5 px-3.5 py-2 bg-card border-b border-sodium/30 text-cream/85"
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-semibold text-sodium leading-tight">
          {t('title', { newLocale: localeName(currentLocale) })}
        </div>
        <div className="text-[12px] text-cream/65 leading-snug mt-0.5">
          {t('body', {
            newLocale: localeName(currentLocale),
            createdLocale: localeName(active.createdLocale),
          })}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium text-sodium/90 border border-sodium/30 bg-sodium/[0.06] hover:bg-sodium/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sodium transition-colors"
      >
        {t('dismiss')}
      </button>
    </div>
  );
}
