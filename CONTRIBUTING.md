# Contributing to ellul.ai

Thank you for your interest in contributing. This document explains the
contribution process, which differs from typical open-source projects due
to our one-way sync architecture.

## How contributions work

This public repository is a **read-only mirror** synced from a private
monorepo. The sync runs automatically and overwrites the public `main`
branch. This means:

- **Pull requests are reviewed here** but are **never merged directly**
  on this repository.
- When a PR is accepted, we cherry-pick or apply the patch into the
  private monorepo, crediting you as co-author.
- The next automated sync pushes your change to the public repo and
  effectively closes your PR.
- You will receive a comment on your PR linking to the sync commit that
  includes your contribution.

This ensures the private monorepo remains the single source of truth
while your contribution is properly attributed.

## Before you contribute

### Contributor License Agreement (CLA)

All contributors must sign our CLA before a PR can be accepted. The
[CLA Assistant](https://github.com/cla-assistant/cla-assistant) bot will
prompt you automatically when you open your first PR.

The CLA grants ellul.ai the right to relicense your contribution (necessary
because our BSL license converts to Apache 2.0 on the Change Date).

### License awareness

This repo uses a mixed-license model:

| License | Packages |
|---------|----------|
| **MIT** | `shield`, `shield-proxy`, `ui`, `ts-config`, `vps-ui`, `i18n`, `i18n-consts`, `i18n-messages`, `console`, `docs`, `web` |
| **BUSL-1.1** | `vps`, `ironclad`, `gateway` |

Contributions to MIT-licensed packages are licensed under MIT.
Contributions to BUSL-licensed packages are licensed under BUSL-1.1.

## Development setup

```bash
git clone https://github.com/ellulai/ellul.git
cd ellul
pnpm install
pnpm build
```

### Running tests

```bash
pnpm test
```

### Linting

```bash
pnpm lint
```

## Submitting a pull request

1. Fork this repository and create a branch from `main`.
2. Make your changes.
3. Add SPDX license headers to any new source files:
   ```typescript
   // SPDX-License-Identifier: MIT (or BUSL-1.1)
   // Copyright (c) 2025 ellul.ai. All rights reserved.
   ```
4. Ensure `pnpm build` and `pnpm lint` pass.
5. Open a pull request with a clear description of the change.

## Reporting bugs

Open a [GitHub issue](https://github.com/ellulai/ellul/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, package version)

## Security vulnerabilities

**Do not open a public issue.** See [SECURITY.md](./SECURITY.md) for
responsible disclosure instructions.

## Code of Conduct

All contributors must follow our [Code of Conduct](./CODE_OF_CONDUCT.md).
