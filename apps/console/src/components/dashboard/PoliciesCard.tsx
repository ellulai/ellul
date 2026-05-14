// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  Lock,
  Trash2,
  Code2,
  Plus,
  Pencil,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useVpsBridge } from "@/lib/vps-bridge";

// ── Types ─────────────────────────────────────────────────────

interface PolicyRule {
  id: string;
  scope: string;
  language: string;
  name: string;
  description: string;
  severity: string;
  message: string;
  query_scm: string;
  enabled: boolean;
  locked: boolean;
}

// ── Language Config ───────────────────────────────────────────

// Supported languages with brand colors and display names.
const SUPPORTED_LANGUAGES = [
  { id: "go",         label: "Go",         short: "Go",   color: "text-cyan-400 border-cyan-400/30 bg-cyan-400/5" },
  { id: "python",     label: "Python",     short: "Py",   color: "text-[#3776AB] border-[#3776AB]/30 bg-[#3776AB]/5" },
  { id: "javascript", label: "JavaScript", short: "JS",   color: "text-[#F7DF1E] border-[#F7DF1E]/30 bg-[#F7DF1E]/5" },
  { id: "typescript", label: "TypeScript", short: "TS",   color: "text-[#3178C6] border-[#3178C6]/30 bg-[#3178C6]/5" },
  { id: "rust",       label: "Rust",       short: "Rs",   color: "text-[#CE422B] border-[#CE422B]/30 bg-[#CE422B]/5" },
  { id: "ruby",       label: "Ruby",       short: "Rb",   color: "text-[#CC342D] border-[#CC342D]/30 bg-[#CC342D]/5" },
  { id: "java",       label: "Java",       short: "Java", color: "text-[#ED8B00] border-[#ED8B00]/30 bg-[#ED8B00]/5" },
  { id: "kotlin",     label: "Kotlin",     short: "Kt",   color: "text-[#7F52FF] border-[#7F52FF]/30 bg-[#7F52FF]/5" },
  { id: "swift",      label: "Swift",      short: "Sw",   color: "text-[#F05138] border-[#F05138]/30 bg-[#F05138]/5" },
  { id: "php",        label: "PHP",        short: "PHP",  color: "text-[#777BB4] border-[#777BB4]/30 bg-[#777BB4]/5" },
  { id: "csharp",     label: "C#",         short: "C#",   color: "text-[#512BD4] border-[#512BD4]/30 bg-[#512BD4]/5" },
  { id: "cpp",        label: "C++",        short: "C++",  color: "text-[#00599C] border-[#00599C]/30 bg-[#00599C]/5" },
  { id: "c",          label: "C",          short: "C",    color: "text-[#A8B9CC] border-[#A8B9CC]/30 bg-[#A8B9CC]/5" },
] as const;

const LANG_MAP: Map<string, (typeof SUPPORTED_LANGUAGES)[number]> = new Map(SUPPORTED_LANGUAGES.map((l) => [l.id, l]));
const FALLBACK_STYLE = "text-cream/60 border-cream/[0.08]/30 bg-cream/[0.03]";

