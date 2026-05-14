import { defineComparison } from "./schema";

export default defineComparison({
  slug: "cursor",
  competitor: {
    name: "Cursor",
    domain: "cursor.com",
    url: "https://cursor.com",
  },
  features: [
    { id: "where-agent-runs", advantage: "ellul" },
    { id: "survives-lid-close", advantage: "tie" },
    { id: "parallel-multi-vendor", advantage: "ellul" },
    { id: "editor-experience", advantage: "competitor" },
    { id: "inline-completions", advantage: "competitor" },
    { id: "privileged-action-gating", advantage: "ellul" },
    { id: "credentials-location", advantage: "ellul" },
    { id: "cursor-sdk-integration", advantage: "tie" },
    { id: "phone-approvals", advantage: "ellul" },
  ],
  tags: ["cursor", "editor", "remote-agent"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["cursor-remote-agents"],
});
