#!/bin/bash
# ellul.ai SSH authorized keys lookup — called by sshd as root.
# IMMUTABLE: This file is chattr +i. Only sovereign-shield can modify (chattr -i first).
# sshd requirement: owned by root, not writable by group or others (0700 root:root).
#
# Two-tier lookup:
#   1. PRIMARY  /etc/ssh/authorized_keys/<user>             — vault-bound, encrypted at rest
#   2. FALLBACK /etc/ellul-bootstrap/authorized_keys/<user> — boot partition, always-available
#
# The fallback exists because the primary is a vault bind mount; if the vault
# overlay activates over an empty source (seed-before-mount race, vault
# corruption, or any future class of bind-mount bug), the primary directory
# appears empty and the user gets locked out of their own server. The
# bootstrap partition is on the unencrypted root FS and is never
# bind-mounted, so it is the always-on fallback. shield-ssh-key-mgr writes
# every key to BOTH paths atomically, so the fallback stays in sync.

USER="$1"
if [[ ! "$USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  logger -t ellul-ssh-auth -p auth.warning "BLOCKED: invalid username format: $USER from PID $PPID"
  exit 0
fi

PRIMARY="/etc/ssh/authorized_keys/${USER}"
FALLBACK="/etc/ellul-bootstrap/authorized_keys/${USER}"

# Empty-or-missing test: a zero-byte file is treated as missing. An empty
# vault overlay leaves a directory with no entries, so the test reduces to
# `-f` failing. A user with truly zero keys is operationally identical
# to a missing file and we never want to authenticate against an empty
# answer; better to fall through to the fallback.
if [ -s "$PRIMARY" ]; then
  logger -t ellul-ssh-auth -p auth.info "key-lookup user=$USER pid=$PPID source=primary"
  cat "$PRIMARY"
  exit 0
fi

if [ -s "$FALLBACK" ]; then
  # Loud warning: primary is supposed to be the source of truth. If we're
  # serving from the fallback, the vault overlay is broken and operators
  # need to know.
  logger -t ellul-ssh-auth -p auth.warning "VAULT-MISS user=$USER pid=$PPID — serving from boot-partition fallback"
  cat "$FALLBACK"
  exit 0
fi

logger -t ellul-ssh-auth -p auth.warning "no-keys user=$USER pid=$PPID — both primary and fallback empty"
exit 0
