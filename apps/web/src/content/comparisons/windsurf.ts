import { defineComparison } from "./schema";

export default defineComparison({
  slug: "windsurf",
  competitor: {
    name: "Windsurf",
    domain: "windsurf.com",
    url: "https://windsurf.com",
  },
  features: [
    { id: "where-agent-runs", advantage: "ellul" },
    { id: "survives-lid-close", ellul: true, competitor: false, advantage: "ellul" },
    { id: "editor-experience", advantage: "competitor" },
    { id: "inline-completions", advantage: "competitor" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "privileged-action-gating", advantage: "ellul" },
    { id: "credentials-location", advantage: "ellul" },
    { id: "long-running-tasks", advantage: "ellul" },
    { id: "phone-approvals", competitor: false, advantage: "ellul" },
    { id: "byom", advantage: "ellul" },
    { id: "editor-base-source", advantage: "tie" },
    { id: "vendor-independence", advantage: "ellul" },
  ],
  tags: ["windsurf", "codeium", "editor", "cascade", "remote-agent"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["cursor-remote-agents", "run-claude-code-in-cloud"],
  sources: [
    { url: "https://windsurf.com", claim: "Product site" },
    { url: "https://windsurf.com/pricing", claim: "Pricing tiers" },
    { url: "https://cognition.ai", claim: "Cognition acquisition of Windsurf (mid-2025)" },
    { url: "https://windsurf.com/blog/windsurf-rebrand-announcement", claim: "Windsurf Editor launched November 2024; full Codeium-to-Windsurf rebrand completed April 2025" },
  ],
});
