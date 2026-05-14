/*
 * ellul-namespaced — manifest parser + verifier.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "manifest.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <sodium.h>

#include <cbor.h>

/* ── Helpers ─────────────────────────────────────────────── */

static int read_file(const char *path, uint8_t **out, size_t *out_len, size_t max) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
    if (!S_ISREG(sb.st_mode) || sb.st_size <= 0 || (size_t)sb.st_size > max) {
        close(fd); errno = EINVAL; return -1;
    }
    size_t n = (size_t)sb.st_size;
    uint8_t *buf = malloc(n);
    if (!buf) { close(fd); errno = ENOMEM; return -1; }
    size_t got = 0;
    while (got < n) {
        ssize_t r = read(fd, buf + got, n - got);
        if (r < 0) {
            if (errno == EINTR) continue;
            free(buf); close(fd); return -1;
        }
        if (r == 0) break;
        got += (size_t)r;
    }
    close(fd);
    if (got != n) { free(buf); errno = EIO; return -1; }
    *out = buf;
    *out_len = n;
    return 0;
}

void nsd_manifest_pubkey_fingerprint(const uint8_t pubkey[NSD_PUBKEY_BYTES],
                                      uint8_t out[NSD_FINGERPRINT_BYTES]) {
    crypto_hash_sha256(out, pubkey, NSD_PUBKEY_BYTES);
}

