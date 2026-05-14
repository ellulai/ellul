/*
 * ellul-namespaced — BYOK per-project key sealing (Phase 1).
 *
 * Phase 1 lands the secret-on-disk lifecycle:
 *   - Master secret loaded from /etc/ellul/byok-master.key into a
 *     libsodium-mlock'd buffer at startup.
 *   - Per-project secret created in CREATE_PROJECT, destroyed in
 *     DROP_PROJECT. Unlink-first revocation invariant in DROP.
 *
 * Phase 2 will add nsd_byok_wrap / nsd_byok_unwrap on top of this
 * scaffolding.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "byok.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

#include <sodium.h>

struct nsd_byok_state {
    uint8_t master[NSD_BYOK_MASTER_BYTES];
    bool    ready;
};

static int read_master_into(uint8_t out[NSD_BYOK_MASTER_BYTES]) {
    int fd = open(NSD_BYOK_MASTER_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        nsd_event("nsd.byok.master.open-fail",
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
    if (!S_ISREG(sb.st_mode) || sb.st_uid != 0 ||
        (sb.st_mode & (S_IRGRP | S_IROTH | S_IWGRP | S_IWOTH)) != 0) {
        close(fd);
        nsd_event("nsd.byok.master.bad-perms",
                  "mode", nsd_jnum((long long)sb.st_mode),
                  "uid", nsd_jnum((long long)sb.st_uid),
                  NULL);
        errno = EPERM;
        return -1;
    }
    if (sb.st_size != NSD_BYOK_MASTER_BYTES) {
        close(fd);
        nsd_event("nsd.byok.master.bad-size",
                  "size", nsd_jnum((long long)sb.st_size),
                  NULL);
        errno = EINVAL;
        return -1;
    }
    size_t got = 0;
    while (got < NSD_BYOK_MASTER_BYTES) {
        ssize_t r = read(fd, out + got, NSD_BYOK_MASTER_BYTES - got);
        if (r > 0) { got += (size_t)r; continue; }
        if (r == 0) break;
        if (errno == EINTR) continue;
        close(fd);
        return -1;
    }
    close(fd);
    if (got != NSD_BYOK_MASTER_BYTES) { errno = EIO; return -1; }
    return 0;
}

int nsd_byok_load_master(struct nsd_byok_state **out_state) {
    if (sodium_init() < 0) {
        nsd_event("nsd.byok.sodium-init-fail", NULL);
        return -1;
    }
    struct nsd_byok_state *st = sodium_malloc(sizeof(*st));
    if (!st) {
        nsd_event("nsd.byok.malloc-fail", NULL);
        return -1;
    }
    memset(st, 0, sizeof(*st));
    if (read_master_into(st->master) != 0) {
        sodium_memzero(st->master, sizeof(st->master));
        sodium_free(st);
        return -1;
    }
    /* sodium_malloc already mlocks; sodium_mprotect_readonly() locks
     * the page R-O so a future bug can't accidentally rewrite the
     * master. We re-write through sodium_mprotect_readwrite() in the
     * (deferred) Phase 4 BYOK_REWRAP path. */
    if (sodium_mprotect_readonly(st) != 0) {
        nsd_event("nsd.byok.mprotect-fail",
                  "errno", nsd_jnum(errno),
                  NULL);
        sodium_memzero(st->master, sizeof(st->master));
        sodium_free(st);
        return -1;
    }
    /* sodium_mprotect_readonly covers the whole struct; we want
     * `ready` writable so we re-protect after setting it. Round-trip
     * is fine because this is one-shot at startup. */
    if (sodium_mprotect_readwrite(st) != 0) {
        sodium_memzero(st->master, sizeof(st->master));
        sodium_free(st);
        return -1;
    }
    st->ready = true;
    if (sodium_mprotect_readonly(st) != 0) {
        sodium_memzero(st->master, sizeof(st->master));
        sodium_free(st);
        return -1;
    }
    *out_state = st;
    nsd_event("nsd.byok.master.loaded", NULL);
    return 0;
}

