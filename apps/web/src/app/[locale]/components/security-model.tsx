const DEFENSES = [
  { attack: "Secret exfiltration via env vars", defense: "Secrets not in agent's environment; injected via gate-controlled stdin pipe", layer: "Kernel" },
  { attack: "Secret exfiltration via file read", defense: "Shield data in shield-runner-owned directories (700 perms)", layer: "Kernel" },
  { attack: "Secret exfiltration via /proc", defense: "ptrace_scope=1 blocks cross-UID ptrace; hidepid=2 on /proc", layer: "Kernel" },
  { attack: "Credential theft via crash dump", defense: "LimitCORE=0 on Shield systemd unit", layer: "Kernel" },
  { attack: "Unauthorized git push", defense: "9-layer defense: in-memory credentials, session tokens, gate tokens, safeGitCmd", layer: "Kernel + Crypto" },
  { attack: "Unauthorized deploy", defense: "Caddy config dirs caddy:caddy 2770; agent not in caddy group", layer: "Kernel" },
  { attack: "Database access without approval", defense: "Per-app PostgreSQL roles; query proxy classifies SQL and enforces gate", layer: "Application + DB" },
  { attack: "Network exfiltration", defense: "Per-namespace nftables egress whitelist", layer: "Kernel" },
  { attack: "Cross-project data access", defense: "Mount namespace isolation; rsync snapshots with security filter", layer: "Kernel" },
  { attack: "Side-channel (cross-tenant)", defense: "Sovereign Host: no co-tenancy. Standard: namespace + seccomp", layer: "Hardware" },
];

const CLAIMS = [
  "Standard Instances provide stronger logical isolation than container-based sandboxes by using namespace stacking with no escape hatches.",
  "Sovereign Hosts mitigate cross-tenant side-channel attack classes by eliminating co-tenancy. This is a design property, not a patch.",
  "The gate system makes privileged agent actions require a cryptographic ceremony that terminates at a hardware authenticator.",
];

export default function SecurityModel() {
  return (
    <section id="security-model" className="relative z-10 w-full border-y border-cream/[0.06] bg-cream/[0.015] py-24">
      <div className="mx-auto max-w-7xl px-6">
        <p className="section-label">Security</p>
        <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
          Defense Summary
        </h2>
        <p className="mt-4 max-w-3xl text-base leading-[1.7] text-cream/55">
          The adversary is not an external attacker. The adversary is the AI agent itself. Traditional
          security assumes the workload is trusted. Agentic security assumes the workload is potentially
          adversarial and the infrastructure must constrain it.
        </p>

        {/* Defense grid cards */}
        <div className="mt-12 grid gap-3 sm:grid-cols-2">
          {DEFENSES.map((d) => (
            <div key={d.attack} className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-cream/80">{d.attack}</h3>
                <span className="shrink-0 rounded-full border border-cream/[0.06] bg-cream/[0.03] px-2 py-0.5 text-[10px] font-mono text-cream/40">
                  {d.layer}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-cream/45">{d.defense}</p>
            </div>
          ))}
        </div>

        {/* What we do not claim */}
        <div className="mt-12">
          <h3 className="text-sm font-semibold text-cream/50">What we claim</h3>
          <div className="mt-4 space-y-3">
            {CLAIMS.map((c, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cream/20" />
                <p className="text-sm leading-relaxed text-cream/45">{c}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
