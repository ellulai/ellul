import { defineComparison } from "./schema";

export default defineComparison({
  slug: "manus",
  competitor: {
    name: "Manus",
    domain: "manus.im",
    url: "https://manus.im",
  },
  features: [
    { id: "byoa", advantage: "ellul" },
    { id: "byom", advantage: "ellul" },
    { id: "persistent-workstation", advantage: "ellul" },
    { id: "real-credential-ops", advantage: "ellul" },
    { id: "one-shot-task", advantage: "tie" },
    { id: "tool-integrations", advantage: "ellul" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "editor-experience", advantage: "ellul" },
    { id: "cross-device-approval", advantage: "tie" },
    { id: "open-ecosystem", advantage: "ellul" },
    { id: "pricing-transparency", advantage: "ellul" },
    { id: "best-for", advantage: "tie" },
  ],
  tags: ["manus", "managed-agent", "byoa", "byom", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud", "overnight-refactors"],
  sources: [
    { url: "https://manus.im", claim: "Product site" },
    { url: "https://manus.im/pricing", claim: "Plus / Pro tiers and credit-based usage" },
    { url: "https://manus.im", claim: "Launched March 2025 by Butterfly Effect AI" },
  ],
});