function getLangDisplay(id: string) {
  const known = LANG_MAP.get(id);
  if (known) return { label: known.short, color: known.color };
  return {
    label: id.length <= 3 ? id.charAt(0).toUpperCase() + id.slice(1) : id.charAt(0).toUpperCase() + id.slice(1, 3),
    color: FALLBACK_STYLE,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function stripPrefix(text: string): string {
  return text.replace(/^ELLUL_\w+:\s*/i, "");
}

function extractLanguages(rule: PolicyRule): string[] {
  if (rule.language !== "multi") return [rule.language];
  return extractLangsFromSCM(rule.query_scm);
}

function extractLangsFromSCM(scm: string): string[] {
  const langs: string[] = [];
  for (const line of scm.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("; @lang ")) {
      for (const l of trimmed.slice("; @lang ".length).trim().split(/\s+/)) {
        if (l && !langs.includes(l)) langs.push(l);
      }
    }
  }
  return langs;
}

function LanguageBadges({ languages }: { languages: string[] }) {
  return (
    <div className="flex items-center gap-0.5">
      {languages.map((lang) => {
        const d = getLangDisplay(lang);
        return (
          <Badge key={lang} variant="outline" className={`text-[9px] px-1 py-0 font-mono ${d.color}`}>
            {d.label}
          </Badge>
        );
      })}
    </div>
  );
}

// Parse an existing .scm source into per-language sections for the editor.
function parseSCMSections(scm: string): Array<{ langs: string[]; body: string }> {
  const sections: Array<{ langs: string[]; body: string }> = [];
  let currentLangs: string[] = [];
  let currentLines: string[] = [];

  for (const line of scm.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("; @lang ")) {
      if (currentLangs.length > 0 && currentLines.length > 0) {
        sections.push({ langs: currentLangs, body: currentLines.join("\n").trim() });
      }
      currentLangs = trimmed.slice("; @lang ".length).trim().split(/\s+/);
      currentLines = [];
      continue;
    }
    if (currentLangs.length > 0 && trimmed !== "" && !trimmed.startsWith(";")) {
      currentLines.push(line);
    }
  }
  if (currentLangs.length > 0 && currentLines.length > 0) {
    sections.push({ langs: currentLangs, body: currentLines.join("\n").trim() });
  }
  return sections;
}

type SCMValidator = {
  noSections: string;
  unknownLang: (lang: string, supported: string) => string;
  emptyBody: (langs: string) => string;
  missingViolation: (langs: string) => string;
};

// Validate a .scm source before saving.
function validateSCM(scm: string, t: SCMValidator): string | null {
  const sections = parseSCMSections(scm);
  if (sections.length === 0) return t.noSections;

  for (const section of sections) {
    for (const lang of section.langs) {
      if (!LANG_MAP.has(lang)) {
        return t.unknownLang(lang, SUPPORTED_LANGUAGES.map((l) => l.id).join(", "));
      }
    }
    if (!section.body.trim()) return t.emptyBody(section.langs.join(", "));
    if (!section.body.includes("@violation")) return t.missingViolation(section.langs.join(", "));
  }
  return null;
}

// ── Main Card ─────────────────────────────────────────────────

// ── API abstraction (bridge vs direct) ──────────────────────

interface GuardrailApi {
  listRules: () => Promise<{ rules: PolicyRule[]; total: number }>;
  toggleRule: (id: string, enabled: boolean) => Promise<unknown>;
  deleteRule: (id: string) => Promise<unknown>;
  createRule: (rule: Record<string, unknown>) => Promise<unknown>;
}

