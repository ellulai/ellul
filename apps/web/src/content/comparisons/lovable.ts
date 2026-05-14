import { defineComparison } from "./schema";

export default defineComparison({
  slug: "lovable",
  competitor: {
    name: "Lovable",
    domain: "lovable.dev",
    url: "https://lovable.dev",
  },
  features: [
    { id: "target-user", advantage: "tie" },
    { id: "output", advantage: "tie" },
    { id: "codebase-ownership", advantage: "ellul" },
    { id: "byoa", advantage: "ellul" },
    { id: "byom", advantage: "ellul" },
    { id: "persistent-workstation", advantage: "ellul" },
    { id: "real-credential-ops", advantage: "ellul" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "hosting-deployment", advantage: "ellul" },
    { id: "time-to-first-v0", advantage: "competitor" },
    { id: "editor-experience", advantage: "ellul" },
    { id: "best-fit", advantage: "tie" },
  ],
  tags: ["lovable", "app-builder", "non-coder", "react", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud"],
  sources: [
    { url: "https://lovable.dev", claim: "Product site" },
    { url: "https://lovable.dev/pricing", claim: "Pricing tiers (Q1 2026)" },
    { url: "https://lovable.dev/blog", claim: "GitHub export announcement; Series A funding (2025)" },
  ],
});