void nsd_manifest_read_host_tier(char out[16]) {
    memset(out, 0, 16);
    int fd = open(NSD_BILLING_TIER_PATH, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { strcpy(out, "free"); return; }
    char buf[32] = {0};
    ssize_t r = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (r <= 0) { strcpy(out, "free"); return; }
    /* Strip whitespace */
    char *p = buf;
    while (*p == ' ' || *p == '\t') p++;
    char *q = p;
    while (*q && *q != '\n' && *q != '\r' && *q != ' ') q++;
    *q = 0;
    if (!*p) { strcpy(out, "free"); return; }
    /* Allowed values only: free|paid */
    if (strcmp(p, "free") == 0 || strcmp(p, "paid") == 0) {
        strncpy(out, p, 15);
    } else {
        strcpy(out, "free");
    }
}

/* ── Compute the canonical digest over the signed portion of a manifest.
 *
 * The on-wire signed-portion is "the CBOR map with key 10 (sig) absent".
 * We don't re-encode; instead we leverage tinycbor to find key 10's
 * value range and exclude (key, value) bytes from the digest.
 *
 * Approach: parse the map, walk pairs; for each pair, capture
 * (key_offset, value_end_offset). After the walk, we have the byte ranges
 * of every pair and can compute a digest over [map_header, pair0, pair1,
 * ... pair(n-1)] where pair_i is excluded if its key is 10.
 */
struct map_pair_range {
    uint8_t key;
    size_t  start;  /* byte offset (within parsed buffer) of the key */
    size_t  end;    /* byte offset just past the value */
};

static int compute_signed_digest(const uint8_t *buf, size_t len,
                                 const struct map_pair_range *pairs, size_t n_pairs,
                                 size_t map_header_end,
                                 uint8_t out[NSD_SHA256_BYTES]) {
    /* Need to write a new map header with (n_pairs - 1) entries, then the
     * non-sig pair byte ranges. The original map header bytes encode the
     * full pair count, which we have to replace; the count differs by 1. */
    size_t signed_count = 0;
    for (size_t i = 0; i < n_pairs; i++) if (pairs[i].key != 10) signed_count++;
    if (signed_count == n_pairs) {
        /* No sig key — invalid manifest. */
        return -1;
    }

    /* Encode new map header for signed_count entries. */
    uint8_t hdr[9];
    size_t  hdrlen;
    if (signed_count < 24) {
        hdr[0] = (uint8_t)((5 << 5) | signed_count); hdrlen = 1;
    } else if (signed_count <= 0xff) {
        hdr[0] = (uint8_t)((5 << 5) | 24); hdr[1] = (uint8_t)signed_count; hdrlen = 2;
    } else if (signed_count <= 0xffff) {
        hdr[0] = (uint8_t)((5 << 5) | 25);
        hdr[1] = (uint8_t)(signed_count >> 8);
        hdr[2] = (uint8_t)signed_count; hdrlen = 3;
    } else {
        return -1;  /* Not happening — manifests have single-digit pair counts. */
    }
    (void) buf; (void) map_header_end;

    crypto_hash_sha256_state st;
    crypto_hash_sha256_init(&st);
    crypto_hash_sha256_update(&st, hdr, hdrlen);
    for (size_t i = 0; i < n_pairs; i++) {
        if (pairs[i].key == 10) continue;
        if (pairs[i].end <= pairs[i].start) return -1;
        crypto_hash_sha256_update(&st, buf + pairs[i].start,
                                  pairs[i].end - pairs[i].start);
    }
    crypto_hash_sha256_final(&st, out);
    return 0;
}

/* tinycbor's public copy API: writes (up to *buflen) bytes into the
 * provided buffer, sets *buflen to the actual length, and advances
 * `next` (which can be the same iterator). Handles multi-chunk strings
 * internally — far safer than the private _cbor_value_get_string_chunk
 * which we previously called with a `bool*` where it expected a
 * `CborValue*`, smashing the stack on every text-field parse. */
static int parse_string_chunk(CborValue *v, char *dst, size_t cap) {
    if (!cbor_value_is_text_string(v) || !cbor_value_is_length_known(v))
        return -1;
    size_t n;
    if (cbor_value_get_string_length(v, &n) != CborNoError) return -1;
    if (n + 1 > cap) return -1;
    size_t buflen = cap;
    if (cbor_value_copy_text_string(v, dst, &buflen, v) != CborNoError) return -1;
    if (buflen >= cap) return -1;
    dst[buflen] = 0;
    return 0;
}

static int parse_bstr_chunk(CborValue *v, uint8_t *dst, size_t exact_len) {
    if (!cbor_value_is_byte_string(v) || !cbor_value_is_length_known(v))
        return -1;
    size_t n;
    if (cbor_value_get_string_length(v, &n) != CborNoError) return -1;
    if (n != exact_len) return -1;
    size_t buflen = exact_len;
    if (cbor_value_copy_byte_string(v, dst, &buflen, v) != CborNoError) return -1;
    if (buflen != exact_len) return -1;
    return 0;
}

static int parse_uint64(CborValue *v, uint64_t *out) {
    if (!cbor_value_is_unsigned_integer(v)) return -1;
    CborError ce = cbor_value_get_uint64(v, out);
    if (ce != CborNoError) return -1;
    ce = cbor_value_advance(v);
    if (ce != CborNoError) return -1;
    return 0;
}

static int parse_bool(CborValue *v, bool *out) {
    if (!cbor_value_is_boolean(v)) return -1;
    CborError ce = cbor_value_get_boolean(v, out);
    if (ce != CborNoError) return -1;
    ce = cbor_value_advance(v);
    if (ce != CborNoError) return -1;
    return 0;
}

/* Parse one mount-entry CBOR map into a manifest_mount struct. */
static int parse_mount(CborValue *map, struct nsd_manifest_mount *m) {
    if (!cbor_value_is_map(map) || !cbor_value_is_length_known(map)) return -1;
    CborValue it;
    CborError ce = cbor_value_enter_container(map, &it);
    if (ce != CborNoError) return -1;

    /* Defaults. */
    m->kind = 0;
    m->mandatory = false;
    m->has_source = false;
    m->has_fstype = false;
    m->flags = 0;
    m->options_required_n = 0;
    m->target_template[0] = 0;
    m->source_template[0] = 0;
    m->post_check_fstype[0] = 0;

    while (!cbor_value_at_end(&it)) {
        if (!cbor_value_is_unsigned_integer(&it)) return -1;
        uint64_t key;
        ce = cbor_value_get_uint64(&it, &key);
        if (ce != CborNoError) return -1;
        ce = cbor_value_advance(&it);
        if (ce != CborNoError) return -1;
        switch (key) {
        case 1:
            if (parse_string_chunk(&it, m->target_template, sizeof(m->target_template)) != 0) return -1;
            break;
        case 2: {
            uint64_t k;
            if (parse_uint64(&it, &k) != 0) return -1;
            if (k < 1 || k > 6) return -1;
            m->kind = (uint8_t)k;
            break;
        }
        case 3:
            if (cbor_value_is_null(&it)) {
                ce = cbor_value_advance(&it);
                if (ce != CborNoError) return -1;
                m->has_source = false;
            } else {
                if (parse_string_chunk(&it, m->source_template, sizeof(m->source_template)) != 0) return -1;
                m->has_source = true;
            }
            break;
        case 4:
            if (parse_bool(&it, &m->mandatory) != 0) return -1;
            break;
        case 5:
            if (cbor_value_is_null(&it)) {
                ce = cbor_value_advance(&it);
                if (ce != CborNoError) return -1;
                m->has_fstype = false;
            } else {
                if (parse_string_chunk(&it, m->post_check_fstype, sizeof(m->post_check_fstype)) != 0) return -1;
                m->has_fstype = true;
            }
            break;
        case 6: {
            uint64_t f;
            if (parse_uint64(&it, &f) != 0) return -1;
            if (f > 0xff) return -1;
            m->flags = (uint32_t)f;
            break;
        }
        case 7: {
            if (!cbor_value_is_array(&it) || !cbor_value_is_length_known(&it)) return -1;
            size_t n;
            ce = cbor_value_get_array_length(&it, &n);
            if (ce != CborNoError) return -1;
            if (n > NSD_MAX_OPTIONS_PER_MOUNT) return -1;
            CborValue arr;
            ce = cbor_value_enter_container(&it, &arr);
            if (ce != CborNoError) return -1;
            for (size_t i = 0; i < n; i++) {
                if (parse_string_chunk(&arr, m->options_required[i],
                                       sizeof(m->options_required[i])) != 0) return -1;
            }
            ce = cbor_value_leave_container(&it, &arr);
            if (ce != CborNoError) return -1;
            m->options_required_n = n;
            break;
        }
        default:
            /* Unknown key in mount entry — strict mode rejects. */
            return -1;
        }
    }
    if (m->target_template[0] == 0 || m->kind == 0) return -1;
    /* Reject ".." in templates (defense in depth; substitution also checks). */
    if (strstr(m->target_template, "..")) return -1;
    if (m->has_source && strstr(m->source_template, "..")) return -1;

    ce = cbor_value_leave_container(map, &it);
    if (ce != CborNoError) return -1;
    return 0;
}

int nsd_manifest_load_for_tier(const uint8_t pubkey[NSD_PUBKEY_BYTES],
                                const uint8_t *pubkey_next,
                                struct nsd_manifest **out) {
    char tier[16];
    nsd_manifest_read_host_tier(tier);
    char path[256];
    snprintf(path, sizeof(path), "%s/%s.cbor", NSD_MANIFEST_DIR, tier);

    uint8_t *buf = NULL;
    size_t   len = 0;
    if (read_file(path, &buf, &len, 64 * 1024) != 0) {
        nsd_event("nsd.manifest.load.fail",
                  "reason", nsd_jstr("read"),
                  "path", nsd_jstr(path),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -NSD_EMANIFEST_SIG;
    }

    /* Parse outer map and capture per-pair byte ranges. */
    CborParser parser;
    CborValue  root;
    CborError  ce = cbor_parser_init(buf, len, CborValidateStrictMode, &parser, &root);
    if (ce != CborNoError) goto bad;
    if (!cbor_value_is_map(&root) || !cbor_value_is_length_known(&root)) goto bad;
    size_t n_pairs;
    ce = cbor_value_get_map_length(&root, &n_pairs);
    if (ce != CborNoError) goto bad;
    if (n_pairs == 0 || n_pairs > 16) goto bad;

    CborValue it;
    ce = cbor_value_enter_container(&root, &it);
    if (ce != CborNoError) goto bad;

    struct map_pair_range pairs[16];
    /* Body of the outer map starts at the first pair's key. */
    const uint8_t *map_body_start = cbor_value_get_next_byte(&it);
    if (map_body_start == NULL) goto bad;
    size_t map_body_off = (size_t)(map_body_start - buf);

    /* We'll resolve each pair's start/end by walking with cbor_value_get_next_byte
     * before/after the value advance. */
    for (size_t i = 0; i < n_pairs; i++) {
        const uint8_t *key_start = cbor_value_get_next_byte(&it);
        if (!key_start) goto bad;
        size_t key_off = (size_t)(key_start - buf);

        if (!cbor_value_is_unsigned_integer(&it)) goto bad;
        uint64_t k;
        ce = cbor_value_get_uint64(&it, &k);
        if (ce != CborNoError) goto bad;
        if (k > 0xff) goto bad;

        ce = cbor_value_advance(&it);  /* now at value */
        if (ce != CborNoError) goto bad;

        /* Skip the value; we'll re-parse the manifest below. */
        ce = cbor_value_advance(&it);
        if (ce != CborNoError) goto bad;

        const uint8_t *value_end = cbor_value_get_next_byte(&it);
        if (!value_end) value_end = buf + len;
        size_t end_off = (size_t)(value_end - buf);

        pairs[i].key = (uint8_t)k;
        pairs[i].start = key_off;
        pairs[i].end = end_off;
    }

    /* Compute the digest over the signed portion. */
    uint8_t signed_digest[NSD_SHA256_BYTES];
    if (compute_signed_digest(buf, len, pairs, n_pairs, map_body_off, signed_digest) != 0)
        goto bad;

    /* Verify sig: re-walk to find sig (key=10) and verify
     * Ed25519(pubkey, signed_digest, sig). */
    ce = cbor_parser_init(buf, len, CborValidateStrictMode, &parser, &root);
    if (ce != CborNoError) goto bad;
    ce = cbor_value_enter_container(&root, &it);
    if (ce != CborNoError) goto bad;

    uint8_t sig[NSD_ED25519_SIG_BYTES];
    bool sig_present = false;

    /* Allocate result first; we want to reuse the parser walk for fields. */
    struct nsd_manifest *m = calloc(1, sizeof(*m));
    if (!m) goto bad;
    m->version = 0;
    /* Default project_slug_re. */
    strcpy(m->project_slug_re, "^sbx-[a-z0-9]{7}$");
    /* Default host_id_re (any). */
    strcpy(m->host_id_re, ".*");

    while (!cbor_value_at_end(&it)) {
        if (!cbor_value_is_unsigned_integer(&it)) goto bad_free;
        uint64_t k;
        ce = cbor_value_get_uint64(&it, &k);
        if (ce != CborNoError) goto bad_free;
        ce = cbor_value_advance(&it);
        if (ce != CborNoError) goto bad_free;
        switch (k) {
        case 1: {
            uint64_t v;
            if (parse_uint64(&it, &v) != 0) goto bad_free;
            if (v != NSD_MANIFEST_VERSION) goto bad_free;
            m->version = (uint32_t)v;
            break;
        }
        case 2: if (parse_uint64(&it, &m->issued_at_unix_s) != 0) goto bad_free; break;
        case 3: if (parse_uint64(&it, &m->not_after_unix_s) != 0) goto bad_free; break;
        case 4:
            if (parse_string_chunk(&it, m->applies_to_tier, sizeof(m->applies_to_tier)) != 0)
                goto bad_free;
            break;
        case 5:
            if (parse_string_chunk(&it, m->project_slug_re, sizeof(m->project_slug_re)) != 0)
                goto bad_free;
            break;
        case 6: {
            if (!cbor_value_is_array(&it) || !cbor_value_is_length_known(&it))
                goto bad_free;
            size_t n;
            ce = cbor_value_get_array_length(&it, &n);
            if (ce != CborNoError) goto bad_free;
            if (n > NSD_MAX_MOUNTS_PER_MANIFEST) goto bad_free;
            CborValue arr;
            ce = cbor_value_enter_container(&it, &arr);
            if (ce != CborNoError) goto bad_free;
            for (size_t i = 0; i < n; i++) {
                if (parse_mount(&arr, &m->mounts[i]) != 0) goto bad_free;
            }
            ce = cbor_value_leave_container(&it, &arr);
            if (ce != CborNoError) goto bad_free;
            m->mounts_n = n;
            break;
        }
        case 7:
            /* network: opaque to attestation today; skip. */
            ce = cbor_value_advance(&it);
            if (ce != CborNoError) goto bad_free;
            break;
        case 8:
            if (parse_bstr_chunk(&it, m->binaries_digest, NSD_SHA256_BYTES) != 0)
                goto bad_free;
            m->has_binaries_digest = true;
            break;
        case 9:
            if (parse_string_chunk(&it, m->host_id_re, sizeof(m->host_id_re)) != 0)
                goto bad_free;
            break;
        case 10:
            if (parse_bstr_chunk(&it, sig, NSD_ED25519_SIG_BYTES) != 0) goto bad_free;
            sig_present = true;
            break;
        default:
            goto bad_free;
        }
    }

    if (!sig_present || m->version == 0 || m->mounts_n == 0 ||
        m->applies_to_tier[0] == 0) {
        nsd_event("nsd.manifest.load.fail",
                  "reason", nsd_jstr("missing-required-fields"),
                  NULL);
        goto bad_free;
    }

    /* Verify signature: try primary key first, then rotation key. */
    if (crypto_sign_verify_detached(sig, signed_digest, NSD_SHA256_BYTES, pubkey) != 0) {
        if (!pubkey_next ||
            crypto_sign_verify_detached(sig, signed_digest, NSD_SHA256_BYTES, pubkey_next) != 0) {
            nsd_event("nsd.manifest.load.fail", "reason", nsd_jstr("ed25519-verify"), NULL);
            goto bad_free;
        }
    }

    /* Verify expiry. */
    time_t now = time(NULL);
    if (m->not_after_unix_s != 0 && (uint64_t)now > m->not_after_unix_s) {
        nsd_event("nsd.manifest.load.fail", "reason", nsd_jstr("expired"), NULL);
        goto bad_free;
    }

    /* Verify tier match. */
    if (strcmp(m->applies_to_tier, tier) != 0) {
        nsd_event("nsd.manifest.load.fail",
                  "reason", nsd_jstr("tier-mismatch"),
                  "manifest_tier", nsd_jstr(m->applies_to_tier),
                  "host_tier", nsd_jstr(tier),
                  NULL);
        goto bad_free;
    }

    /* Compile slug regex. */
    if (regcomp(&m->project_slug_rx, m->project_slug_re, REG_EXTENDED | REG_NOSUB) != 0) {
        nsd_event("nsd.manifest.load.fail", "reason", nsd_jstr("slug-regex-bad"), NULL);
        goto bad_free;
    }
    m->has_project_slug_rx = true;

    /* Compile + match host_id regex. */
    if (regcomp(&m->host_id_rx, m->host_id_re, REG_EXTENDED | REG_NOSUB) != 0) {
        nsd_event("nsd.manifest.load.fail", "reason", nsd_jstr("hostid-regex-bad"), NULL);
        goto bad_free;
    }
    m->has_host_id_rx = true;

    char host_id[128] = {0};
    int hfd = open("/etc/ellul-bootstrap/server-id", O_RDONLY | O_CLOEXEC);
    if (hfd >= 0) {
        ssize_t r = read(hfd, host_id, sizeof(host_id) - 1);
        close(hfd);
        if (r > 0) {
            char *nl = strpbrk(host_id, "\r\n");
            if (nl) *nl = 0;
        }
    }
    if (regexec(&m->host_id_rx, host_id, 0, NULL, 0) != 0) {
        nsd_event("nsd.manifest.load.fail",
                  "reason", nsd_jstr("hostid-mismatch"),
                  "host_id", nsd_jstr(host_id),
                  NULL);
        goto bad_free;
    }

    /* Compute manifest digest (over the full signed bytes; useful as
     * fingerprint surface). */
    crypto_hash_sha256(m->digest, buf, len);

    free(buf);
    *out = m;
    nsd_event("nsd.manifest.load.ok",
              "tier", nsd_jstr(tier),
              "mounts", nsd_jnum((long long)m->mounts_n),
              "digest", nsd_jbytes_hex(m->digest, NSD_SHA256_BYTES),
              NULL);
    return 0;

bad_free:
    if (m->has_project_slug_rx) regfree(&m->project_slug_rx);
    if (m->has_host_id_rx) regfree(&m->host_id_rx);
    free(m);
bad:
    free(buf);
    return -NSD_EMANIFEST_SIG;
}

void nsd_manifest_free(struct nsd_manifest *m) {
    if (!m) return;
    if (m->has_project_slug_rx) regfree(&m->project_slug_rx);
    if (m->has_host_id_rx) regfree(&m->host_id_rx);
    free(m);
}

/* ── Path template substitution ──────────────────────────── */

int nsd_manifest_substitute(const char *tmpl, const char *project,
                             const char *home, char *dst, size_t dst_cap) {
    if (!tmpl || !project || !home || !dst || dst_cap == 0) return -1;
    size_t pos = 0;
    const char *p = tmpl;
    while (*p) {
        /* Reject shell metacharacters defensively. */
        if (*p == ';' || *p == '|' || *p == '&' || *p == '`' ||
            *p == '$' || *p == '\\' || *p == '"' || *p == '\'') return -1;
        if (*p == '{') {
            if (strncmp(p, "{project}", 9) == 0) {
                size_t pl = strlen(project);
                if (pos + pl >= dst_cap) return -1;
                memcpy(dst + pos, project, pl);
                pos += pl;
                p += 9;
                continue;
            }
            if (strncmp(p, "{home}", 6) == 0) {
                size_t hl = strlen(home);
                if (pos + hl >= dst_cap) return -1;
                memcpy(dst + pos, home, hl);
                pos += hl;
                p += 6;
                continue;
            }
            return -1;  /* Unknown placeholder. */
        }
        if (pos + 1 >= dst_cap) return -1;
        dst[pos++] = *p++;
    }
    dst[pos] = 0;
    /* Final defense: reject ".." after substitution. */
    if (strstr(dst, "..")) return -1;
    /* Must be absolute. */
    if (dst[0] != '/') return -1;
    return 0;
}
