# Cloud Sandbox

Sandboxed agent execution without the full workbench UI. Same isolation, same security, no terminal/code-browser/preview.

## Tiers

### Sandbox Starter ($20)

- 5 sandboxes.
- Hetzner cpx21.
- Same as Cloud Platform Starter, but UI surface is just chat + agent execution.

### Sandbox Standard ($50)

- 20 sandboxes.
- Hetzner cpx31.

## What customers get

- **Per-project namespaces.** Same isolation as Cloud Platform.
- **CLI tools.** Same.
- **Database.** Same.
- **Deploy gate.** Same.

What's missing:

- **No terminal.** No web terminal access.
- **No code browser.** Browser doesn't show file tree.
- **No preview server.** Apps can run but no `<id>-dev.ellul.app` URL.

## Use case

Customers who:

- Use ellul.ai purely as backend AI execution.
- Have their own UI (terminal, code editor) and just want sandboxed code execution.
- Don't need browser-based development.

Often paired with their own IDE (Cursor, VS Code) calling ellul.ai's agent-bridge as the execution layer.

## Architecture

Same provisioning, fewer services. Configured via profile flag:

```typescript
profile.services = {
  fileApi: true,        // limited (no preview)
  agentBridge: true,
  termProxy: false,     // disabled
  watchdog: false,      // disabled
};
```

## Cross-references

- Tier matrix: [05-tier-matrix.md](./05-tier-matrix.md).
- vs Cloud Platform: [01-cloud-platform.md](./01-cloud-platform.md).
