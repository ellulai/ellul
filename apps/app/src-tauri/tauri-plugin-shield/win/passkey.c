#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <webauthn.h>
#include <stdio.h>
#include <string.h>

typedef void (*EllulPasskeyCallback)(const char *json, const char *error, int cancelled, void *ctx);

// ── Function pointer types ──────────────────────────────────────

typedef DWORD (WINAPI *PFN_WebAuthNGetApiVersionNumber)(void);
typedef HRESULT (WINAPI *PFN_WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable)(BOOL *);
typedef HRESULT (WINAPI *PFN_WebAuthNAuthenticatorGetAssertion)(
    HWND, LPCWSTR, PCWEBAUTHN_CLIENT_DATA, PCWEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    PWEBAUTHN_ASSERTION *);
typedef HRESULT (WINAPI *PFN_WebAuthNAuthenticatorMakeCredential)(
    HWND, PCWEBAUTHN_RP_ENTITY_INFORMATION, PCWEBAUTHN_USER_ENTITY_INFORMATION,
    PCWEBAUTHN_COSE_CREDENTIAL_PARAMETERS, PCWEBAUTHN_CLIENT_DATA,
    PCWEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    PWEBAUTHN_CREDENTIAL_ATTESTATION *);
typedef void (WINAPI *PFN_WebAuthNFreeAssertion)(PWEBAUTHN_ASSERTION);
typedef void (WINAPI *PFN_WebAuthNFreeCredentialAttestation)(PWEBAUTHN_CREDENTIAL_ATTESTATION);
typedef PCWSTR (WINAPI *PFN_WebAuthNGetErrorName)(HRESULT);

// ── Thread-safe DLL loading ─────────────────────────────────────

static INIT_ONCE g_init_once = INIT_ONCE_STATIC_INIT;
static BOOL g_loaded_ok = FALSE;
static HMODULE g_hWebAuthN = NULL;
static PFN_WebAuthNGetApiVersionNumber pfnGetApiVersion = NULL;
static PFN_WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable pfnIsAvailable = NULL;
static PFN_WebAuthNAuthenticatorGetAssertion pfnGetAssertion = NULL;
static PFN_WebAuthNAuthenticatorMakeCredential pfnMakeCredential = NULL;
static PFN_WebAuthNFreeAssertion pfnFreeAssertion = NULL;
static PFN_WebAuthNFreeCredentialAttestation pfnFreeAttestation = NULL;
static PFN_WebAuthNGetErrorName pfnGetErrorName = NULL;

static BOOL CALLBACK init_webauthn_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    (void)once; (void)param; (void)ctx;
    g_hWebAuthN = LoadLibraryW(L"webauthn.dll");
    if (!g_hWebAuthN) return TRUE;

    pfnGetApiVersion = (PFN_WebAuthNGetApiVersionNumber)GetProcAddress(g_hWebAuthN, "WebAuthNGetApiVersionNumber");
    pfnIsAvailable = (PFN_WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable)GetProcAddress(g_hWebAuthN, "WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable");
    pfnGetAssertion = (PFN_WebAuthNAuthenticatorGetAssertion)GetProcAddress(g_hWebAuthN, "WebAuthNAuthenticatorGetAssertion");
    pfnMakeCredential = (PFN_WebAuthNAuthenticatorMakeCredential)GetProcAddress(g_hWebAuthN, "WebAuthNAuthenticatorMakeCredential");
    pfnFreeAssertion = (PFN_WebAuthNFreeAssertion)GetProcAddress(g_hWebAuthN, "WebAuthNFreeAssertion");
    pfnFreeAttestation = (PFN_WebAuthNFreeCredentialAttestation)GetProcAddress(g_hWebAuthN, "WebAuthNFreeCredentialAttestation");
    pfnGetErrorName = (PFN_WebAuthNGetErrorName)GetProcAddress(g_hWebAuthN, "WebAuthNGetErrorName");

    g_loaded_ok = (pfnGetAssertion && pfnMakeCredential && pfnFreeAssertion && pfnFreeAttestation);
    if (!g_loaded_ok) {
        FreeLibrary(g_hWebAuthN);
        g_hWebAuthN = NULL;
    }
    return TRUE;
}

