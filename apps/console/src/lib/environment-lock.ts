// SPDX-License-Identifier: MIT

// Security Tier System - State helper + types

import { Shield, ShieldCheck, Lock, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────

// The three security tiers
export type SecurityLevel = "standard" | "web_lock" | "privacy_lock";

// Internal state that includes transitional states
export type EnvironmentLockLevel =
  | "off"                   // Standard tier
  | "web_locked"      // Web Lock active (passkey, no encryption)
  | "privacy_locked"        // Privacy Lock active (passkey + encrypted, permanent)
  | "setup_incomplete"      // web_locked but encryption pending for privacy lock
  | "transitioning";        // Lock being configured

export interface EnvironmentLockState {
  level: EnvironmentLockLevel;
  // The clean three-tier level for the security bar
  securityLevel: SecurityLevel;
  // True when web_locked but encryption not yet completed
  isPartialSetup: boolean;
  // True when volume is encrypted but auth tier is standard (legacy)
  isLegacyEncrypted: boolean;
  canEnableWebLock: boolean;
  canEnablePrivacyLock: boolean;
  canDowngrade: boolean;
}

export interface LockLevelConfig {
  label: string;
  badge: string | null;
  badgeColor: string;
  badgeBg: string;
  description: string;
  recoveryLine: string | null;
  infoLine: string | null;
  icon: LucideIcon;
  iconColor: string;
  cta: string;
}

// ─── Security Bar Config ────────────────────────────────────

export interface SecurityTierInfo {
  id: SecurityLevel;
  label: string;
  shortLabel: string;
  description: string;
  color: string;       // tailwind text color
  bgColor: string;     // tailwind bg color
  barColor: string;    // tailwind bar fill color
  icon: LucideIcon;
  permanent: boolean;
}

export const SECURITY_TIERS: SecurityTierInfo[] = [
  {
    id: "standard",
    label: "Standard",
    shortLabel: "Standard",
    description: "Basic authentication with session tokens",
    color: "text-cream/60",
    bgColor: "bg-cream/[0.04]",
    barColor: "bg-ink-1",
    icon: Shield,
    permanent: false,
  },
  {
    id: "web_lock",
    label: "Web Lock",
    shortLabel: "Web",
    description: "Passkey authentication with proof of possession",
    color: "text-sodium",
    bgColor: "bg-sodium/10",
    barColor: "bg-sodium",
    icon: ShieldCheck,
    permanent: false,
  },
  {
    id: "privacy_lock",
    label: "Privacy Lock",
    shortLabel: "Privacy",
    description: "Encrypted volume - even we can't read your data",
    color: "text-cream/65",
    bgColor: "bg-sodium/10",
    barColor: "bg-sodium",
    icon: Lock,
    permanent: true,
  },
];

// ─── Tier Config (mirrors API apps/api/src/routes/security.ts) ──

export type ServerSecurityTier = "standard" | "web_locked" | "private_locked";

interface TierConfigEntry {
  label: string;
  description: string;
  breachSafe: boolean;
  userMessage: string;
  webTerminal: "enabled" | "disabled" | "passkey_required";
  sshAccess: "disabled" | "enabled" | "dynamic";
  availableTransitions: ServerSecurityTier[];
}

// i18n keys live under "console.environmentLock.*"; translate at render site.
const TIER_CONFIG: Record<ServerSecurityTier, TierConfigEntry> = {
  standard: {
    label: "environmentLock.standardLabel",
    description: "environmentLock.standardDescription",
    breachSafe: false,
    userMessage: "environmentLock.standardUserMessage",
    webTerminal: "enabled",
    sshAccess: "disabled",
    availableTransitions: ["web_locked"],
  },
  web_locked: {
    label: "environmentLock.webLockedLabel",
    description: "environmentLock.webLockedDescription",
    breachSafe: true,
    userMessage: "environmentLock.webLockedUserMessage",
    webTerminal: "passkey_required",
    sshAccess: "dynamic",
    availableTransitions: ["standard", "private_locked"],
  },
  private_locked: {
    label: "environmentLock.privateLockedLabel",
    description: "environmentLock.privateLockedDescription",
    breachSafe: true,
    userMessage: "environmentLock.privateLockedUserMessage",
    webTerminal: "passkey_required",
    sshAccess: "dynamic",
    availableTransitions: ["web_locked"],
  },
};

// Authoritative derivation of tier-dependent fields. Keep in sync with API.
export function deriveTierFields(tier: ServerSecurityTier): TierConfigEntry {
  return TIER_CONFIG[tier];
}

// ─── State Derivation ───────────────────────────────────────

export function getEnvironmentLockState(server: {
  securityTier?: "standard" | "web_locked" | "private_locked";
  volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
}): EnvironmentLockState {
  const tier = server.securityTier ?? "standard";
  const mode = server.volumeSecurityMode ?? "standard";
  const hasUserKey = mode === "enhanced" || mode === "sovereign";

  // private_locked tier OR user holds a LUKS key → Privacy Lock (permanent)
  if (tier === "private_locked" || (tier === "web_locked" && hasUserKey)) {
    return {
      level: "privacy_locked",
      securityLevel: "privacy_lock",
      isPartialSetup: false,
      isLegacyEncrypted: false,
      canEnableWebLock: false,
      canEnablePrivacyLock: false,
      canDowngrade: false, // permanent
    };
  }

  // web_locked without user key → Web Lock
  if (tier === "web_locked") {
    return {
      level: "web_locked",
      securityLevel: "web_lock",
      isPartialSetup: false,
      isLegacyEncrypted: false,
      canEnableWebLock: false,
      canEnablePrivacyLock: true,
      canDowngrade: true, // can go back to standard
    };
  }

  // standard → Standard (all volumes are LUKS-encrypted with platform key)
  return {
    level: "off",
    securityLevel: "standard",
    isPartialSetup: false,
    isLegacyEncrypted: false,
    canEnableWebLock: true,
    canEnablePrivacyLock: false,
    canDowngrade: false,
  };
}

// ─── Context-Aware Copy ─────────────────────────────────────

function isCliProduct(product?: string): boolean {
  return product === "shield_proxy";
}

export function getLockDisplayName(product?: string): string {
  return isCliProduct(product) ? "Environment Lock" : "Web Lock";
}

export function getPrivacyLockDisplayName(product?: string): string {
  return isCliProduct(product) ? "Environment Privacy" : "Privacy Lock";
}

export function getLockSubject(product?: string): string {
  return isCliProduct(product) ? "environment" : "workspace";
}

// ─── Level Config ───────────────────────────────────────────

// All user-facing strings below are overridden at the render site
// (WebLockCard `levelOverrides`) with translated values from
// "console.webLockCard.*".  The English defaults here only survive in
// the React-Query cache, where they act as structural placeholders.
export function getLockLevelConfig(product?: string): Record<EnvironmentLockLevel, LockLevelConfig> {
  const subj = getLockSubject(product);

  return {
    off: {
      label: "Standard",
      badge: null,
      badgeColor: "",
      badgeBg: "",
      description: `Your ${subj} uses standard security. Enable Web Lock for passkey protection.`,
      recoveryLine: null,
      infoLine: null,
      icon: Shield,
      iconColor: "text-cream/60",
      cta: "Enable Web Lock",
    },
    web_locked: {
      label: "Web Lock",
      badge: "Active",
      badgeColor: "text-sodium",
      badgeBg: "bg-sodium/10 border-sodium/30",
      description: `Your ${subj} is protected by your passkey. Enable Privacy Lock to encrypt your data.`,
      recoveryLine: null,
      infoLine: null,
      icon: ShieldCheck,
      iconColor: "text-sodium",
      cta: "Enable Privacy Lock",
    },
    privacy_locked: {
      label: "Privacy Lock",
      badge: "Permanent",
      badgeColor: "text-cream/65",
      badgeBg: "bg-sodium/10 border-sodium/30",
      description: `Your ${subj} is fully protected. Passkey access and encrypted data - even we can't read it.`,
      recoveryLine: "Recovery codes available in your settings",
      infoLine: null,
      icon: Lock,
      iconColor: "text-cream/65",
      cta: "Manage Security",
    },
    setup_incomplete: {
      label: "Setting Up",
      badge: "Incomplete",
      badgeColor: "text-sodium",
      badgeBg: "bg-sodium/10 border-sodium/30",
      description: `Your ${subj} lock is partially enabled. Complete setup to fully protect your ${subj}.`,
      recoveryLine: null,
      infoLine: null,
      icon: ShieldAlert,
      iconColor: "text-sodium",
      cta: "Complete Setup",
    },
    transitioning: {
      label: "Configuring",
      badge: "Setting up...",
      badgeColor: "text-blue-400",
      badgeBg: "bg-blue-500/10 border-blue-500/30",
      description: `Your ${subj} security is being configured.`,
      recoveryLine: null,
      infoLine: null,
      icon: Shield,
      iconColor: "text-blue-400",
      cta: "Please wait...",
    },
  };
}
