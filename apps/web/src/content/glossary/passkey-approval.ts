import { defineTerm } from "./schema";

export default defineTerm({
  slug: "passkey-approval",
  related: [
    "sovereign-shield",
    "agent-workstation",
    "ironclad-tier",
    "agentic-workflow",
  ],
  seeAlso: [
    { id: "docs-cross-device", href: "https://docs.ellul.ai/authentication/cross-device" },
    { id: "faq-passkey-gating", href: "/faq" },
  ],
  publishedAt: "2026-04-30",
  lastUpdated: "2026-04-30",
});
