/*
 * ellul-namespaced — BYOK per-project key sealing.
 *
 * Phase 1: secrets lifecycle (master + project secret on-disk; mlock'd
 * master in daemon RAM).
 * Phase 2: BYOK_WRAP / BYOK_UNWRAP opcodes (HKDF subkey + secretbox).
 * Phase 3: ENTER inline unwrap of __byok-v1:<provider>:<b64> env values.
 *
 * Master secret lives at /etc/ellul/byok-master.key (root:root 0400).
 * Per-project secrets live at /var/lib/ellul/byok/<slug>/secret
 * (root:root 0400) under a 0700 parent.
 *
 * Decommissioning the LUKS-shielded volume revokes every BYOK ciphertext
 * at once. DROP_PROJECT unlinks <slug>/secret BEFORE any other teardown
 * step so a partial drop leaves the secret-revoked state, not the
 * secret-still-readable state.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_BYOK_H
#define ELLUL_NSD_BYOK_H

#include "daemon.h"

#define NSD_BYOK_MASTER_PATH       "/etc/ellul/byok-master.key"
#define NSD_BYOK_PROJECT_DIR_ROOT  "/var/lib/ellul/byok"

#define NSD_BYOK_MASTER_BYTES      32
#define NSD_BYOK_PROJECT_SECRET_BYTES 32
#define NSD_BYOK_SUBKEY_BYTES      32
#define NSD_BYOK_NONCE_BYTES       24
/* Plaintext cap — provider keys (Anthropic, OpenAI, Gemini, etc.) are
 * well under 1 KiB. Reject anything larger to bound memory + log noise. */
#define NSD_BYOK_PLAINTEXT_MAX     4096
/* Ciphertext = nonce(24) || encrypted(plaintext_len + 16). */
#define NSD_BYOK_WRAPPED_MAX       (NSD_BYOK_NONCE_BYTES + NSD_BYOK_PLAINTEXT_MAX + 16)
/* Provider id allowlist regex: ^[a-z][a-z0-9-]{0,31}$. */
#define NSD_BYOK_PROVIDER_MAX      32

/*
 * Load /etc/ellul/byok-master.key into a libsodium-mlock'd buffer at
 * daemon startup. Returns 0 on success and writes a per-process handle
 * into *out_state for later wrap/unwrap calls. On failure returns -1
 * and logs the reason; the daemon should refuse to honour BYOK opcodes
 * but otherwise stay up (Phase 1 ships dormant; honour-WRAP/UNWRAP
 * lands in Phase 2).
 */
struct nsd_byok_state;
int nsd_byok_load_master(struct nsd_byok_state **out_state);

/*
 * Free the master state on shutdown. sodium_memzero's the master bytes
 * before munlock + free.
 */
void nsd_byok_free(struct nsd_byok_state *st);

/*
 * Return true if the master is loaded and the daemon is ready to
 * service BYOK ops. Phase 1 callers use this only for diagnostics —
 * actual BYOK_WRAP / BYOK_UNWRAP land in Phase 2.
 */
bool nsd_byok_ready(const struct nsd_byok_state *st);

/*
 * Provision a fresh per-project secret on CREATE_PROJECT. mkdir
 * /var/lib/ellul/byok/<slug>/ (root:root 0700) and write 32 random
 * bytes to .../secret (root:root 0400). Idempotent: if the secret
 * already exists, returns NSD_OK without rewriting (preserves any
 * existing ciphertexts wrapped under it).
 *
 * Returns NSD_OK on success or NSD_EINTERNAL on FS error. Slug is
 * caller-validated against ^sbx-[a-z0-9]{7}$ before call.
 */
int nsd_byok_provision_project(const char *slug);

/*
 * Drop the per-project secret on DROP_PROJECT. Unlinks
 * /var/lib/ellul/byok/<slug>/secret FIRST, then rmdir's the parent.
 * The unlink-first ordering is the revocation invariant: a partial
 * drop that crashes between unlink and rmdir still revoked every
 * ciphertext wrapped under this project's secret.
 *
 * Idempotent: missing files are not an error. Returns NSD_OK on
 * success or NSD_EINTERNAL on unexpected FS errors.
 */
int nsd_byok_drop_project(const char *slug);

/*
 * Validate a provider identifier against the allowlist regex
 *   ^[a-z][a-z0-9-]{0,31}$
 * Returns true on match, false otherwise. Cheap; called per WRAP/UNWRAP.
 */
bool nsd_byok_provider_ok(const char *s, size_t n);

/*
 * Encrypt plaintext to a project-scoped, provider-scoped sealed envelope.
 * Output layout: nonce(24) || crypto_secretbox(plaintext, subkey)
 * where subkey = HKDF-SHA256(salt=master, ikm=project_secret,
 *                            info="ellul-byok-v1\0" || provider).
 *
 * Reads the project secret from /var/lib/ellul/byok/<project>/secret
 * (root:root 0400) on every call — eliminates the need to keep the
 * secret in daemon RAM beyond the wrap/unwrap window.
 *
 * out_wrapped must have NSD_BYOK_WRAPPED_MAX capacity. *out_len is set
 * to the actual length on success. plaintext is sodium_memzero'd
 * inside the function before return.
 *
 * Returns NSD_OK on success or NSD_E* on failure. Subkey is zeroed
 * before return regardless of outcome.
 */
int nsd_byok_wrap(const struct nsd_byok_state *st,
                  const char *project,
                  const char *provider, size_t provider_len,
                  uint8_t *plaintext, size_t plaintext_len,
                  uint8_t *out_wrapped, size_t out_cap,
                  size_t *out_len);

/*
 * Decrypt a sealed envelope back to plaintext. Inverse of wrap. The
 * caller-provided out_plaintext receives at most NSD_BYOK_PLAINTEXT_MAX
 * bytes; *out_len is set to actual length. Subkey + plaintext are
 * zeroed on error or after copy-out.
 *
 * Returns NSD_OK on success, NSD_EINTERNAL on FS error,
 * NSD_EATTEST_MISMATCH on Poly1305 MAC failure (re-keyed master, dropped
 * project, or tampered ciphertext — caller can't distinguish).
 */
int nsd_byok_unwrap(const struct nsd_byok_state *st,
                    const char *project,
                    const char *provider, size_t provider_len,
                    const uint8_t *wrapped, size_t wrapped_len,
                    uint8_t *out_plaintext, size_t out_cap,
                    size_t *out_len);

#endif  /* ELLUL_NSD_BYOK_H */