static int ensure_webauthn(void) {
    InitOnceExecuteOnce(&g_init_once, init_webauthn_once, NULL, NULL);
    return g_loaded_ok;
}

// ── Base64URL encode ────────────────────────────────────────────

static const char b64_chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static char *b64url_encode(const BYTE *data, DWORD len) {
    DWORD out_cap = 4 * ((len + 2) / 3) + 1;
    char *out = (char *)malloc(out_cap);
    if (!out) return NULL;

    DWORD i, j = 0;
    for (i = 0; i + 2 < len; i += 3) {
        unsigned int n = ((unsigned int)data[i] << 16) | ((unsigned int)data[i+1] << 8) | data[i+2];
        out[j++] = b64_chars[(n >> 18) & 0x3F];
        out[j++] = b64_chars[(n >> 12) & 0x3F];
        out[j++] = b64_chars[(n >> 6) & 0x3F];
        out[j++] = b64_chars[n & 0x3F];
    }
    if (i < len) {
        unsigned int n = (unsigned int)data[i] << 16;
        if (i + 1 < len) n |= (unsigned int)data[i+1] << 8;
        out[j++] = b64_chars[(n >> 18) & 0x3F];
        out[j++] = b64_chars[(n >> 12) & 0x3F];
        if (i + 1 < len) out[j++] = b64_chars[(n >> 6) & 0x3F];
    }
    out[j] = '\0';
    return out;
}

// ── Base64URL decode ────────────────────────────────────────────

static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-' || c == '+') return 62;
    if (c == '_' || c == '/') return 63;
    return -1;
}

static BYTE *b64url_decode(const char *input, DWORD *out_len) {
    size_t in_len = strlen(input);
    *out_len = 0;
    if (in_len == 0) return NULL;

    BYTE *out = (BYTE *)malloc((in_len * 3) / 4 + 3);
    if (!out) return NULL;

    DWORD j = 0;
    size_t i = 0;
    while (i < in_len) {
        int a = (i < in_len) ? b64_val(input[i++]) : -1;
        int b = (i < in_len) ? b64_val(input[i++]) : -1;
        if (a < 0 || b < 0) break;
        int c = (i < in_len) ? b64_val(input[i++]) : -1;
        int d = (i < in_len) ? b64_val(input[i++]) : -1;

        out[j++] = (BYTE)(((a << 2) | (b >> 4)) & 0xFF);
        if (c >= 0) out[j++] = (BYTE)(((b << 4) | (c >> 2)) & 0xFF);
        if (d >= 0) out[j++] = (BYTE)(((c << 6) | d) & 0xFF);
    }
    *out_len = j;
    return out;
}

// ── UTF-8 → UTF-16 ─────────────────────────────────────────────

static WCHAR *utf8_to_wide(const char *s) {
    if (!s) return NULL;
    int wlen = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (wlen <= 0) return NULL;
    WCHAR *ws = (WCHAR *)malloc(wlen * sizeof(WCHAR));
    if (ws) MultiByteToWideChar(CP_UTF8, 0, s, -1, ws, wlen);
    return ws;
}

// ── clientDataJSON construction ─────────────────────────────────
// Browsers construct this; native apps must do it themselves.

static char *make_client_data_json(
    const char *type,
    const unsigned char *challenge, size_t challenge_len,
    const char *rp_id
) {
    char *challenge_b64 = b64url_encode(challenge, (DWORD)challenge_len);
    if (!challenge_b64) return NULL;

    size_t sz = 128 + strlen(type) + strlen(challenge_b64) + strlen(rp_id);
    char *cdj = (char *)malloc(sz);
    if (cdj) {
        snprintf(cdj, sz,
            "{\"type\":\"%s\",\"challenge\":\"%s\",\"origin\":\"https://%s\",\"crossOrigin\":false}",
            type, challenge_b64, rp_id);
    }
    free(challenge_b64);
    return cdj;
}

// ── allowCredentials JSON parser ────────────────────────────────
// Parses [{"id":"<base64url>",...}, ...] — extracts "id" values only.

