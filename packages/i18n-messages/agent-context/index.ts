// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Agent context templates (Phase 7a-NATIVE Layer 2)
 *
 * Per-locale instruction files shipped with every freshly scaffolded
 * project. The user's preferred locale at scaffold time decides which
 * variant lands; runtime locale toggles surface a mismatch banner
 * (Layer 6) instead of silently rewriting user-owned files.
 *
 * Files emitted:
 *   - CLAUDE.md                  (Anthropic Claude Code)
 *   - AGENTS.md                  (universal — Codex CLI, OpenCode, others)
 *   - .cursor/rules/main.mdc     (Cursor — modern v0.50+ format)
 *
 * GEMINI.md intentionally absent (Phase 6a — no Gemini integration).
 *
 * Each variant opens with `<!-- ellul:locale=<code> -->` so the toggle-
 * mismatch detector can read createdLocale from .ellul/project.json
 * and confirm against the file's frontmatter without parsing prose.
 *
 * Files live in this package alongside every other translatable asset
 * (UI namespaces, vpsShell strings). The static-text esbuild plugin in
 * the consumer's bundler (vps' tsup) inlines the .md content as
 * strings. The `*.md` declaration in `src/assets.d.ts` keeps tsc happy
 * for callers that don't bundle.
 */

import claudeEn from './claude/en.md';
import claudeJa from './claude/ja.md';
import agentsEn from './agents/en.md';
import agentsJa from './agents/ja.md';
import cursorRulesEn from './cursor-rules/en.md';
import cursorRulesJa from './cursor-rules/ja.md';

import type { Locale } from '@ellul.ai/i18n-consts';

interface VariantSet {
  claude: string;
  agents: string;
  cursorRules: string;
}

const VARIANTS: Partial<Record<Locale, VariantSet>> = {
  en: { claude: claudeEn, agents: agentsEn, cursorRules: cursorRulesEn },
  ja: { claude: claudeJa, agents: agentsJa, cursorRules: cursorRulesJa },
};

/**
 * Returns a map of relative file paths → content. Caller writes each
 * entry into the freshly scaffolded project directory.
 *
 * Falls back to en for any locale without a translated set yet
 * (ko/de/pt-BR/fr today). The fallback is silent because Layer 6's
 * mismatch banner already covers "you toggled to a locale that hasn't
 * shipped per-locale rules yet" via .ellul/project.json.
 */
export function getAgentContextFiles(locale: Locale): Record<string, string> {
  const set = VARIANTS[locale] ?? VARIANTS.en!;
  return {
    'CLAUDE.md': set.claude,
    'AGENTS.md': set.agents,
    '.cursor/rules/main.mdc': set.cursorRules,
  };
}

/**
 * Locales for which we ship native-translated agent context. Exposed
 * so scaffolders can record this in .ellul/project.json or surface
 * mismatch UI without re-importing every variant.
 */
export const AGENT_CONTEXT_LOCALES: readonly Locale[] = Object.keys(VARIANTS) as readonly Locale[];

/**
 * Per-locale language directive injected into the platform context
 * (CLAUDE.md / AGENTS.md ELLUL marker block) at runtime by ellul-ctx.
 *
 * Tells the AI agent which language to use for human-readable text
 * while keeping code identifiers in English.
 */
export const LOCALE_DIRECTIVES: Record<Locale, string> = {
  en: '**Language**: Respond in English. Chat replies, commit messages, PR descriptions, READMEs, and business-logic comments in English. Code identifiers stay English always.',
  ja: '**Language**: 日本語で応答してください。チャット返信、コミットメッセージ、PR説明、README、ビジネスロジックのコメントは日本語で記述してください。コード識別子（変数名、関数名、型名）は常に英語のままにしてください。',
  ko: '**Language**: 한국어로 응답하세요. 채팅 응답, 커밋 메시지, PR 설명, README, 비즈니스 로직 주석은 한국어로 작성하세요. 코드 식별자(변수명, 함수명, 타입명)는 항상 영어로 유지하세요.',
  de: '**Language**: Antworte auf Deutsch. Chat-Antworten, Commit-Messages, PR-Beschreibungen, READMEs und Kommentare zur Geschäftslogik auf Deutsch. Code-Bezeichner (Variablen, Funktionen, Typen) bleiben immer auf Englisch.',
  'pt-BR': '**Language**: Responda em português. Respostas de chat, mensagens de commit, descrições de PR, READMEs e comentários de lógica de negócio em português. Identificadores de código (variáveis, funções, tipos) permanecem sempre em inglês.',
  fr: '**Language**: Répondez en français. Réponses de chat, messages de commit, descriptions de PR, READMEs et commentaires de logique métier en français. Les identifiants de code (variables, fonctions, types) restent toujours en anglais.',
};
