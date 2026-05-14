import { defineComparison } from "./schema";

export default defineComparison({
  slug: "devin",
  competitor: {
    name: "Devin",
    domain: "cognition.ai",
    url: "https://cognition.ai",
  },
  features: [
    { id: "byoa", advantage: "ellul" },
    { id: "byom", advantage: "ellul" },
    { id: "codebase-ownership", advantage: "tie" },
    { id: "persistent-workstation", advantage: "ellul" },
    { id: "real-credential-ops", advantage: "ellul" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "editor-experience", advantage: "tie" },
    { id: "always-on-agent", advantage: "ellul" },
    { id: "phone-approvals", advantage: "tie" },
    { id: "pricing-model", advantage: "ellul" },
    { id: "scope-of-work", advantage: "tie" },
    { id: "open-ecosystem", advantage: "ellul" },
  ],
  tags: ["devin", "cognition", "managed-agent", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud", "overnight-refactors"],
  sources: [
    { url: "https://cognition.ai", claim: "Cognition product site and Devin announcements" },
    { url: "https://devin.ai/pricing/", claim: "Devin 2.0 pricing: Core $20/mo PAYG at $2.25/ACU (April 2025)" },
    { url: "https://cognition.ai", claim: "Cognition / Windsurf acquisition (mid-2025)" },
  ],
});
