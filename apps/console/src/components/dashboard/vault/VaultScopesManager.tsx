// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Shield, Plus, Trash2, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getVpsApiUrl } from "@/lib/domains";

interface ScopeRule {
  type: "folder_glob" | "tag" | "frontmatter" | "note_path";
  pattern?: string;
  tag?: string;
  key?: string;
  value?: string;
  op?: "eq" | "neq" | "exists";
  path?: string;
  action: "include" | "exclude";
}

interface ScopeRuleSet {
  default: "include" | "exclude";
  rules: ScopeRule[];
  boundary_disclosure: boolean;
}

interface VaultScope {
  id: number;
  name: string;
  description: string | null;
  rules: ScopeRuleSet;
  isAgentDefault: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface VaultScopesManagerProps {
  serverDomain: string;
  project: string;
}

const inputClasses =
  "text-xs border border-cream/[0.08] bg-transparent rounded-md px-2.5 py-1.5 text-cream/75 focus:outline-none focus:ring-1 focus:ring-sodium/50 placeholder:text-cream/35";

// Custom dropdown matching the PermissionDropdown pattern from TabSecurity
function SelectDropdown<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0]!;

  return (
    <div className={`relative ${className || ""}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs border border-cream/[0.1] rounded-md px-2.5 py-1.5 text-cream/75 hover:border-cream/[0.2] hover:bg-cream/[0.03] transition-colors focus:outline-none focus:ring-1 focus:ring-sodium/50 w-full justify-between"
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown className={`h-3 w-3 text-cream/45 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-full bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl min-w-[140px]">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] transition-colors text-cream/75"
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-3 w-3 text-sodium" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Scope management UI.
export function VaultScopesManager({ serverDomain, project }: VaultScopesManagerProps) {
  const t = useTranslations("console.vault.scopes");
  const [scopes, setScopes] = useState<VaultScope[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expandedScopes, setExpandedScopes] = useState<Set<number>>(new Set());

  // Create form state
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDefault, setNewDefault] = useState<"include" | "exclude">("exclude");
  const [newBoundaryDisclosure, setNewBoundaryDisclosure] = useState(false);
  const [newIsAgentDefault, setNewIsAgentDefault] = useState(false);
  const [newRules, setNewRules] = useState<ScopeRule[]>([]);

  const fetchScopes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${getVpsApiUrl(serverDomain)}/_auth/vault/scopes?project=${encodeURIComponent(project)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        console.warn("[vault-scopes] HTTP", res.status);
        return;
      }
      const data = await res.json();
      setScopes(data.scopes || []);
    } catch (err) {
      console.warn("[vault-scopes] Fetch failed:", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverDomain, project]);

  useEffect(() => {
    fetchScopes();
  }, [fetchScopes]);

  const resetCreateForm = useCallback(() => {
    setNewName("");
    setNewDescription("");
    setNewDefault("exclude");
    setNewBoundaryDisclosure(false);
    setNewIsAgentDefault(false);
    setNewRules([]);
  }, []);

  const createScope = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch(`${getVpsApiUrl(serverDomain)}/_auth/vault/scopes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          project,
          name: newName,
          description: newDescription || undefined,
          isAgentDefault: newIsAgentDefault,
          rules: {
            default: newDefault,
            rules: newRules,
            boundary_disclosure: newBoundaryDisclosure,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t("createFailed"));
        return;
      }
      setShowCreateForm(false);
      resetCreateForm();
      fetchScopes();
    } catch (err) {
      console.error("[vault-scopes] Create failed:", err);
    } finally {
      setCreating(false);
    }
  }, [serverDomain, project, newName, newDescription, newDefault, newBoundaryDisclosure, newIsAgentDefault, newRules, fetchScopes, resetCreateForm, t]);

  const deleteScope = useCallback(async (scopeId: number) => {
    if (!confirm(t("deleteConfirm"))) return;
    try {
      await fetch(
        `${getVpsApiUrl(serverDomain)}/_auth/vault/scopes/${scopeId}?project=${encodeURIComponent(project)}`,
        { method: "DELETE", credentials: "include" },
      );
      fetchScopes();
    } catch (err) {
      console.error("[vault-scopes] Delete failed:", err);
    }
  }, [serverDomain, project, fetchScopes, t]);

  const addRule = useCallback(() => {
    setNewRules((prev) => [
      ...prev,
      { type: "folder_glob", pattern: "**/*.md", action: "include" },
    ]);
  }, []);

  const removeRule = useCallback((index: number) => {
    setNewRules((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateRule = useCallback((index: number, updates: Partial<ScopeRule>) => {
    setNewRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    );
  }, []);

  const toggleScope = useCallback((scopeId: number) => {
    setExpandedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return next;
    });
  }, []);

  const ruleLabel = (rule: ScopeRule): string => {
    switch (rule.type) {
      case "folder_glob":
        return rule.pattern || "";
      case "tag":
        return `#${rule.tag}`;
      case "note_path":
        return rule.path || "";
      case "frontmatter":
        return `${rule.key} ${rule.op} ${rule.value || ""}`;
      default:
        return "";
    }
  };

  if (loading && scopes.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="default" color="muted" label={t("loadingScopes")} />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto flex-1">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="h-4 w-4 text-cream/60" />
            <span className="text-sm font-medium text-cream">{t("title")}</span>
          </div>
          <p className="text-xs text-cream/60">
            {t("subtitle")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
          <Plus className="h-3 w-3" />
          {t("newScope")}
        </Button>
      </div>

      {/* Create scope dialog */}
      <Dialog open={showCreateForm} onOpenChange={setShowCreateForm}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>
              {t("createDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Name and description */}
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider block mb-1.5">
                  {t("name")}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  className={`w-full ${inputClasses}`}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider block mb-1.5">
                  {t("description")}
                </label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder={t("descriptionPlaceholder")}
                  className={`w-full ${inputClasses}`}
                />
              </div>
            </div>

            {/* Options row */}
            <div className="flex items-center gap-4">
              <div>
                <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider block mb-1.5">
                  {t("defaultAction")}
                </label>
                <SelectDropdown
                  value={newDefault}
                  onChange={(v) => setNewDefault(v)}
                  options={[
                    { value: "exclude", label: t("defaultExclude") },
                    { value: "include", label: t("defaultInclude") },
                  ]}
                />
              </div>
              <div className="flex items-center gap-4 pt-4">
                <label className="flex items-center gap-2 text-xs text-cream/75 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newBoundaryDisclosure}
                    onChange={(e) => setNewBoundaryDisclosure(e.target.checked)}
                    className="rounded border-cream/[0.08] bg-transparent"
                  />
                  {t("boundaryDisclosure")}
                </label>
                <label className="flex items-center gap-2 text-xs text-cream/75 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newIsAgentDefault}
                    onChange={(e) => setNewIsAgentDefault(e.target.checked)}
                    className="rounded border-cream/[0.08] bg-transparent"
                  />
                  {t("agentDefault")}
                </label>
              </div>
            </div>

            {/* Rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                  {t("rules")}
                </span>
                <button
                  onClick={addRule}
                  className="text-xs text-sodium hover:text-sodium transition-colors"
                >
                  {t("addRule")}
                </button>
              </div>
              <p className="text-[10px] text-cream/45 mb-3">
                {t("rulesHint")}
              </p>

              {newRules.length === 0 && (
                <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.01] px-3 py-4 text-center">
                  <p className="text-xs text-cream/45">{t("noRulesYet")}</p>
                </div>
              )}

              <div className="space-y-2">
                {newRules.map((rule, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2"
                  >
                    <SelectDropdown
                      value={rule.type}
                      onChange={(v) => updateRule(i, { type: v })}
                      options={[
                        { value: "folder_glob", label: t("ruleTypeFolderGlob") },
                        { value: "tag", label: t("ruleTypeTag") },
                        { value: "frontmatter", label: t("ruleTypeFrontmatter") },
                        { value: "note_path", label: t("ruleTypeNotePath") },
                      ]}
                      className="w-[130px] shrink-0"
                    />

                    {rule.type === "folder_glob" && (
                      <input
                        type="text"
                        value={rule.pattern || ""}
                        onChange={(e) => updateRule(i, { pattern: e.target.value })}
                        placeholder={t("folderGlobPlaceholder")}
                        className={`flex-1 ${inputClasses}`}
                      />
                    )}
                    {rule.type === "tag" && (
                      <input
                        type="text"
                        value={rule.tag || ""}
                        onChange={(e) => updateRule(i, { tag: e.target.value })}
                        placeholder={t("tagPlaceholder")}
                        className={`flex-1 ${inputClasses}`}
                      />
                    )}
                    {rule.type === "note_path" && (
                      <input
                        type="text"
                        value={rule.path || ""}
                        onChange={(e) => updateRule(i, { path: e.target.value })}
                        placeholder={t("notePathPlaceholder")}
                        className={`flex-1 ${inputClasses}`}
                      />
                    )}
                    {rule.type === "frontmatter" && (
                      <>
                        <input
                          type="text"
                          value={rule.key || ""}
                          onChange={(e) => updateRule(i, { key: e.target.value })}
                          placeholder={t("frontmatterKeyPlaceholder")}
                          className={`w-24 ${inputClasses}`}
                        />
                        <SelectDropdown
                          value={(rule.op || "exists") as "exists" | "eq" | "neq"}
                          onChange={(v) => updateRule(i, { op: v })}
                          options={[
                            { value: "exists", label: t("opExists") },
                            { value: "eq", label: t("opEq") },
                            { value: "neq", label: t("opNeq") },
                          ]}
                          className="w-[90px] shrink-0"
                        />
                        {(rule.op === "eq" || rule.op === "neq") && (
                          <input
                            type="text"
                            value={rule.value || ""}
                            onChange={(e) => updateRule(i, { value: e.target.value })}
                            placeholder={t("frontmatterValuePlaceholder")}
                            className={`w-24 ${inputClasses}`}
                          />
                        )}
                      </>
                    )}

                    <SelectDropdown
                      value={rule.action}
                      onChange={(v) => updateRule(i, { action: v })}
                      options={[
                        { value: "include", label: t("actionInclude") },
                        { value: "exclude", label: t("actionExclude") },
                      ]}
                      className="w-[100px] shrink-0"
                    />

                    <button
                      onClick={() => removeRule(i)}
                      className="p-1 rounded text-cream/45 hover:text-terra hover:bg-terra/10 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={createScope} disabled={!newName.trim()} loading={creating}>
              {t("createScope")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scope list */}
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
            {t("activeScopes")}
          </span>
          {loading && <Spinner size="xs" color="muted" />}
        </div>

        {scopes.length === 0 && !loading && (
          <div className="text-center py-8">
            <Shield className="h-8 w-8 mx-auto text-cream/35 mb-3" />
            <p className="text-xs text-cream/60">{t("noScopesDefined")}</p>
            <p className="text-[10px] text-cream/45 mt-1">
              {t("noScopesHint")}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          {scopes.map((scope) => (
            <div key={scope.id}>
              {/* Collapsed row */}
              <button
                onClick={() => toggleScope(scope.id)}
                className="w-full flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2.5 hover:bg-cream/[0.04] transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {expandedScopes.has(scope.id) ? (
                    <ChevronDown className="h-3 w-3 text-cream/45 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-cream/45 shrink-0" />
                  )}
                  <span className="text-xs font-medium text-cream truncate">{scope.name}</span>

                  {scope.isAgentDefault && (
                    <Badge className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium font-medium border-0">
                      {t("agentDefaultBadge")}
                    </Badge>
                  )}
                  {scope.rules.boundary_disclosure && (
                    <Badge className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium font-medium border-0">
                      {t("boundaryDisclosureBadge")}
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-cream/45">
                    {t("rulesCount", { count: scope.rules.rules.length })}
                  </span>
                  <span className="text-[10px] text-cream/45">{t("version", { version: scope.version })}</span>
                </div>
              </button>

              {/* Expanded detail */}
              {expandedScopes.has(scope.id) && (
                <div className="mt-px rounded-lg border border-cream/[0.06] bg-cream/[0.01] px-3 py-3 space-y-3">
                  {scope.description && (
                    <p className="text-xs text-cream/60">{scope.description}</p>
                  )}

                  <div>
                    <span className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                      {t("rulesLabel")}
                    </span>
                    <span className="text-[10px] text-cream/45 ml-2">
                      {t("defaultPrefix", { default: scope.rules.default })}
                    </span>
                  </div>

                  {scope.rules.rules.length === 0 && (
                    <p className="text-[10px] text-cream/45">
                      {t("noRulesDefault", { default: scope.rules.default })}
                    </p>
                  )}

                  <div className="space-y-1">
                    {scope.rules.rules.map((rule, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                            rule.action === "include"
                              ? "bg-green-500/10 text-green-400"
                              : "bg-terra/10 text-terra"
                          }`}
                        >
                          {rule.action}
                        </span>
                        <span className="text-cream/45">{rule.type}:</span>
                        <span className="font-mono text-cream/75">{ruleLabel(rule)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end pt-1 border-t border-cream/[0.04]">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-terra hover:text-terra hover:bg-terra/10"
                      onClick={() => deleteScope(scope.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("delete")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
