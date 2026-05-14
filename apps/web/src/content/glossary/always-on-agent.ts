import { defineTerm } from "./schema";

export default defineTerm({
  slug: "always-on-agent",
  related: [
    "agent-workstation",
    "long-running-agent",
    "parallel-agents",
    "agentic-workflow",
  ],
  seeAlso: [
    { id: "concept-always-on", href: "/concepts/always-on-ai-agent" },
    { id: "faq-always-on", href: "/faq" },
  ],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