static WEBAUTHN_CREDENTIAL *parse_allow_creds(const char *json, DWORD *out_count) {
    *out_count = 0;
    if (!json || json[0] != '[') return NULL;

    DWORD capacity = 0;
    for (const char *p = json; (p = strstr(p, "\"id\"")) != NULL; p += 4)
        capacity++;
    if (capacity == 0) return NULL;

    WEBAUTHN_CREDENTIAL *creds = (WEBAUTHN_CREDENTIAL *)calloc(capacity, sizeof(WEBAUTHN_CREDENTIAL));
    if (!creds) return NULL;

    DWORD n = 0;
    const char *p = json;
    while (n < capacity && (p = strstr(p, "\"id\"")) != NULL) {
        p += 4;
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
        if (*p != ':') continue;
        p++;
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
        if (*p != '"') continue;
        p++;

        const char *end = strchr(p, '"');
        if (!end) break;

        size_t val_len = (size_t)(end - p);
        char *val = (char *)malloc(val_len + 1);
        if (!val) break;
        memcpy(val, p, val_len);
        val[val_len] = '\0';

        DWORD id_len = 0;
        BYTE *id = b64url_decode(val, &id_len);
        free(val);

        if (id && id_len > 0) {
            creds[n].dwVersion = WEBAUTHN_CREDENTIAL_CURRENT_VERSION;
            creds[n].cbId = id_len;
            creds[n].pbId = id;
            creds[n].pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
            n++;
        } else {
            free(id);
        }
        p = end + 1;
    }

    if (n == 0) { free(creds); return NULL; }
    *out_count = n;
    return creds;
}

static void free_allow_creds(WEBAUTHN_CREDENTIAL *creds, DWORD count) {
    if (!creds) return;
    for (DWORD i = 0; i < count; i++) free(creds[i].pbId);
    free(creds);
}

// ── JSON response builders ──────────────────────────────────────

static char *build_assertion_json(
    PWEBAUTHN_ASSERTION a,
    const char *cdj, size_t cdj_len
) {
    char *id = b64url_encode(a->Credential.pbId, a->Credential.cbId);
    char *auth_data = b64url_encode(a->pbAuthenticatorData, a->cbAuthenticatorData);
    char *sig = b64url_encode(a->pbSignature, a->cbSignature);
    char *client_data = b64url_encode((const BYTE *)cdj, (DWORD)cdj_len);
    char *user_handle = NULL;
    if (a->pbUserId && a->cbUserId > 0)
        user_handle = b64url_encode(a->pbUserId, a->cbUserId);

    if (!id || !auth_data || !sig || !client_data) {
        free(id); free(auth_data); free(sig); free(client_data); free(user_handle);
        return NULL;
    }

    size_t buf = 512 + strlen(id) + strlen(auth_data) + strlen(sig) +
                 strlen(client_data) + (user_handle ? strlen(user_handle) : 0);
    char *json = (char *)malloc(buf);
    if (!json) goto cleanup;

    int w = snprintf(json, buf,
        "{\"type\":\"public-key\","
        "\"id\":\"%s\","
        "\"rawId\":\"%s\","
        "\"authenticatorAttachment\":\"platform\","
        "\"response\":{"
        "\"clientDataJSON\":\"%s\","
        "\"authenticatorData\":\"%s\","
        "\"signature\":\"%s\"",
        id, id, client_data, auth_data, sig);

    if (user_handle)
        w += snprintf(json + w, buf - w, ",\"userHandle\":\"%s\"", user_handle);
    snprintf(json + w, buf - w, "}}");

cleanup:
    free(id); free(auth_data); free(sig); free(client_data); free(user_handle);
    return json;
}

static char *build_attestation_json(
    PWEBAUTHN_CREDENTIAL_ATTESTATION a,
    const char *cdj, size_t cdj_len
) {
    char *id = b64url_encode(a->pbCredentialId, a->cbCredentialId);
    char *att_obj = b64url_encode(a->pbAttestationObject, a->cbAttestationObject);
    char *client_data = b64url_encode((const BYTE *)cdj, (DWORD)cdj_len);

    if (!id || !att_obj || !client_data) {
        free(id); free(att_obj); free(client_data);
        return NULL;
    }

    size_t buf = 512 + strlen(id) + strlen(att_obj) + strlen(client_data);
    char *json = (char *)malloc(buf);
    if (!json) goto cleanup;

    snprintf(json, buf,
        "{\"type\":\"public-key\","
        "\"id\":\"%s\","
        "\"rawId\":\"%s\","
        "\"authenticatorAttachment\":\"platform\","
        "\"response\":{\"clientDataJSON\":\"%s\",\"attestationObject\":\"%s\"}}",
        id, id, client_data, att_obj);

cleanup:
    free(id); free(att_obj); free(client_data);
    return json;
}

