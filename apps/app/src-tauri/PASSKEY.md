# Native Passkey (WebAuthn) in the Tauri App

The ellul console uses ASAuthorizationController for native Touch ID passkey
registration and authentication on macOS. This bypasses WKWebView's lack of
`window.PublicKeyCredential` by calling Apple's platform API directly via ObjC FFI.

## Architecture

```
JS (EnableLockWizard.tsx)
  → invoke("plugin:shield|shield_native_credential_create", { optionsJson })
  → commands.rs  (parse WebAuthn options JSON)
  → passkey.rs   (Rust FFI bridge)
  → passkey.m    (ObjC: ASAuthorizationController + ASAuthorizationPlatformPublicKeyCredentialProvider)
  → macOS Touch ID prompt
  → credential JSON returned to JS
  → JS POSTs credential to VPS /_auth/upgrade-to-web-locked/verify
```

## Associated Domains (the hard part)

ASAuthorizationController **requires** the app to be registered with macOS's
System Web Credential Daemon (swcd) for `webcredentials:ellul.ai`. Without this,
every passkey ceremony fails with:

> Application with identifier MURSA66FDA.ai.ellul.console is not associated
> with domain ellul.ai (code 1004)

### What swcd needs

1. **AASA file** at `ellul.ai/.well-known/apple-app-site-association` listing
   `MURSA66FDA.ai.ellul.console` under `webcredentials.apps`
2. **Entitlements** with `com.apple.developer.associated-domains` containing
   `webcredentials:ellul.ai` (add `?mode=developer` for local dev)
3. **Provisioning profile** embedded in the .app bundle at
   `Contents/embedded.provisionprofile` — must include:
   - `com.apple.developer.associated-domains: *`
   - The device's Provisioning UDID in `ProvisionedDevices`
   - Valid developer certificate
4. **`get-task-allow` entitlement** — required for `?mode=developer` to work
5. **Developer mode** enabled: `sudo swcutil developer-mode -e YES`
6. **Local override file** at `~/Library/Developer/AssociatedDomains/ai.ellul.console`
   containing `webcredentials:ellul.ai?mode=developer`

### Critical: the .app bundle must be launched

**swcd only discovers apps through `.app` bundle launches.** Running the bare
binary via `cargo tauri dev` does NOT register with swcd. You must:

```bash
# Build the debug bundle
cargo tauri build --debug

# Copy to /Applications (swcd trusts this location)
rm -rf /Applications/ellul.app
cp -R target/debug/bundle/macos/ellul.app /Applications/ellul.app

# Force LaunchServices registration
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/ellul.app

# Reset swcd and launch
sudo swcutil reset
open /Applications/ellul.app
```

Verify registration:
```bash
sudo swcutil show | grep -A5 MURSA
# Should show:
# Service:              webcredentials
# App ID:               MURSA66FDA.ai.ellul.console
# Domain:               ellul.ai?mode=developer
# Site/Fmwk Approval:   approved
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| swcutil show has no MURSA entries | App never launched as .app bundle | Copy to /Applications, `open` it |
| "not associated with domain" (1004) | swcd not registered | Full reset sequence above |
| "Passkeys do not support attestation" (1004) | attestation preference set | Ensure `None` is passed for attestation in commands.rs |
| "calling process has no app identifier" (1004) | Running bare binary, not .app | Must run from the signed .app bundle |
| LaunchServices shows `launch-disabled` | Stale entries from DMG builds | `lsregister -f /Applications/ellul.app` |

### Developer mode local override file

Create `~/Library/Developer/AssociatedDomains/ai.ellul.console`:
```
webcredentials:ellul.ai?mode=developer
```

Also create `~/Library/Developer/AssociatedDomains/MURSA66FDA.ai.ellul.console`
with the same content (macOS checks both formats).

## Key Files

| File | Purpose |
|------|---------|
| `Entitlements.plist` | Associated domains + get-task-allow + keychain |
| `tauri-plugin-shield/objc/passkey.m` | ObjC ASAuthorizationController implementation |
| `tauri-plugin-shield/src/passkey.rs` | Rust FFI bridge to ObjC |
| `tauri-plugin-shield/src/commands.rs` | Tauri command parsing WebAuthn options JSON |
| `ellul_console_dev.provisionprofile` | Dev provisioning profile (embed in bundle) |

## Production Notes

- Remove `?mode=developer` from `Entitlements.plist` — production relies on
  Apple's CDN AASA verification, not local override
- Remove `com.apple.security.get-task-allow` — only needed for dev mode
- Attestation must stay `None` — platform passkeys don't support it
- The `PublicKeyCredential` polyfill in `lib.rs` init script is still needed
  since WKWebView doesn't expose the real API