function useGuardrailApi(serverDomain: string, tier: string): GuardrailApi {
  const t = useTranslations("console.policies");
  const { send } = useVpsBridge();
  const base = `https://${serverDomain}`;
  const headers = { "Content-Type": "application/json" };
  const opts = { credentials: "include" as const };

  if (tier !== "standard") {
    return {
      listRules: () => send<{ rules: PolicyRule[]; total: number }>("guardrail_rules"),
      toggleRule: (id, enabled) => send("guardrail_toggle", { id, enabled }),
      deleteRule: (id) => send("guardrail_delete", { id }),
      createRule: (rule) => send("guardrail_create", { rule }),
    };
  }
  return {
    listRules: async () => {
      const res = await fetch(`${base}/_auth/guardrail/rules`, opts);
      if (!res.ok) throw new Error(t("errors.fetchPolicies"));
      return res.json() as Promise<{ rules: PolicyRule[]; total: number }>;
    },
    toggleRule: async (id, enabled) => {
      const res = await fetch(`${base}/_auth/guardrail/rules/${encodeURIComponent(id)}/toggle`, {
        method: "PATCH", ...opts, headers, body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t("errors.generic"));
    },
    deleteRule: async (id) => {
      const res = await fetch(`${base}/_auth/guardrail/rules/${encodeURIComponent(id)}`, {
        method: "DELETE", ...opts,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t("errors.generic"));
    },
    createRule: async (rule) => {
      const res = await fetch(`${base}/_auth/guardrail/rules`, {
        method: "POST", ...opts, headers, body: JSON.stringify(rule),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t("errors.createFailed"));
      return res.json();
    },
  };
}

export function PoliciesCard({ serverDomain, tier }: { serverDomain: string; tier: string }) {
  const t = useTranslations("console.policies");
  const queryClient = useQueryClient();
  const api = useGuardrailApi(serverDomain, tier);
  const [modalState, setModalState] = useState<
    | { mode: "view"; rule: PolicyRule }
    | { mode: "edit"; rule: PolicyRule }
    | { mode: "create" }
    | null
  >(null);

  const { data, isLoading } = useQuery({
    queryKey: ["policies", serverDomain],
    queryFn: () => api.listRules(),
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleRule(id, enabled),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["policies"] }); toast.success(t("policyUpdated")); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["policies"] }); toast.success(t("policyDeleted")); },
    onError: (err: Error) => toast.error(err.message),
  });

  const rules = data?.rules ?? [];
  const safetyRules = rules.filter((r) => r.locked);
  const qualityRules = rules.filter((r) => !r.locked && r.scope === "global");
  const customRules = rules.filter((r) => !r.locked && r.scope === "workspace");

  return (
    <>
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Shield className="h-4 w-4 text-cream/60" />
              <span className="text-sm font-medium text-cream">{t("title")}</span>
            </div>
            <p className="text-xs text-cream/60">{t("subtitle")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setModalState({ mode: "create" })}>
            <Plus className="h-3 w-3" />
            {t("addPolicy")}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-6"><Spinner className="h-4 w-4" /></div>
        ) : rules.length === 0 ? (
          <p className="text-xs text-cream/45 py-2">{t("noPolicies")}</p>
        ) : (
          <>
            {safetyRules.length > 0 && (
              <PolicySection label={t("section.safety")} description={t("section.safetyDesc")} rules={safetyRules}
                onToggle={(id, en) => toggleMutation.mutate({ id, enabled: en })} onDelete={() => {}}
                onView={(r) => setModalState({ mode: "view", rule: r })} onEdit={() => {}} showDelete={false} showEdit={false} />
            )}
            {qualityRules.length > 0 && (
              <PolicySection label={t("section.codeQuality")} description={t("section.codeQualityDesc")} rules={qualityRules}
                onToggle={(id, en) => toggleMutation.mutate({ id, enabled: en })} onDelete={() => {}}
                onView={(r) => setModalState({ mode: "view", rule: r })} onEdit={(r) => setModalState({ mode: "edit", rule: r })} showDelete={false} showEdit={true} />
            )}
            {customRules.length > 0 && (
              <PolicySection label={t("section.custom")} description={t("section.customDesc")} rules={customRules}
                onToggle={(id, en) => toggleMutation.mutate({ id, enabled: en })} onDelete={(id) => deleteMutation.mutate(id)}
                onView={(r) => setModalState({ mode: "view", rule: r })} onEdit={(r) => setModalState({ mode: "edit", rule: r })} showDelete={true} showEdit={true} />
            )}
          </>
        )}
      </div>

      {/* Dialog for view / edit / create */}
      <Dialog open={modalState !== null} onOpenChange={(open) => { if (!open) setModalState(null); }}>
        {modalState && (
          <PolicyDialog
            state={modalState}
            api={api}
            onClose={() => setModalState(null)}
            onSaved={() => { setModalState(null); queryClient.invalidateQueries({ queryKey: ["policies"] }); }}
          />
        )}
      </Dialog>
    </>
  );
}

// ── Section & Row ─────────────────────────────────────────────

