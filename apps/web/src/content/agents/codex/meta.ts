import { defineAgent } from "../schema";

export default defineAgent({
  slug: "codex",
  vendor: "OpenAI",
  url: "https://platform.openai.com",
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
  structuredDataType: "TechArticle",
  tags: ["codex", "openai", "agent", "byok"],
  relatedComparisons: ["claude-code", "cursor"],
  relatedTerms: ["agent-workstation", "agentic-workflow"],
});
