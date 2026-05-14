import { defineComparison } from "./schema";

export default defineComparison({
  slug: "sprites",
  competitor: {
    name: "Sprites.dev",
    domain: "sprites.dev",
    url: "https://sprites.dev",
  },
  features: [
    { id: "stack-layer", advantage: "tie" },
    { id: "stateful-persistence", advantage: "tie" },
    { id: "checkpoint-rollback", advantage: "competitor" },
    { id: "builtin-ux", ellul: true, competitor: false, advantage: "ellul" },
    { id: "passkey-gating", ellul: true, competitor: false, advantage: "ellul" },
    { id: "multi-agent-peering", competitor: false, advantage: "ellul" },
    { id: "integrations", ellul: true, competitor: false, advantage: "ellul" },
    { id: "time-to-first-run", advantage: "ellul" },
  ],
  tags: ["sandbox", "infrastructure", "firecracker"],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
