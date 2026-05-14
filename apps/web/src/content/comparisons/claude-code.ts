import { defineComparison } from "./schema";

export default defineComparison({
  slug: "claude-code",
  competitor: {
    name: "Claude Code",
    domain: "claude.com/code",
    url: "https://claude.com/code",
  },
  features: [
    { id: "where-agent-runs", advantage: "ellul" },
    { id: "survives-lid-close", ellul: true, competitor: false, advantage: "ellul" },
    { id: "per-action-gating", advantage: "tie" },
    { id: "gate-bypass-protection", ellul: true, competitor: false, advantage: "ellul" },
    { id: "run-claude-code", competitor: true, advantage: "tie" },
    { id: "run-other-agents", ellul: true, competitor: false, advantage: "ellul" },
    { id: "parallel-sessions", advantage: "ellul" },
    { id: "mcp-server-access", advantage: "ellul" },
    { id: "credentials-location", advantage: "ellul" },
  ],
  tags: ["claude-code", "anthropic", "remote-agent", "byok"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  relatedUseCases: ["run-claude-code-in-cloud", "overnight-refactors"],
});
