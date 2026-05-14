import { defineComparison } from "./schema";

export default defineComparison({
  slug: "e2b",
  competitor: {
    name: "E2B",
    domain: "e2b.dev",
    url: "https://e2b.dev",
  },
  features: [
    { id: "sandbox-lifetime", advantage: "ellul" },
    { id: "state-persistence", ellul: true, competitor: false, advantage: "ellul" },
    { id: "designed-for-agents", advantage: "ellul" },
    { id: "builtin-chat", ellul: true, competitor: false, advantage: "ellul" },
    { id: "passkey-gating", ellul: true, competitor: false, advantage: "ellul" },
    { id: "code-interpreter", advantage: "competitor" },
    { id: "time-to-first-sandbox", advantage: "competitor" },
  ],
  tags: ["sandbox", "ephemeral", "code-execution"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
