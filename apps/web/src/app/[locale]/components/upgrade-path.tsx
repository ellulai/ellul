const WHAT_HAPPENS = [
  "Foundry provisions a dedicated bare-metal server",
  "Volume snapshot migrates all state (code, DB, secrets, config)",
  "DNS cutover: same domains, same endpoints, same API keys",
  "Shield proxy activates with full gate enforcement",
  "Zero downtime. Zero code changes. Zero credential rotation.",
];

export default function UpgradePath() {
  return (
    <section id="upgrade-path" className="relative z-10 w-full py-24">
      <div className="mx-auto max-w-7xl px-6">
        <p className="section-label">Ellul Studio</p>
        <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
          One click. Zero code changes.
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-[1.7] text-cream/55">
          Start in a Standard sandbox. When your agent is ready for production, upgrade
          to a fully isolated Sovereign Host from the dashboard. Your code does not know what tier
          it runs on.
        </p>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-2">
          {/* Timeline */}
          <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-6">
            <p className="text-cream/30 text-xs uppercase tracking-wider">Day 1</p>
            <p className="mt-2 text-sm text-cream/80">
              Launch a Standard sandbox. Namespace isolation, encrypted volume, FIDO2 gates.
            </p>
            <div className="mt-5 border-t border-cream/[0.06] pt-4">
              <p className="text-cream/30 text-xs uppercase tracking-wider">Day 30</p>
              <p className="mt-2 text-sm text-cream/80">
                Agent handles real data. Click <span className="text-sodium font-semibold">Upgrade to Sovereign</span> in the dashboard. Dedicated bare-metal, zero code changes.
              </p>
            </div>
          </div>

          {/* What happens list */}
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-cream/30">What happens</p>
            <div className="mt-4 space-y-4">
              {WHAT_HAPPENS.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-cream/[0.06] bg-cream/[0.03] text-[10px] font-bold text-cream/40">
                    {i + 1}
                  </div>
                  <p className="text-sm leading-relaxed text-cream/60">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
