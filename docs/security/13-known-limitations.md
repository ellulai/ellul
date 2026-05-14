# Known limitations and acknowledged gaps

A security-honest list of what the architecture does not currently defend against. Some are deliberate trade-offs; others are open work.

## Same-user trust between agent and Sovereign Shield

**Status:** known gap, partial mitigation.

In the current architecture, Sovereign Shield runs as `shield-runner` and the agent runs as `dev` — they are **different users**. POSIX permissions enforce the boundary on file-level access (auth DB, secrets) but not on processes.

However, agent-bridge (which the agent's chat WebSocket lives in) runs as `dev` with `SupplementaryGroups=shield-ipc`. This means:

- Agent-bridge has read access to `/run/shield/internal-agent-bridge.token`.
- Agent-bridge can sign HMAC requests to Shield's internal endpoints.
- A jailbroken agent-bridge process could forge `X-Auth-User` headers, request gates, etc.

Defense in depth:

- Agent-bridge is a bundled service, `chmod 755` and (eventually) `chattr +i`.
- Shield's internal endpoints log every call to the audit chain.
- Shield's bridge endpoints (with PoP) require browser-side signatures the agent can't forge.

**Proposed fix.** Run agent-bridge as its own user (e.g., `bridge-runner`) without `shield-ipc` group access; have agent-bridge talk to Shield through Caddy with normal forward-auth headers (just like browsers). Bigger architectural shift; not yet shipped.

## Tier switch via localhost

**Status:** mitigated, residual risk.

`POST /_auth/tier/switch` is restricted to localhost + internal token. The agent's interactive shell cannot read the internal token (not in `shield-ipc` at shell level). But agent-bridge IS in `shield-ipc` and could forge the call.

A jailbroken agent-bridge could downgrade `web_locked` to `standard`, then exploit the relaxed JWT auth to bypass passkey requirements.

**Mitigation:** Audit log records every tier change with full details. API receives the audit chain head and would notice an unauthorized downgrade.

**Better fix:** require browser-side passkey assertion for tier switches (web_locked → standard), not just internal token. Planned but not shipped.

## Browser-trusted Cloudflare

**Status:** by design.

In the gateway model, Cloudflare terminates client TLS. Cloudflare CAN read traffic in transit. We treat Cloudflare as a trusted partner, not an attacker.

For customers who want zero-trust to Cloudflare, **direct mode** (Let's Encrypt ACME, no Cloudflare) is supported. No automatic upgrade path though — customer must select direct at provisioning.

## Volume migration in sovereign mode

**Status:** out of scope.

Block migration ([../storage/04-block-migration.md](../storage/04-block-migration.md)) works by reading raw LUKS ciphertext and replaying on target. For sovereign-mode volumes:

- Source has only user PRF in slot 1.
- Target needs the same PRF to unlock.

If the user has the same passkey on both source and target, fine. If not (e.g., new device), they need to enroll a new passkey first or the migrated volume won't open.

We document this and surface a UI warning before migration in sovereign mode.

## Rate limiting on iptables SYN

**Status:** not implemented.

`docs/HETZNER-ABUSE.md` (legacy) mentions SYN rate limiting (`-m limit --limit 100/sec`). It's not implemented in current iptables rules.

**Risk.** A compromised VPS could be used as a SYN-flood source. Hetzner detects this via traffic patterns.

**Mitigation.** Bandwidth monitoring (1TB warn, 5TB critical) catches sustained abuse. CPU monitoring catches sustained high CPU. Both run on cron (5–15 min intervals), so detection is delayed.

**Open work.** Adding `-m hashlimit --hashlimit-mode srcip,dstport --hashlimit-above 100/sec --hashlimit-burst 200 -j DROP` for outbound SYN. Should be straightforward.

## Per-project ipset (not yet)

**Status:** simplified.

Current architecture uses one global `ellul-egress` ipset shared across all projects. Pre-resolved IPs are added with 1-hour TTL.

**Risk.** Project A resolves `api.anthropic.com`; that IP is in the ipset; Project B can also reach that IP (even though B might have a more restrictive allowlist).

**Mitigation.** /etc/hosts is per-namespace (project A and B don't share /etc/hosts contents inside their namespaces). So even if the ipset has the IP, B's namespace can only reach it if its hosts file lists it.

**Open work.** Per-project ipset with `--match-set ellul-egress-<project>`. Would let us drop reliance on /etc/hosts for the security boundary.

## CPU monitoring latency

**Status:** by design.

CPU metrics are polled every 15 minutes via Hetzner's API. Variance analysis runs over a 2-hour window. So a miner running for the first time can go undetected for up to 2h 15m.

**Risk.** Hetzner's own monitoring may catch first; the abuse notice arrives before our detection.

**Mitigation.** Bandwidth + heartbeat anomaly detection are independent signals; combination catches more cases.

**Better fix.** Local agent that monitors process stats every 30s and reports through heartbeat. Adds attack surface (a malicious local agent could lie); needs careful design.

## Mining detection false negatives

**Status:** known.

Variance-based detection relies on miners running flat at 95%+. False negatives:

- Miner running at 50–80% CPU.
- Miner with deliberate variance (5s on, 5s off).
- GPU miner (no GPU monitoring).

**Mitigation.** DNS blocking of mining pools (NXDOMAIN for known pools). Stratum port blocks (3333, 4444, etc.). Most "drive-by" miners use known pools and ports.

**Open work.** Process-name fingerprinting (xmrig, ethminer detection). Hard to do reliably without exec-tracing.

## Sovereign-mode lockout

**Status:** by design.

In sovereign mode, the platform key is removed from LUKS slot 0. If the user loses their passkey:

- LUKS slot 1 (user PRF) is the only unlock.
- No platform fallback.
- Recovery codes can re-enroll a new passkey, but the new passkey must be on a device that can derive the same PRF (typically the same Apple ID, Google account, or hardware key).
- If recovery codes also lost: data is unrecoverable.

This is the cost of sovereignty. We document it explicitly.

## Bandwidth abuse via 206 Range Requests

**Status:** known.

Bandwidth monitoring tracks total egress bytes. A large volume of small Range requests to a single resource (typical of "torrenting" or rapid scraping) shows up as bandwidth but isn't blocked at the network layer.

**Mitigation.** 1TB/month warning threshold catches sustained abuse.

**Open work.** Per-connection tracking + cap on bytes per destination per hour.

## DNS tunneling

**Status:** partially mitigated.

Warden DNS resolver blocks tunneling-prone query types (NULL, TXT, ANY, MX, SRV, HINFO, NAPTR). Entropy-based detection rejects labels >40 chars with Shannon entropy >3.5 bits/char.

**Risk.** Sophisticated attackers can encode data in repeated A queries with structured patterns below the entropy threshold.

**Mitigation.** Rate limit (50 q/10s free, 200 paid) caps throughput. Even with bypass, exfiltration would be slow.

## DDoS source

**Status:** by design.

A jailbroken agent could use the VPS as a DDoS source against allowed destinations. We can't easily distinguish "legitimate API call" from "DDoS contribution" if the destination is allowlisted.

**Mitigation.** Bandwidth monitoring catches sustained outbound. Per-destination caps would help (open work).

## Coercion / legal compulsion

**Status:** out of scope unless using sovereign mode.

In standard or web_locked, the platform CAN decrypt customer data if compelled (the platform key is in DB, wrapped). Sovereign mode is the answer here — the platform cannot decrypt because the slot is removed.

For the customer who wants this property: upgrade to private_locked.

## Compromised root

**Status:** out of scope.

If `root` on the VPS is compromised (kernel exploit, physical access), most defenses collapse. The kernel itself is the trust root; if the kernel is compromised, ptrace_scope, hidepid, ACLs, etc. are unreliable.

**Mitigation.** Sovereign mode protects customer data even from compromised platform root: LUKS slot 0 doesn't exist. Compromised root could see the running unlocked volume but couldn't decrypt offline.

**No mitigation against:** in-flight data at the moment of compromise.

## Same-process supply chain attacks

**Status:** addressed for npm, partial for others.

A malicious npm package in a customer app could exfiltrate or trigger gate requests. We:

- Run apps in their per-project namespace (egress allowlist limits damage).
- Read-only mount source (the package can read but not modify the source).
- Gate on database writes, secrets, deploys.

What we don't do:

- Verify package signatures before install.
- Enforce a manual review of npm dependencies.

This is the customer's responsibility. We provide isolation; we don't audit packages.

## Side-channel attacks

**Status:** out of scope.

Spectre, Meltdown, rowhammer, DMA — out of scope for our threat model. Mitigated by upstream kernel/microcode updates.

## Compromised customer browser

**Status:** out of scope.

If malware is on the customer's laptop and compromises the browser process, it can:

- Use cached PoP key (can't extract, but can use to sign).
- Read DOM and steal session cookies.
- Render fake popups to trick the user.

PoP defends against some scenarios (extracted cookies elsewhere) but not against malware with the browser.

**Customer responsibility.** Keep browser updated, use endpoint security.

## Closing note

Defense is layered. None of these gaps individually breaks the system. Multiple gaps must align for an attacker to extract value. We document them so customers can make informed risk decisions; the platform improves continuously.

For the corresponding threat-mitigation matrix: [00-overview.md](./00-overview.md).
