# W16.1 Maintainer outreach plan — Paperclip

> **Status: not started.** No outreach has happened yet. The plan
> below is the intended sequence when work resumes.

W16.1 in the plan is the highest-leverage non-coding action of the
entire orchestrator hosting program: get the partnership conversation
going with orchestrator maintainers before they consider building
hosting themselves.

## Identified contacts

### paperclipai/paperclip

**Maintainer:** `cryppadotta` (Dotta) — identified via:
- Recent commit history on `paperclipai/paperclip`
- Snyk org wired into PR CI (https://app.snyk.io/org/cryppadotta)
- Active across issues + reviews

**Relevant adjacent upstream work (snapshot at design time):**

- **Issue #2329** — `[security] Default deployment mode has no authentication`
  - Author: `mlileng` (Morten Lileng)
  - Created: 2026-03-31
  - State: open, no comments
  - Significance: parent gap motivating any new auth mode in upstream
- **PR #1046** — `feat: managed hosting hooks for SaaS deployment (C1–C6)`
  - Author: `theCompanying` (contributor, not maintainer)
  - Created: 2026-03-16
  - State: open, ~6 weeks unmerged at design time
  - Significance: introduces a `managed` deployment mode with static
    `X-Paperclip-Management-Secret`. Greptile flagged auth bypass
    not-mode-gated and env-var injection. The env-var fix has been
    pushed; mode-gating fix still pending.
  - Relevance to us: `managed` mode is upstream's answer to
    multi-tenant hosting auth. Our `header_trust` design is a
    complementary mode targeting deployers who need stronger auth than
    a static bearer.

When work resumes, re-verify these states — issues and PRs may have
moved.

### Other orchestrators

| Repo | Owner / maintainer | Status |
|---|---|---|
| Runfusion/Fusion | TBD — verify via commit history | No contact attempted |
| Letta-AI/letta | TBD | No contact attempted |
| Theo-t3-stack / t3code | Theo (likely DM-friendly) | No contact attempted |

These are Phase E (Fusion onboarding) and Phase 2+ candidates per the
plan. Outreach to them follows successful Paperclip engagement — get
one partnership working as proof, then expand.

## Engagement sequence (Paperclip)

1. **Comment on PR #1046 first.** Establish good citizenship. Surface
   our use case (multi-tenant orchestrator hosting at the VPS level).
   Offer to test the `managed` mode against our environment when it
   merges. Reference Greptile's flagged issues constructively. Do
   NOT pitch our own patch yet.

2. **Open issue or discussion** on `paperclipai/paperclip` describing
   the `header_trust` design as a complementary mode targeting
   stronger-auth deployers. Include link to our design doc
   ([patch-design.md](patch-design.md)). Frame as RFC, not as a
   proposed PR yet — we want maintainer signal on direction before
   shipping code.

3. **Open the upstream PR** with our patch, referencing both issue
   #2329 (parent gap) and PR #1046 (adjacent prior art). The PR
   description includes the threat model from
   [patch-design.md](patch-design.md). Keep the patch ≤ 100 LOC and
   focused only on the auth middleware.

4. **Schedule a 20-min call** with cryppadotta. Not strictly to land
   the patch — also to understand their hosting roadmap and pitch the
   broader ellul.ai partnership (W16.1 in the plan). Best case: a
   footnote in their README; realistic case: when they consider
   hosting themselves, they call us first.

## Cadence

- Weekly comment on the PR if it sits without review
- At 3 weeks open public discussion
- At 6 weeks treat upstream channel as cold and carry the patch
  indefinitely (with the
  [enterprise-gates.md](enterprise-gates.md) discipline applied)

## Cold-start message archetype

Keep it concise (≤ 200 words) for DM/Discussion intro:

> Hi — I'm Joe, building [ellul.ai](https://ellul.ai), a
> kernel-isolation runtime for hosting AI orchestrators. We're hosting
> Paperclip as our first SKU and have run into an awkward gap:
> `local_trusted` is too permissive for multi-tenant deploys and
> `authenticated` (BetterAuth) duplicates auth we already terminate at
> our reverse proxy (passkey + SAML/OIDC + per-tenant scopes).
>
> I'd like to propose a third deployment mode, `header_trust`, that
> strictly trusts HMAC-signed headers from a configured reverse proxy
> (default header prefix `X-Trusted-`, configurable; loopback-CIDR +
> key-file + timestamp window). Useful for anyone running Paperclip
> behind their own auth gateway — not just us. ~95 LOC + tests, no
> behavior change to existing modes.
>
> I have the diff ready; happy to open the PR or scope a discussion
> first. Either way, would love a 20-min call to map out what an
> upstream-friendly version looks like before I send code.
>
> Standalone goal here: be a partnership, not a fork. Long-term we'd
> like Paperclip to consider us a recommended hosting option.

Adapt to the channel (PR comment vs discussion vs DM). Maintain the
"partnership not fork" framing throughout.

## Decision rule for when to start outreach

The plan says outreach starts week 1 of Phase A. With the program
deferred:

- **Don't engage cold without the patch ready.** Showing up with
  vapor undermines credibility.
- **Don't engage if main platform is unstable.** A partnership
  conversation requires us to demonstrate operational maturity; a
  flaky main platform makes us look unreliable to a potential
  partner.
- **Engage when:** patch design is current (re-validated against
  then-pinned upstream), main platform has stable production load,
  and we have engineering capacity to act on a positive response
  within 1–2 weeks of getting one.

If conditions are met but you want to test the water before
committing engineering time, **comment on PR #1046 first** — that's
the lowest-risk first contact. Maintainer reaction to your comment
calibrates expectations for everything that follows.

## Tracking when active

When outreach is actually underway, update the auto-memory entry
`project_paperclip_outreach.md` with:
- Channel of last contact (DM thread, PR #, issue #)
- Date of last contact
- Maintainer's response signal (positive / neutral / cold / no response)
- Next scheduled action

That keeps subsequent sessions oriented without re-deriving the state.
