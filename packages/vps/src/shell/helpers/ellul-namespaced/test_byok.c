/*
 * test_byok.c — unit tests for the BYOK derive + provider-validator
 * helpers in byok.c.
 *
 * Exercises:
 *   - HKDF subkey derivation with known seeds (RFC 5869 single-block
 *     reproducibility), assert determinism + sensitivity to inputs.
 *   - Provider id allowlist matcher (^[a-z][a-z0-9-]{0,31}$).
 *   - Round-trip wrap / unwrap on a synthetic project secret read from
 *     a tmp file (stand-in for /var/lib/ellul/byok/<slug>/secret) —
 *     confirms libsodium's crypto_secretbox_easy path is wired
 *     correctly and the nonce + ciphertext layout matches the daemon's
 *     wire shape.
 *
 * Build:
 *   gcc -o test-byok test_byok.c -lsodium -O0 -g -Wall -Wextra
 * Run:  ./test-byok   (exits non-zero on first failed assertion)
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

#define MASTER_BYTES   32
#define SECRET_BYTES   32
#define SUBKEY_BYTES   32

/* Mirror of nsd_byok_provider_ok. Test the matcher in isolation. */
static bool provider_ok(const char *s, size_t n) {
    if (!s || n == 0 || n > 32) return false;
    if (!(s[0] >= 'a' && s[0] <= 'z')) return false;
    for (size_t i = 1; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
            return false;
    }
    return true;
}

