import { defineComparison } from "./schema";

export default defineComparison({
  slug: "base44",
  competitor: {
    name: "Base44",
    domain: "base44.com",
    url: "https://base44.com",
  },
  features: [
    { id: "target-user", advantage: "tie" },
    { id: "output", advantage: "tie" },
    { id: "codebase-ownership", advantage: "ellul" },
    { id: "byoa", advantage: "ellul" },
    { id: "real-credential-ops", advantage: "ellul" },
    { id: "persistent-workstation", advantage: "ellul" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "hosting-deployment", advantage: "ellul" },
    { id: "time-to-first-v0", advantage: "competitor" },
    { id: "integration-existing-stack", advantage: "ellul" },
    { id: "open-ecosystem", advantage: "ellul" },
    { id: "best-fit", advantage: "tie" },
  ],
  tags: ["base44", "wix", "app-builder", "non-coder", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud"],
  sources: [
    { url: "https://base44.com", claim: "Product site" },
    { url: "https://www.wix.com", claim: "Wix acquisition of Base44 (mid-2025)" },
    { url: "https://base44.com/pricing", claim: "Pricing tiers" },
  ],
});
