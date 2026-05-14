import { defineTerm } from "./schema";

export default defineTerm({
  slug: "ironclad-tier",
  related: ["sovereign-shield", "agent-workstation", "passkey-approval"],
  seeAlso: [
    { id: "docs-security-tiers", href: "https://docs.ellul.ai/concepts/security-tiers" },
    { id: "docs-volume-encryption", href: "https://docs.ellul.ai/lifecycle/volume-encryption" },
  ],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
