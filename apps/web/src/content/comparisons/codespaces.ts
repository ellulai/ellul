import { defineComparison } from "./schema";

export default defineComparison({
  slug: "codespaces",
  competitor: {
    name: "GitHub Codespaces",
    domain: "github.com/features/codespaces",
    url: "https://github.com/features/codespaces",
  },
  features: [
    { id: "designed-for", advantage: "tie" },
    { id: "always-on", advantage: "ellul" },
    { id: "per-agent-isolation", advantage: "ellul" },
    { id: "passkey-gates", ellul: true, competitor: false, advantage: "ellul" },
    { id: "read-only-peering", ellul: true, competitor: false, advantage: "ellul" },
    { id: "github-actions", advantage: "competitor" },
    { id: "free-tier", ellul: false, advantage: "competitor" },
    { id: "bring-any-agent", ellul: true, competitor: false, advantage: "ellul" },
  ],
  tags: ["github", "cloud-dev-env", "copilot"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
