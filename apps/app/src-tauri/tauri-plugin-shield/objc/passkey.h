#ifndef ELLUL_PASSKEY_H
#define ELLUL_PASSKEY_H

#include <stddef.h>
#include <stdint.h>

typedef void (*EllulPasskeyCallback)(
    void *context,
    const uint8_t *result_json,
    size_t result_len,
    const char *error
);

void ellul_passkey_authenticate(
    const uint8_t *challenge,
    size_t challenge_len,
    const char *rp_id,
    EllulPasskeyCallback callback,
    void *context
);

void ellul_passkey_register(
    const uint8_t *challenge,
    size_t challenge_len,
    const char *rp_id,
    const uint8_t *user_id,
    size_t user_id_len,
    const char *user_name,
    const char *user_display_name,
    EllulPasskeyCallback callback,
    void *context
);

#endif