function PolicySection({ label, description, rules, onToggle, onDelete, onView, onEdit, showDelete, showEdit }: {
  label: string; description: string; rules: PolicyRule[];
  onToggle: (id: string, enabled: boolean) => void; onDelete: (id: string) => void;
  onView: (r: PolicyRule) => void; onEdit: (r: PolicyRule) => void; showDelete: boolean; showEdit: boolean;
}) {
  const t = useTranslations("console.policies");
  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">{label}</p>
        <p className="text-[10px] text-cream/45 mt-0.5">{description}</p>
      </div>
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {rule.locked && <Lock className="h-3 w-3 text-cream/45 shrink-0" />}
            <div className="min-w-0">
              <span className="text-xs font-medium text-cream/85">{rule.name}</span>
              <p className="text-[10px] text-cream/45 truncate max-w-[280px]">{stripPrefix(rule.description || rule.message)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <LanguageBadges languages={extractLanguages(rule)} />
            <button type="button" onClick={() => onView(rule)} className="p-1 rounded hover:bg-cream/[0.06] transition-colors text-cream/45 hover:text-cream/75" title={t("viewSource")}>
              <Code2 className="h-3 w-3" />
            </button>
            {showEdit && !rule.locked && (
              <button type="button" onClick={() => onEdit(rule)} className="p-1 rounded hover:bg-cream/[0.06] transition-colors text-cream/45 hover:text-cream/75" title={t("edit")}>
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {showDelete && !rule.locked && (
              <button type="button" onClick={() => onDelete(rule.id)} className="p-1 rounded hover:bg-cream/[0.06] transition-colors text-cream/45 hover:text-terra" title={t("delete")}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
            <Switch checked={rule.enabled} onCheckedChange={(checked) => onToggle(rule.id, checked)} disabled={rule.locked} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Policy Dialog (view / edit / create) ──────────────────────

type ModalState = { mode: "view"; rule: PolicyRule } | { mode: "edit"; rule: PolicyRule } | { mode: "create" };

function PolicyDialog({ state, api, onClose, onSaved }: {
  state: ModalState; api: GuardrailApi; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations("console.policies");
  const isCreate = state.mode === "create";
  const isEdit = state.mode === "edit";
  const isReadOnly = state.mode === "view";
  const existingRule = "rule" in state ? state.rule : null;

  const [name, setName] = useState(existingRule?.name ?? "");
  const [description, setDescription] = useState(existingRule?.description ?? "");
  const [message, setMessage] = useState(existingRule ? stripPrefix(existingRule.message) : "");
  const [severity, setSeverity] = useState(existingRule?.severity ?? "error");
  const [queryBody, setQueryBody] = useState(
    existingRule?.query_scm ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setError("");

    // Validate fields
    if (!name.trim()) { setError(t("errors.nameRequired")); return; }
    if (!/^[a-z][a-z0-9-]*$/.test(name.trim())) { setError(t("errors.nameInvalid")); return; }
    if (!message.trim()) { setError(t("errors.messageRequired")); return; }
    if (!queryBody.trim()) { setError(t("errors.queryRequired")); return; }

    // Validate .scm syntax
    const scmError = validateSCM(queryBody, {
      noSections: t("errors.noLangSections"),
      unknownLang: (lang, supported) => t("errors.unknownLang", { lang, supported }),
      emptyBody: (langs) => t("errors.emptyBody", { langs }),
      missingViolation: (langs) => t("errors.missingViolation", { langs }),
    });
    if (scmError) { setError(scmError); return; }

    setSaving(true);
    try {
      const fullSCM = queryBody.trim();
      const rulePayload = {
        scope: isEdit && existingRule ? existingRule.scope : "workspace",
        language: "multi",
        name: name.trim(),
        description: description.trim(),
        query_scm: fullSCM,
        severity,
        message: message.trim(),
      };

      if (isCreate) {
        await api.createRule(rulePayload);
        toast.success(t("policyCreated"));
      } else if (isEdit && existingRule) {
        // Delete + recreate (non-locked only)
        await api.deleteRule(existingRule.id);
        await api.createRule(rulePayload);
        toast.success(t("policySaved"));
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const displayLangs = isReadOnly && existingRule ? extractLanguages(existingRule) : extractLangsFromSCM(queryBody);

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <div className="flex items-center gap-2">
          <DialogTitle className="text-base">
            {isCreate ? t("newPolicy") : isEdit ? t("editPolicy") : existingRule?.name}
          </DialogTitle>
          {!isCreate && existingRule?.locked && <Lock className="h-3.5 w-3.5 text-cream/45" />}
          {displayLangs.length > 0 && <LanguageBadges languages={displayLangs} />}
        </div>
        <DialogDescription>
          {isCreate
            ? t("newPolicyDescription")
            : isEdit
            ? t("editPolicyDescription")
            : stripPrefix(existingRule?.description || existingRule?.message || "")}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 max-h-[60vh] overflow-y-auto px-0.5">
        {/* Name */}
        {(isCreate || isEdit) && (
          <div className="space-y-1.5">
            <Label className="text-xs text-cream/60">{t("name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} disabled={isEdit} className="text-sm" />
            <p className="text-[10px] text-cream/45">{t("nameHint")}</p>
          </div>
        )}

        {/* Description */}
        {(isCreate || isEdit) ? (
          <div className="space-y-1.5">
            <Label className="text-xs text-cream/60">{t("description")}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("descriptionPlaceholder")} className="text-sm" />
          </div>
        ) : existingRule?.description ? (
          <div className="space-y-1">
            <Label className="text-xs text-cream/60">{t("description")}</Label>
            <p className="text-sm text-cream/75">{existingRule.description}</p>
          </div>
        ) : null}

        {/* Severity */}
        {(isCreate || isEdit) && (
          <div className="space-y-1.5">
            <Label className="text-xs text-cream/60">{t("severity")}</Label>
            <div className="flex gap-2">
              {(["error", "warning"] as const).map((s) => (
                <button key={s} type="button" onClick={() => setSeverity(s)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                    severity === s
                      ? s === "error" ? "border-terra/40 bg-terra/10 text-terra" : "border-sodium/40 bg-sodium/10 text-sodium"
                      : "border-cream/[0.08] text-cream/45 hover:border-cream/[0.15]"
                  }`}
                >
                  {s === "error" ? t("severityError") : t("severityWarning")}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error message */}
        {(isCreate || isEdit) ? (
          <div className="space-y-1.5">
            <Label className="text-xs text-cream/60">{t("errorMessage")}</Label>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder={t("errorMessagePlaceholder")}
              rows={2} className="w-full text-sm bg-transparent border border-input rounded-md px-3 py-2 text-cream/85 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none" />
            <p className="text-[10px] text-cream/45">{t("errorMessageHint")}</p>
          </div>
        ) : existingRule ? (
          <div className="space-y-1">
            <Label className="text-xs text-cream/60">{t("errorMessage")}</Label>
            <p className="text-sm text-cream/60 bg-black/20 border border-cream/[0.04] rounded-lg px-3 py-2">
              {stripPrefix(existingRule.message)}
            </p>
          </div>
        ) : null}

        {/* Query source */}
        <div className="space-y-1.5">
          <Label className="text-xs text-cream/60">{t("treeSitterQuery")}</Label>
          {isReadOnly ? (
            <pre className="bg-black/40 border border-cream/[0.06] rounded-lg p-4 text-xs text-cream/75 font-mono overflow-x-auto max-h-[300px] overflow-y-auto leading-relaxed">
              {existingRule?.query_scm}
            </pre>
          ) : (
            <>
              <textarea value={queryBody} onChange={(e) => setQueryBody(e.target.value)} rows={14} spellCheck={false}
                placeholder={`; @lang python\n(call\n  function: (identifier) @fn\n  (#eq? @fn "eval")) @violation\n\n; @lang javascript typescript\n(call_expression\n  function: (identifier) @fn\n  (#eq? @fn "eval")) @violation`}
                className="w-full text-xs font-mono bg-black/40 border border-cream/[0.06] rounded-lg p-4 text-cream/75 placeholder:text-cream/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y leading-relaxed" />
              <p className="text-[10px] text-cream/45">
                {t("queryHintPrefix")} <code className="text-cream/60">; @lang go python</code> {t("queryHintMiddle")} <code className="text-cream/60">@violation</code> {t("queryHintSuffix")}
              </p>
            </>
          )}
        </div>

        {/* Validation error */}
        {error && (
          <div className="text-xs text-terra bg-terra/10 border border-terra/20 rounded-lg px-3 py-2">{error}</div>
        )}
      </div>

      {/* Footer */}
      {!isReadOnly && (
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("cancel")}</Button>
          <Button size="sm" onClick={handleSave} loading={saving}>
            {isCreate ? t("create") : t("saveChanges")}
          </Button>
        </DialogFooter>
      )}
    </DialogContent>
  );
}
