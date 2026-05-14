import { defineTerm } from "./schema";

export default defineTerm({
  slug: "agent-workstation",
  related: [
    "always-on-agent",
    "parallel-agents",
    "sovereign-shield",
    "long-running-agent",
  ],
  seeAlso: [
    { id: "concept-agent-workstation", href: "/concepts/agent-workstation" },
    { id: "solution-run-claude-code", href: "/solutions/run-claude-code-in-cloud" },
  ],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