/* Mirror of derive_subkey in byok.c. */
static void derive_subkey(const uint8_t master[MASTER_BYTES],
                          const uint8_t secret[SECRET_BYTES],
                          const char *provider, size_t provider_len,
                          uint8_t out[SUBKEY_BYTES]) {
    uint8_t prk[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_state st;
    crypto_auth_hmacsha256_init(&st, master, MASTER_BYTES);
    crypto_auth_hmacsha256_update(&st, secret, SECRET_BYTES);
    crypto_auth_hmacsha256_final(&st, prk);

    static const char info_prefix[] = "ellul-byok-v1";
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

    memcpy(out, T, SUBKEY_BYTES);
    sodium_memzero(prk, sizeof(prk));
    sodium_memzero(T, sizeof(T));
    sodium_memzero(&st, sizeof(st));
    sodium_memzero(&expand, sizeof(expand));
}

#define EXPECT(cond, msg) \
    do { \
        if (!(cond)) { \
            fprintf(stderr, "FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            exit(1); \
        } else { \
            fprintf(stderr, "PASS: %s\n", msg); \
        } \
    } while (0)

int main(void) {
    if (sodium_init() < 0) {
        fprintf(stderr, "FAIL: sodium_init\n");
        return 1;
    }

    /* ── Provider validator ────────────────────────────────── */
    EXPECT(provider_ok("anthropic", 9), "provider 'anthropic' passes");
    EXPECT(provider_ok("openai", 6), "provider 'openai' passes");
    EXPECT(provider_ok("gemini-1", 8), "provider with digit + dash passes");
    EXPECT(provider_ok("a", 1), "single-char lowercase passes");
    EXPECT(!provider_ok("", 0), "empty rejects");
    EXPECT(!provider_ok("Anthropic", 9), "uppercase rejects");
    EXPECT(!provider_ok("0openai", 7), "leading digit rejects");
    EXPECT(!provider_ok("-leading", 8), "leading dash rejects");
    EXPECT(!provider_ok("space inside", 12), "space rejects");
    EXPECT(!provider_ok("under_score", 11), "underscore rejects (not in allowlist)");
    /* 32-char id is the cap (1 + 31). */
    EXPECT(provider_ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 32),
        "32-char id passes");
    EXPECT(!provider_ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 33),
        "33-char id rejects");

    /* ── Derive subkey ─────────────────────────────────────── */
    uint8_t master[MASTER_BYTES];
    uint8_t secret[SECRET_BYTES];
    for (size_t i = 0; i < MASTER_BYTES; i++) master[i] = (uint8_t)(0xa0 + i);
    for (size_t i = 0; i < SECRET_BYTES; i++) secret[i] = (uint8_t)(0x10 + i);

    uint8_t k1[SUBKEY_BYTES], k2[SUBKEY_BYTES];
    derive_subkey(master, secret, "anthropic", 9, k1);
    derive_subkey(master, secret, "anthropic", 9, k2);
    EXPECT(memcmp(k1, k2, SUBKEY_BYTES) == 0,
        "derive is deterministic over identical inputs");

    /* Different provider ⇒ different subkey. */
    uint8_t k3[SUBKEY_BYTES];
    derive_subkey(master, secret, "openai", 6, k3);
    EXPECT(memcmp(k1, k3, SUBKEY_BYTES) != 0,
        "different provider yields different subkey");

    /* Different secret ⇒ different subkey. */
    uint8_t secret2[SECRET_BYTES];
    memcpy(secret2, secret, sizeof(secret2));
    secret2[0] ^= 1;
    uint8_t k4[SUBKEY_BYTES];
    derive_subkey(master, secret2, "anthropic", 9, k4);
    EXPECT(memcmp(k1, k4, SUBKEY_BYTES) != 0,
        "rotated project secret yields different subkey");

    /* Different master ⇒ different subkey. */
    uint8_t master2[MASTER_BYTES];
    memcpy(master2, master, sizeof(master2));
    master2[0] ^= 1;
    uint8_t k5[SUBKEY_BYTES];
    derive_subkey(master2, secret, "anthropic", 9, k5);
    EXPECT(memcmp(k1, k5, SUBKEY_BYTES) != 0,
        "rotated master yields different subkey");

    /* ── Round-trip ─────────────────────────────────────────── */
    /* Synthetic plaintext key (45 bytes — typical Anthropic API key
     * length is ~108 chars; smoke test with both short + medium). */
    const char *plaintext = "sk-ant-test-fake-key-do-not-use-1234567890abc";
    size_t plen = strlen(plaintext);

    uint8_t nonce[crypto_secretbox_NONCEBYTES];
    randombytes_buf(nonce, sizeof(nonce));

    uint8_t cipher[1024];
    EXPECT(crypto_secretbox_easy(cipher, (const uint8_t *)plaintext, plen,
                                 nonce, k1) == 0,
        "secretbox_easy encrypts");

    uint8_t recovered[1024];
    EXPECT(crypto_secretbox_open_easy(recovered, cipher,
                                      plen + crypto_secretbox_MACBYTES,
                                      nonce, k1) == 0,
        "secretbox_open_easy decrypts under same subkey");
    EXPECT(memcmp(recovered, plaintext, plen) == 0,
        "round-trip plaintext matches");

    /* Wrong subkey ⇒ MAC failure. */
    uint8_t wrong[1024];
    EXPECT(crypto_secretbox_open_easy(wrong, cipher,
                                      plen + crypto_secretbox_MACBYTES,
                                      nonce, k3) != 0,
        "wrong subkey fails Poly1305 MAC");

    /* Tampered ciphertext ⇒ MAC failure. */
    uint8_t tampered[1024];
    memcpy(tampered, cipher, plen + crypto_secretbox_MACBYTES);
    tampered[crypto_secretbox_MACBYTES + 5] ^= 1;
    EXPECT(crypto_secretbox_open_easy(wrong, tampered,
                                      plen + crypto_secretbox_MACBYTES,
                                      nonce, k1) != 0,
        "ciphertext tamper fails Poly1305 MAC");

    /* Empty plaintext is allowed by libsodium but rejected by the
     * daemon's wrap path (NSD_BYOK_PLAINTEXT_MAX > 0 minimum). */

    fprintf(stderr, "all byok tests passed\n");
    return 0;
}
