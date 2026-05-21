<p align="center">
  <a href="https://ellul.ai">
    <h1 align="center">ellul.ai</h1>
  </a>
</p>

<p align="center">
  Your agent's computer.
</p>

<p align="center">
  <a href="https://ellul.ai/docs"><strong>Docs</strong></a> &middot;
  <a href="https://ellul.ai"><strong>Website</strong></a> &middot;
  <a href="https://github.com/ellulai/ellul/issues"><strong>Issues</strong></a>
</p>

---

An always-on workstation for AI agents. Runs overnight, keeps working while your laptop sleeps, coordinates multiple agents in parallel — without credential leaks or chaos.

## What is this

Ellul Cloud is an isolated Linux sandbox provisioned per user where AI agents run continuously. Agents get their own persistent environment with a code editor, live preview URLs, scoped test infrastructure, and the tools they need to ship software.

When an agent needs to touch your GitHub, your database, or your deployment target, it pauses and asks. You tap a passkey. The credential is brokered — the agent never sees it.

**Key primitives:**

- **Always-on** — agents survive laptop closes, WiFi drops, and sleep. Come back to finished work.
- **Parallel agents** — run multiple agents side by side. One writes code, one reviews, one drafts docs. Each in its own isolated workspace.
- **Passkey-gated actions** — git push, secret access, deploys, and database writes all pause for FIDO2 biometric approval.
- **Per-project isolation** — mount + PID namespaces, seccomp, AppArmor. Agents can't read each other's secrets or break each other's state.
- **Zero-knowledge credentials** — your prod keys live in a vault. Injected at approval time, never persisted in the agent's environment.

## Architecture

```
packages/
  gateway/        Cloudflare Worker — routes traffic to VPS instances
  i18n/           Internationalization framework
  i18n-consts/    i18n locale constants
  i18n-messages/  i18n message catalogs
  ironclad/       Free-tier security: Warden proxy, MITM CA, SUID lockdown
  shield/         Sovereign Shield — passkey auth, JWT, credential brokering
  shield-proxy/   Auth proxy for agent connections
  vps/            VPS runtime — provisioning, enforcement, namespace isolation
  ui/             Shared UI components
  vps-ui/         VPS-specific UI components
  ts-config/      Shared TypeScript configuration
apps/
  console/        Management console
  docs/           Documentation site
  web/            Marketing website
```

## Development

```bash
git clone https://github.com/ellulai/ellul.git
cd ellul
pnpm install
pnpm build
```

## License

This repository uses a mixed-license model:

| License | Packages |
|---------|----------|
| [MIT](./LICENSE-MIT) | `shield`, `shield-proxy`, `ui`, `ts-config`, `vps-ui`, `i18n`, `i18n-consts`, `i18n-messages`, `console`, `docs`, `web` |
| [BUSL-1.1](./LICENSE) | `vps`, `ironclad`, `gateway` |

BUSL-licensed packages convert to Apache 2.0 on 2030-04-01. See [NOTICE](./NOTICE) for details.

## Contributing

This repo is a read-only mirror synced from a private monorepo. PRs are reviewed here but cherry-picked into the private repo. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process.

## Security

Report vulnerabilities responsibly. See [SECURITY.md](./SECURITY.md).
