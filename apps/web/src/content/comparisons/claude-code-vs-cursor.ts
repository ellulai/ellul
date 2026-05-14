import { defineComparison } from "./schema";

export default defineComparison({
  slug: "claude-code-vs-cursor",
  competitor: {
    name: "Cursor",
    domain: "cursor.com",
    url: "https://cursor.com",
  },
  features: [
    { id: "where-agent-runs", advantage: "ellul" },
    { id: "agent-quality", advantage: "tie" },
    { id: "inline-completions", ellul: false, competitor: true, advantage: "competitor" },
    { id: "cmd-k-refactors", ellul: false, competitor: true, advantage: "competitor" },
    { id: "codebase-indexing", advantage: "ellul" },
    { id: "survives-lid-close", ellul: true, competitor: false, advantage: "ellul" },
    { id: "parallel-sessions", advantage: "ellul" },
    { id: "per-action-gating", advantage: "ellul" },
    { id: "credentials-location", advantage: "ellul" },
    { id: "run-other-agents", ellul: true, competitor: false, advantage: "ellul" },
    { id: "phone-approvals", ellul: true, competitor: false, advantage: "ellul" },
    { id: "time-to-first-run", advantage: "ellul" },
  ],
  tags: ["claude-code", "cursor", "agent-quality", "remote-agent", "editor"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud", "cursor-remote-agents"],
});