// ── Error reporting helper ──────────────────────────────────────

static void report_error(HRESULT hr, EllulPasskeyCallback callback, void *ctx) {
    if (hr == NTE_USER_CANCELLED || hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
        callback(NULL, "User cancelled", 1, ctx);
    } else {
        char err[256];
        if (pfnGetErrorName) {
            PCWSTR errW = pfnGetErrorName(hr);
            WideCharToMultiByte(CP_UTF8, 0, errW, -1, err, sizeof(err), NULL, NULL);
        } else {
            snprintf(err, sizeof(err), "WebAuthN error 0x%08lX", (unsigned long)hr);
        }
        callback(NULL, err, 0, ctx);
    }
}

// ── Public C API ────────────────────────────────────────────────

int ellul_passkey_available(void) {
    if (!ensure_webauthn()) return 0;
    if (pfnIsAvailable) {
        BOOL available = FALSE;
        HRESULT hr = pfnIsAvailable(&available);
        if (SUCCEEDED(hr) && available) return 1;
    }
    return 1;
}

void ellul_passkey_authenticate(
    const unsigned char *challenge, size_t challenge_len,
    const char *rp_id,
    const char *allow_creds_json,
    const char *user_verification,
    EllulPasskeyCallback callback,
    void *ctx
) {
    if (!ensure_webauthn()) {
        callback(NULL, "WebAuthN API not available (Windows 10 1903+ required)", 0, ctx);
        return;
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) hwnd = GetDesktopWindow();

    WCHAR *rp_id_w = utf8_to_wide(rp_id);
    if (!rp_id_w) {
        callback(NULL, "Failed to convert RP ID", 0, ctx);
        return;
    }

    char *cdj = make_client_data_json("webauthn.get", challenge, challenge_len, rp_id);
    if (!cdj) {
        free(rp_id_w);
        callback(NULL, "Failed to construct clientDataJSON", 0, ctx);
        return;
    }

    WEBAUTHN_CLIENT_DATA clientData = {0};
    clientData.dwVersion = WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
    clientData.cbClientDataJSON = (DWORD)strlen(cdj);
    clientData.pbClientDataJSON = (PBYTE)cdj;
    clientData.pwszHashAlgId = WEBAUTHN_HASH_ALGORITHM_SHA_256;

    WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS opts = {0};
    opts.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION;
    opts.dwTimeoutMilliseconds = 120000;
    opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY;

    if (user_verification) {
        if (strcmp(user_verification, "required") == 0)
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        else if (strcmp(user_verification, "discouraged") == 0)
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_DISCOURAGED;
        else
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_PREFERRED;
    }

    DWORD cred_count = 0;
    WEBAUTHN_CREDENTIAL *creds = parse_allow_creds(allow_creds_json, &cred_count);
    if (creds && cred_count > 0) {
        opts.CredentialList.cCredentials = cred_count;
        opts.CredentialList.pCredentials = creds;
    }

    PWEBAUTHN_ASSERTION assertion = NULL;
    HRESULT hr = pfnGetAssertion(hwnd, rp_id_w, &clientData, &opts, &assertion);

    free(rp_id_w);
    free_allow_creds(creds, cred_count);

    if (FAILED(hr)) {
        free(cdj);
        report_error(hr, callback, ctx);
        return;
    }

    char *json = build_assertion_json(assertion, cdj, strlen(cdj));
    free(cdj);

    if (json) {
        callback(json, NULL, 0, ctx);
        free(json);
    } else {
        callback(NULL, "Failed to build assertion JSON", 0, ctx);
    }

    pfnFreeAssertion(assertion);
}