void nsd_byok_free(struct nsd_byok_state *st) {
    if (!st) return;
    /* Allow zeroing before free. */
    (void) sodium_mprotect_readwrite(st);
    sodium_memzero(st->master, sizeof(st->master));
    st->ready = false;
    sodium_free(st);
}

bool nsd_byok_ready(const struct nsd_byok_state *st) {
    return st && st->ready;
}

/* ── Per-project secret lifecycle ────────────────────────── */

static int slug_ok_byok(const char *slug) {
    if (!slug) return 0;
    if (strlen(slug) != NSD_PROJECT_SLUG_LEN) return 0;
    if (strncmp(slug, "sbx-", 4) != 0) return 0;
    for (int i = 4; i < NSD_PROJECT_SLUG_LEN; i++) {
        char c = slug[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return 0;
    }
    return 1;
}

int nsd_byok_provision_project(const char *slug) {
    if (!slug_ok_byok(slug)) return NSD_EPROTO;

    /* Ensure parent dir exists with the right perms. ellul-namespaced.sh
     * provisions this on install; the mkdir here is defensive — it
     * makes the daemon resilient to a missing parent dir on a partial
     * upgrade. */
    if (mkdir(NSD_BYOK_PROJECT_DIR_ROOT, 0700) != 0 && errno != EEXIST) {
        nsd_event("nsd.byok.parent-mkdir-fail",
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }

    char proj_dir[256];
    int n = snprintf(proj_dir, sizeof(proj_dir), "%s/%s",
                     NSD_BYOK_PROJECT_DIR_ROOT, slug);
    if (n <= 0 || (size_t)n >= sizeof(proj_dir)) return NSD_EINTERNAL;

    if (mkdir(proj_dir, 0700) != 0 && errno != EEXIST) {
        nsd_event("nsd.byok.project-mkdir-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }
    /* chown + chmod even if mkdir said EEXIST — defensive against a
     * pre-existing dir with wrong perms (e.g. left over from an aborted
     * provisioning run). */
    if (chown(proj_dir, 0, 0) != 0) {
        nsd_event("nsd.byok.project-chown-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }
    if (chmod(proj_dir, 0700) != 0) {
        return NSD_EINTERNAL;
    }

    char secret_path[320];
    n = snprintf(secret_path, sizeof(secret_path), "%s/secret", proj_dir);
    if (n <= 0 || (size_t)n >= sizeof(secret_path)) return NSD_EINTERNAL;

    /* Idempotent: if secret exists with the right shape, leave it alone.
     * Re-creating would invalidate every ciphertext wrapped under it. */
    struct stat sb;
    if (stat(secret_path, &sb) == 0) {
        if (S_ISREG(sb.st_mode) &&
            sb.st_uid == 0 &&
            sb.st_size == NSD_BYOK_PROJECT_SECRET_BYTES &&
            (sb.st_mode & (S_IRWXG | S_IRWXO)) == 0) {
            return NSD_OK;
        }
        /* Wrong shape — wipe and recreate. The pre-existing file is
         * not trustworthy. */
        (void) unlink(secret_path);
    }

    /* Generate fresh 32-byte secret via libsodium randombytes_buf
     * (delegates to getrandom(2) on Linux). Write atomically through
     * a temp file + rename. */
    uint8_t buf[NSD_BYOK_PROJECT_SECRET_BYTES];
    randombytes_buf(buf, sizeof(buf));

    char tmp_path[320 + 8];
    n = snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", secret_path);
    if (n <= 0 || (size_t)n >= sizeof(tmp_path)) {
        sodium_memzero(buf, sizeof(buf));
        return NSD_EINTERNAL;
    }
    int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW |
                  O_CLOEXEC, 0400);
    if (fd < 0) {
        sodium_memzero(buf, sizeof(buf));
        nsd_event("nsd.byok.secret-open-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }
    if (fchown(fd, 0, 0) != 0 || fchmod(fd, 0400) != 0) {
        close(fd); unlink(tmp_path);
        sodium_memzero(buf, sizeof(buf));
        return NSD_EINTERNAL;
    }
    size_t off = 0;
    while (off < sizeof(buf)) {
        ssize_t w = write(fd, buf + off, sizeof(buf) - off);
        if (w < 0) {
            if (errno == EINTR) continue;
            close(fd); unlink(tmp_path);
            sodium_memzero(buf, sizeof(buf));
            return NSD_EINTERNAL;
        }
        off += (size_t)w;
    }
    if (fsync(fd) != 0) {
        close(fd); unlink(tmp_path);
        sodium_memzero(buf, sizeof(buf));
        return NSD_EINTERNAL;
    }
    close(fd);
    sodium_memzero(buf, sizeof(buf));

    if (rename(tmp_path, secret_path) != 0) {
        unlink(tmp_path);
        nsd_event("nsd.byok.secret-rename-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }

    nsd_event("nsd.byok.project-provisioned",
              "project", nsd_jstr(slug),
              NULL);
    return NSD_OK;
}

/* ── Provider validation ─────────────────────────────────── */

bool nsd_byok_provider_ok(const char *s, size_t n) {
    if (!s || n == 0 || n > NSD_BYOK_PROVIDER_MAX) return false;
    if (!(s[0] >= 'a' && s[0] <= 'z')) return false;
    for (size_t i = 1; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
            return false;
    }
    return true;
}

/* ── Project secret read (per-call, not cached) ──────────── */

static int read_project_secret(const char *slug,
                               uint8_t out[NSD_BYOK_PROJECT_SECRET_BYTES]) {
    char secret_path[320];
    int n = snprintf(secret_path, sizeof(secret_path), "%s/%s/secret",
                     NSD_BYOK_PROJECT_DIR_ROOT, slug);
    if (n <= 0 || (size_t)n >= sizeof(secret_path)) return -1;
    int fd = open(secret_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        nsd_event("nsd.byok.secret-open-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
    if (!S_ISREG(sb.st_mode) || sb.st_uid != 0 ||
        sb.st_size != NSD_BYOK_PROJECT_SECRET_BYTES ||
        (sb.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
        close(fd);
        nsd_event("nsd.byok.secret-bad-shape",
                  "project", nsd_jstr(slug),
                  "size", nsd_jnum((long long)sb.st_size),
                  NULL);
        return -1;
    }
    size_t got = 0;
    while (got < NSD_BYOK_PROJECT_SECRET_BYTES) {
        ssize_t r = read(fd, out + got, NSD_BYOK_PROJECT_SECRET_BYTES - got);
        if (r > 0) { got += (size_t)r; continue; }
        if (r == 0) break;
        if (errno == EINTR) continue;
        close(fd);
        return -1;
    }
    close(fd);
    return got == NSD_BYOK_PROJECT_SECRET_BYTES ? 0 : -1;
}

/* ── HKDF subkey derivation ──────────────────────────────── */

/*
 * Derive a 32-byte subkey scoped to (master, project_secret, provider)
 * via HKDF-SHA256:
 *   subkey = HKDF-Expand(HKDF-Extract(salt=master, ikm=project_secret),
 *                        info="ellul-byok-v1\0" || provider, L=32)
 *
 * libsodium does not expose HKDF directly; we use crypto_auth_hmacsha256
 * twice (extract + expand) per RFC 5869.
 */
static int derive_subkey(const uint8_t master[NSD_BYOK_MASTER_BYTES],
                         const uint8_t project_secret[NSD_BYOK_PROJECT_SECRET_BYTES],
                         const char *provider, size_t provider_len,
                         uint8_t out_subkey[NSD_BYOK_SUBKEY_BYTES]) {
    /* Extract: PRK = HMAC-SHA256(salt=master, ikm=project_secret). */
    uint8_t prk[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_state st;
    crypto_auth_hmacsha256_init(&st, master, NSD_BYOK_MASTER_BYTES);
    crypto_auth_hmacsha256_update(&st, project_secret,
                                   NSD_BYOK_PROJECT_SECRET_BYTES);
    crypto_auth_hmacsha256_final(&st, prk);

    /* Expand single-block: T(1) = HMAC-SHA256(PRK, info || 0x01).
     * info = "ellul-byok-v1\0" || provider. */
    static const char info_prefix[] = "ellul-byok-v1";
    /* sizeof(info_prefix) = 14 (counts the trailing \0) — that's the
     * spec: the version label includes its NUL terminator, matching
     * how the C side reads sizeof("ellul-byok-v1") at compile time. */
    uint8_t T[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_state expand;
    crypto_auth_hmacsha256_init(&expand, prk, sizeof(prk));
    crypto_auth_hmacsha256_update(&expand, (const uint8_t *)info_prefix,
                                  sizeof(info_prefix));
    crypto_auth_hmacsha256_update(&expand, (const uint8_t *)provider,
                                  provider_len);
    uint8_t one = 0x01;
    crypto_auth_hmacsha256_update(&expand, &one, 1);
    crypto_auth_hmacsha256_final(&expand, T);

    /* Output is the first 32 bytes of T (subkey is exactly one HKDF
     * block on SHA-256). */
    memcpy(out_subkey, T, NSD_BYOK_SUBKEY_BYTES);

    sodium_memzero(prk, sizeof(prk));
    sodium_memzero(T, sizeof(T));
    sodium_memzero(&st, sizeof(st));
    sodium_memzero(&expand, sizeof(expand));
    return 0;
}

/* ── WRAP / UNWRAP ──────────────────────────────────────── */

int nsd_byok_wrap(const struct nsd_byok_state *st,
                  const char *project,
                  const char *provider, size_t provider_len,
                  uint8_t *plaintext, size_t plaintext_len,
                  uint8_t *out_wrapped, size_t out_cap,
                  size_t *out_len) {
    if (!st || !st->ready) return NSD_EINTERNAL;
    if (!nsd_byok_provider_ok(provider, provider_len)) return NSD_EPROTO;
    if (plaintext_len == 0 || plaintext_len > NSD_BYOK_PLAINTEXT_MAX)
        return NSD_EPROTO;
    if (out_cap < NSD_BYOK_NONCE_BYTES + plaintext_len + crypto_secretbox_MACBYTES)
        return NSD_EINTERNAL;

    uint8_t project_secret[NSD_BYOK_PROJECT_SECRET_BYTES];
    if (read_project_secret(project, project_secret) != 0) {
        sodium_memzero(plaintext, plaintext_len);
        return NSD_EINTERNAL;
    }

    uint8_t subkey[NSD_BYOK_SUBKEY_BYTES];
    derive_subkey(st->master, project_secret, provider, provider_len, subkey);
    sodium_memzero(project_secret, sizeof(project_secret));

    /* Generate fresh nonce; libsodium's crypto_secretbox uses 24-byte
     * XSalsa20 nonces. Random over 24 bytes is collision-safe under any
     * realistic key+message volume (birthday bound 2^96). */
    uint8_t nonce[NSD_BYOK_NONCE_BYTES];
    randombytes_buf(nonce, sizeof(nonce));

    /* Output: nonce || ciphertext. crypto_secretbox_easy writes
     * ciphertext = MAC(16) || encrypted(plaintext_len) into the buffer
     * starting at out_wrapped + NSD_BYOK_NONCE_BYTES. */
    memcpy(out_wrapped, nonce, NSD_BYOK_NONCE_BYTES);
    if (crypto_secretbox_easy(out_wrapped + NSD_BYOK_NONCE_BYTES,
                              plaintext, plaintext_len,
                              nonce, subkey) != 0) {
        sodium_memzero(subkey, sizeof(subkey));
        sodium_memzero(plaintext, plaintext_len);
        sodium_memzero(nonce, sizeof(nonce));
        return NSD_EINTERNAL;
    }
    *out_len = NSD_BYOK_NONCE_BYTES + plaintext_len + crypto_secretbox_MACBYTES;

    sodium_memzero(subkey, sizeof(subkey));
    sodium_memzero(plaintext, plaintext_len);
    sodium_memzero(nonce, sizeof(nonce));
    return NSD_OK;
}

int nsd_byok_unwrap(const struct nsd_byok_state *st,
                    const char *project,
                    const char *provider, size_t provider_len,
                    const uint8_t *wrapped, size_t wrapped_len,
                    uint8_t *out_plaintext, size_t out_cap,
                    size_t *out_len) {
    if (!st || !st->ready) return NSD_EINTERNAL;
    if (!nsd_byok_provider_ok(provider, provider_len)) return NSD_EPROTO;
    if (wrapped_len <= NSD_BYOK_NONCE_BYTES + crypto_secretbox_MACBYTES ||
        wrapped_len > NSD_BYOK_WRAPPED_MAX) return NSD_EPROTO;
    size_t plaintext_len = wrapped_len - NSD_BYOK_NONCE_BYTES
                           - crypto_secretbox_MACBYTES;
    if (plaintext_len > out_cap) return NSD_EINTERNAL;
    if (plaintext_len > NSD_BYOK_PLAINTEXT_MAX) return NSD_EPROTO;

    uint8_t project_secret[NSD_BYOK_PROJECT_SECRET_BYTES];
    if (read_project_secret(project, project_secret) != 0) return NSD_EINTERNAL;

    uint8_t subkey[NSD_BYOK_SUBKEY_BYTES];
    derive_subkey(st->master, project_secret, provider, provider_len, subkey);
    sodium_memzero(project_secret, sizeof(project_secret));

    int rc = crypto_secretbox_open_easy(out_plaintext,
                                        wrapped + NSD_BYOK_NONCE_BYTES,
                                        wrapped_len - NSD_BYOK_NONCE_BYTES,
                                        wrapped, subkey);
    sodium_memzero(subkey, sizeof(subkey));
    if (rc != 0) {
        /* Authentication failure: project secret rotated, master rotated,
         * provider mismatch, or ciphertext tampered. Caller can't
         * distinguish — they all surface as "key needs to be re-wrapped". */
        sodium_memzero(out_plaintext, out_cap);
        return NSD_EATTEST_MISMATCH;
    }
    *out_len = plaintext_len;
    return NSD_OK;
}

int nsd_byok_drop_project(const char *slug) {
    if (!slug_ok_byok(slug)) return NSD_EPROTO;

    char proj_dir[256];
    int n = snprintf(proj_dir, sizeof(proj_dir), "%s/%s",
                     NSD_BYOK_PROJECT_DIR_ROOT, slug);
    if (n <= 0 || (size_t)n >= sizeof(proj_dir)) return NSD_EINTERNAL;

    char secret_path[320];
    n = snprintf(secret_path, sizeof(secret_path), "%s/secret", proj_dir);
    if (n <= 0 || (size_t)n >= sizeof(secret_path)) return NSD_EINTERNAL;

    /* Revocation invariant: unlink the secret FIRST. A partial drop
     * that crashes between unlink and rmdir still revoked every
     * ciphertext wrapped under this project's secret. The reverse
     * order would leave a window where an attacker who races the
     * teardown could re-derive the subkey. */
    bool secret_unlinked = false;
    if (unlink(secret_path) == 0) {
        secret_unlinked = true;
    } else if (errno != ENOENT) {
        nsd_event("nsd.byok.secret-unlink-fail",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EINTERNAL;
    }

    /* Best-effort rmdir; missing dir is fine, non-empty dir is logged
     * but not fatal (operator can clean up manually). */
    if (rmdir(proj_dir) != 0 && errno != ENOENT) {
        nsd_event("nsd.byok.project-rmdir-skip",
                  "project", nsd_jstr(slug),
                  "errno", nsd_jnum(errno),
                  NULL);
    }

    if (secret_unlinked) {
        nsd_event("nsd.byok.project-revoked",
                  "project", nsd_jstr(slug),
                  NULL);
    }
    return NSD_OK;
}
