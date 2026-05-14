import { defineComparison } from "./schema";

export default defineComparison({
  slug: "replit",
  competitor: {
    name: "Replit",
    domain: "replit.com",
    url: "https://replit.com",
  },
  features: [
    { id: "target-user", advantage: "tie" },
    { id: "byoa", advantage: "ellul" },
    { id: "byom", advantage: "ellul" },
    { id: "always-on-agent", advantage: "ellul" },
    { id: "privileged-action-gating", advantage: "ellul" },
    { id: "credentials-location", advantage: "ellul" },
    { id: "parallel-agents", advantage: "ellul" },
    { id: "hosting-deployment", advantage: "tie" },
    { id: "editor-experience", advantage: "competitor" },
    { id: "education-fit", advantage: "competitor" },
    { id: "phone-approvals", advantage: "ellul" },
    { id: "sandbox-isolation", advantage: "ellul" },
  ],
  tags: ["replit", "cloud-ide", "agent", "comparison"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud", "overnight-refactors"],
  sources: [
    { url: "https://replit.com", claim: "Product site" },
    { url: "https://replit.com/pricing", claim: "Core $20/mo and Pro $100/mo (Feb 2026 reshuffle)" },
    { url: "https://replit.com/site/agent", claim: "Replit Agent launch (2024)" },
    { url: "https://docs.replit.com/category/deployments", claim: "Replit Deployments documentation" },
  ],
});