void ellul_passkey_register(
    const unsigned char *challenge, size_t challenge_len,
    const char *rp_id,
    const char *rp_name,
    const unsigned char *user_id, size_t user_id_len,
    const char *user_name,
    const char *user_display_name,
    const char *attestation,
    const char *user_verification,
    EllulPasskeyCallback callback,
    void *ctx
) {
    if (!ensure_webauthn()) {
        callback(NULL, "WebAuthN API not available (Windows 10 1903+ required)", 0, ctx);
        return;
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) hwnd = GetDesktopWindow();

    WCHAR *rp_id_w = utf8_to_wide(rp_id);
    WCHAR *rp_name_w = utf8_to_wide(rp_name ? rp_name : rp_id);
    WCHAR *user_name_w = utf8_to_wide(user_name);
    WCHAR *display_name_w = utf8_to_wide(user_display_name ? user_display_name : user_name);

    if (!rp_id_w || !rp_name_w || !user_name_w || !display_name_w) {
        free(rp_id_w); free(rp_name_w); free(user_name_w); free(display_name_w);
        callback(NULL, "Failed to convert strings to UTF-16", 0, ctx);
        return;
    }

    char *cdj = make_client_data_json("webauthn.create", challenge, challenge_len, rp_id);
    if (!cdj) {
        free(rp_id_w); free(rp_name_w); free(user_name_w); free(display_name_w);
        callback(NULL, "Failed to construct clientDataJSON", 0, ctx);
        return;
    }

    WEBAUTHN_RP_ENTITY_INFORMATION rpInfo = {0};
    rpInfo.dwVersion = WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION;
    rpInfo.pwszId = rp_id_w;
    rpInfo.pwszName = rp_name_w;

    WEBAUTHN_USER_ENTITY_INFORMATION userInfo = {0};
    userInfo.dwVersion = WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION;
    userInfo.cbId = (DWORD)user_id_len;
    userInfo.pbId = (PBYTE)user_id;
    userInfo.pwszName = user_name_w;
    userInfo.pwszDisplayName = display_name_w;

    WEBAUTHN_COSE_CREDENTIAL_PARAMETER coseParams[3] = {0};
    coseParams[0].dwVersion = WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION;
    coseParams[0].pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
    coseParams[0].lAlg = WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256;
    coseParams[1].dwVersion = WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION;
    coseParams[1].pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
    coseParams[1].lAlg = WEBAUTHN_COSE_ALGORITHM_RSASSA_PKCS1_V1_5_WITH_SHA256;
    coseParams[2].dwVersion = WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION;
    coseParams[2].pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
    coseParams[2].lAlg = -8; /* EdDSA / Ed25519 */

    WEBAUTHN_COSE_CREDENTIAL_PARAMETERS credParams = {0};
    credParams.cCredentialParameters = 3;
    credParams.pCredentialParameters = coseParams;

    WEBAUTHN_CLIENT_DATA clientData = {0};
    clientData.dwVersion = WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
    clientData.cbClientDataJSON = (DWORD)strlen(cdj);
    clientData.pbClientDataJSON = (PBYTE)cdj;
    clientData.pwszHashAlgId = WEBAUTHN_HASH_ALGORITHM_SHA_256;

    WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS opts = {0};
    opts.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION;
    opts.dwTimeoutMilliseconds = 120000;
    opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY;

    if (attestation) {
        if (strcmp(attestation, "direct") == 0)
            opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_DIRECT;
        else if (strcmp(attestation, "indirect") == 0)
            opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_INDIRECT;
        else
            opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE;
    }

    if (user_verification) {
        if (strcmp(user_verification, "required") == 0)
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        else if (strcmp(user_verification, "discouraged") == 0)
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_DISCOURAGED;
        else
            opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_PREFERRED;
    }

    PWEBAUTHN_CREDENTIAL_ATTESTATION pAttestation = NULL;
    HRESULT hr = pfnMakeCredential(hwnd, &rpInfo, &userInfo, &credParams,
                                    &clientData, &opts, &pAttestation);

    free(rp_id_w); free(rp_name_w); free(user_name_w); free(display_name_w);

    if (FAILED(hr)) {
        free(cdj);
        report_error(hr, callback, ctx);
        return;
    }

    char *json = build_attestation_json(pAttestation, cdj, strlen(cdj));
    free(cdj);

    if (json) {
        callback(json, NULL, 0, ctx);
        free(json);
    } else {
        callback(NULL, "Failed to build attestation JSON", 0, ctx);
    }

    pfnFreeAttestation(pAttestation);
}

void ellul_passkey_cancel(void) {
    /* Windows Hello dialog is modal and blocks the calling thread.
       User dismisses it directly; no programmatic cancel needed. */
}
