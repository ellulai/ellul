# Why Paperclip Needs ellul.ai

## The Problem

Paperclip lets you build autonomous AI companies — teams of agents that collaborate to get work done. A security auditing firm with 28 agents. A full-stack dev shop with 49 agents. A game studio, a research lab, a consulting firm.

But right now, every one of those agents runs on your laptop. Unsandboxed. They all share the same filesystem, the same credentials, the same network. The CEO agent can read the intern's `.env` file. A compromised code auditor can access the blockchain team's private keys.

Paperclip's own documentation flags this:

> *"Local CLI adapters run unsandboxed on the host machine. That means: prompt instructions matter, configured credentials/env vars are sensitive, working directory permissions matter."*

This is a security model held together by good behavior and prompt engineering. It works for solo developers running a few agents locally. It falls apart the moment you:

- Run agents that handle sensitive code (security audits, financial systems)
- Scale past what a single laptop can handle
- Need agents from different teams to be truly isolated from each other
- Want to stop paying for compute when agents aren't working

## What ellul.ai Solves

### Real Isolation, Not Prompt-Level Trust

When you set an agent's adapter to `ellul_cloud` in Paperclip, that agent runs inside a Linux kernel namespace on an ellul.ai server. Not a Docker container. Not a VM. A namespace — the same isolation primitive that powers Kubernetes pods, but configured specifically for AI agent execution.

Each **team** gets its own namespace:
- The Audit team's agents share a workspace (they need to collaborate on findings)
- The Blockchain team's agents share a different workspace
- Neither team can see the other's files, processes, or credentials

This isn't a setting you can turn off. It's not a prompt instruction the agent can ignore. It's enforced by the Linux kernel. The Code Auditor agent literally cannot access the Smart Contract Auditor's filesystem, because the kernel's mount namespace makes those files invisible.

### Teams Can Still Talk

Isolation without communication is useless. In a real company, the CEO needs to delegate to team leads. The Audit Lead needs to escalate findings to the CSO. The Blockchain team needs to verify a finding the Audit team discovered.

ellul.ai creates scoped communication channels between teams, derived automatically from the org chart you already defined in Paperclip:

**What each team sees:**

- `/comms/team/` — Internal team chat (Audit Lead talks to Code Auditor)
- `/comms/exec/` — Line to leadership (Audit Lead reports to CSO/CEO)
- `/comms/x-audit-blockchain/` — Cross-team channel (created when two teams need to collaborate)

The CEO sees all team channels. A specialist sees only their team's internal channel and the exec line. No noise from unrelated teams. No confusion from overlapping conversations.

The clever part: the exec channel is the **same directory** mounted at different paths. When the Audit Lead writes a report to `/comms/exec/`, the CEO reads it at `/comms/audit/`. One directory, two perspectives. No routing infrastructure, no message bus, no complexity.

### Predictable Monthly Pricing

Your server runs 24/7 — always ready for the next heartbeat, no cold start delays. Pricing follows ellul.ai's existing tiers:

| Plan | Price | Resources |
|------|-------|-----------|
| Standard | $25/mo | 4GB RAM, full namespace isolation |
| Pro | $50/mo | 8GB RAM, more headroom for large orgs |
| Business | $100/mo | Premium resources, priority support |

Each plan includes a dedicated VPS with full namespace isolation, comms channels, and cross-team snapshots. Every heartbeat executes instantly — no waiting for servers to wake up.

### No Infrastructure to Manage

You don't provision servers. You don't configure networking. You don't set up namespaces. You don't manage volumes.

1. Import your Paperclip company
2. ellul.ai reads the org chart and creates everything: namespaces per team, comms channels between teams, workspace snapshots for cross-team reading
3. Set `ellul_cloud` as the adapter on your agents
4. Heartbeats fire, agents execute in sandboxes, results flow back to Paperclip

If you change the org chart in Paperclip (hire an agent, reorganize teams), the infrastructure updates automatically.

## How It Works (Non-Technical)

### The Org Chart Becomes Infrastructure

When you define a company in Paperclip, you define an org chart:

```
CEO
├── CSO
│   ├── Audit Team (Audit Lead, Code Auditor, Variant Analyst, ...)
│   ├── Blockchain Team (Blockchain Lead, Smart Contract Auditor, ...)
│   └── Verification Team (Verification Lead, Property Tester, ...)
└── Engineering Team (Engineering Lead, Tooling Engineer, ...)
```

ellul.ai reads this and creates:

- **One server** for the whole company
- **One isolated workspace** per team (5 teams = 5 workspaces)
- **One CEO workspace** with visibility into all teams
- **Communication channels** that follow the reporting lines

### The Communication Flow

Here's how a security engagement flows through the system:

1. **CEO receives engagement** → writes directive to the Audit and Blockchain channels
2. **Audit Lead wakes up** → reads directive from `/comms/exec/` → assigns tasks to Code Auditor
3. **Code Auditor wakes up** → reads task from `/comms/team/` → reviews code → finds vulnerability → writes finding
4. **Audit Lead wakes up** → reads finding → needs Blockchain team's opinion → admin creates cross-team channel
5. **Audit Lead writes** to `/comms/x-audit-blockchain/` → "Can you verify this reentrancy?"
6. **Blockchain Lead wakes up** → reads request → reviews finding using Audit team's workspace snapshot (read-only) → confirms
7. **Audit Lead wakes up** → reads confirmation → escalates to CEO via `/comms/exec/`
8. **CEO wakes up** → reads escalation at `/comms/audit/` → two critical findings confirmed

Every agent only sees conversations relevant to their role. The Code Auditor never sees the CEO's strategic discussions. The Blockchain Lead only sees the cross-team channel when collaboration is happening.

### What Agents Can and Cannot Do

| Can | Cannot |
|-----|--------|
| Read and write files in their team's workspace | Write to another team's workspace |
| Read other teams' source code via `.shared/` snapshots | See other teams' processes (PID namespace) |
| Read and write to their scoped comms channels | See comms channels they're not part of |
| Access the internet (for API calls, package installs) | Read `.env` files, API keys, or secrets from other teams |
| Resume work across heartbeats (session persistence) | Access the vault, shield-data, or system config |

Cross-team read access is on by default — every team can see every other team's source code at `.shared/{team}/`. But it's configurable: admins can restrict which teams have visibility into which other teams. A team excluded from another's `readableNamespaces` list gets no snapshot at all — the files simply don't exist in their namespace.

What's always excluded from snapshots regardless of read permissions: credentials (`.env*`, `.npmrc`, `.pgpass`, `credentials.json`), tooling config (`.claude/`, `.codex/`, `node_modules/`), and files over 50MB.

### The Cost Model

| Company | Teams | Agents | Plan |
|---------|-------|--------|------|
| GStack | 2 | 5 | Standard ($25/mo) |
| Trail of Bits Security | 5 + executive | 28 | Pro ($50/mo) |
| Fullstack Forge | ~8 | 49 | Business ($100/mo) |

Flat monthly pricing. No per-heartbeat billing, no usage surprises. Your server is always on, always ready.

## Getting Started

### Step 1: Create an Account

Sign up at [ellul.ai](https://ellul.ai) and set up billing (free tier available for small orgs).

### Step 2: Register Your Paperclip Company

In Paperclip, your company already has agents, teams, and an org chart. ellul.ai imports this directly — you don't recreate anything.

### Step 3: Generate an API Key

The API key is what lets Paperclip talk to ellul.ai. You create it once, store it as a Paperclip secret, and the adapter handles the rest.

### Step 4: Switch Agents to ellul.ai

For each agent in Paperclip, change the adapter from `claude_local` to `ellul_cloud`. That's it. Next heartbeat, the agent executes in a sandboxed namespace instead of on your laptop.

### Step 5: Watch It Work

Open the Paperclip dashboard. Agents wake, execute, and report back exactly as before — except now they're isolated, costs are metered, and your laptop is free.

## Frequently Asked Questions

**Q: Do I need to change my prompts?**
No. The agent sees the same workspace, the same tools, the same prompts. The only difference is that the workspace is inside a kernel namespace instead of on your local filesystem.

**Q: What happens if two agents write to the same comms channel at the same time?**
Comms channels use append-only daily log files. Two agents can write simultaneously without conflicts — each appends to the day's log file. The filesystem handles concurrent appends atomically.

**Q: Can I use different AI providers for different agents?**
Yes. Set `agentCli` per agent: `claude` for Anthropic, `codex` for OpenAI, `gemini` for Google, `opencode` for multi-provider. Each agent can use a different provider.

**Q: Is the server always running?**
Yes. Your VPS runs 24/7 on your monthly plan. Heartbeats execute instantly with no cold start. Serverless (pay-per-use) pricing is on the roadmap for teams that want to optimize costs further.

**Q: Is my code safe on ellul.ai's servers?**
Yes. The vault (where all state lives) is owned by root with mode 700 — agents can't access it. The volume persists across server hibernation and is encrypted at rest by the cloud provider. Your code never leaves the server (unless the agent pushes to git, which requires explicit credentials).

**Q: Can I self-host this instead of using ellul.ai's servers?**
The infrastructure is open source. The namespace scripts, enforcer daemon, and provisioning system are all in the ellul.ai repo. But the managed service handles provisioning, billing, hibernation, and monitoring so you don't have to.
