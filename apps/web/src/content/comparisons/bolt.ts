import { defineComparison } from "./schema";

export default defineComparison({
  slug: "bolt",
  competitor: {
    name: "Bolt",
    domain: "bolt.new",
    url: "https://bolt.new",
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
    { id: "in-browser-execution", advantage: "competitor" },
    { id: "time-to-first-app", advantage: "competitor" },
    { id: "editor-experience", advantage: "tie" },
    { id: "best-fit", advantage: "tie" },
  ],
  tags: ["bolt", "stackblitz", "app-builder", "webcontainer", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud"],
  sources: [
    { url: "https://bolt.new", claim: "Product site" },
    { url: "https://stackblitz.com/blog", claim: "StackBlitz parent product blog" },
    { url: "https://webcontainers.io", claim: "WebContainer runtime documentation" },
    { url: "https://bolt.new/pricing", claim: "Pricing tiers (Q1 2026)" },
  ],
});
