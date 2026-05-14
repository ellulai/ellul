import { defineComparison } from "./schema";

export default defineComparison({
  slug: "daytona",
  competitor: {
    name: "Daytona",
    domain: "daytona.io",
    url: "https://daytona.io",
  },
  features: [
    { id: "target-audience", advantage: "tie" },
    { id: "stateful-persistence", advantage: "tie" },
    { id: "builtin-chat", ellul: true, competitor: false, advantage: "ellul" },
    { id: "passkey-gating", ellul: true, competitor: false, advantage: "ellul" },
    { id: "read-only-peering", ellul: true, competitor: false, advantage: "ellul" },
    { id: "integrations", advantage: "ellul" },
    { id: "open-source", advantage: "competitor" },
    { id: "time-to-first-run", advantage: "ellul" },
  ],
  tags: ["workspace", "platform", "open-source"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
