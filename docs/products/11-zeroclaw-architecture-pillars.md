# ZeroClaw Architecture Pillars

Technical deep-dive into the four pillars required for AWS-grade production infrastructure.

## 1. The Multi-Tenant Network (Rathole + Caddy + Cloudflare)

To scale to thousands of users, you cannot manually configure your VPS. You need a **Dynamic Edge Proxy**.

- **The VPS Setup:** Run a single rathole server and a Caddy instance.
- **The Orchestration:** Use Cloudflare Workers as your "Front Door."
  - **Worker Logic:** When a request hits `user1.zeroclaw.app`, the Worker queries Cloudflare KV to check if `user1` has a Pro subscription.
  - **Dynamic Upstreams:** Caddy on your VPS should use the `on_demand_tls` feature. When it sees a new subdomain, it asks your API: "Is this a valid ZeroClaw user?" If yes, it issues a Let's Encrypt cert and proxies the request to the specific Rathole port for that user.
  - **Safety:** The Worker can enforce Rate Limiting and WAF (Web Application Firewall) rules at the edge, so malicious traffic never even reaches the user's phone.

## 2. The Identity Layer (WebAuthn & POP)

Passwords are a liability. Your "AWS-grade" identity uses **Hardware-Backed Passkeys**.

- **The "Controller" (Phone):** Uses the Android Credential Manager to generate a WebAuthn Passkey. The private key is locked in the phone's Titan M2 (or equivalent) secure chip.
- **The "Satellite" (Pi/Drawer Phone):** During setup, the satellite receives the Public Key.
- **Proof of Possession (POP):** When you try to access the Pi from your app:
  1. The Pi sends a random Challenge (nonce).
  2. The App asks for your fingerprint.
  3. The Secure Enclave signs the challenge.
  4. The Pi verifies the signature.
- **Result:** Even if your rathole token is stolen, a hacker cannot access the Pi because they don't have your physical phone to provide the biometric signature.

## 3. The "Hardened" Android Engine (W^X Fix)

Android 10+ is designed to stop people from doing exactly what you're doing. To bypass the W^X (Write XOR Execute) restriction, you must use the **Native Library Hack**.

1. **Packaging:** Move `rathole` and `proot` binaries into `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/`.
2. **Renaming:** Rename them to `librathole.so` and `libproot.so`. Android treats these as "system libraries."
3. **Gradle Config:** Set `useLegacyPackaging = true` in your `build.gradle`. This forces Android to extract these "libraries" to a special `/data/app/.../lib/arm64/` folder that is marked Executable.
4. **Rust Pathing:** Use JNI to query `Context.getApplicationInfo().nativeLibraryDir`. This is where your binaries live. You can now spawn them without a Permission Denied error.

## 4. The Agent Sandbox (Secure PRoot Jailing)

To make a marketplace safe, you must treat every community app as a potential virus.

- **Filesystem Virtualization:** Do not give agents access to the whole rootfs.
- **Jail Strategy:** Use proot bind-mounts to create an Isolated Workspace:

```bash
# Only bind what the app needs
proot -r /path/to/base_rootfs \
      -b /path/to/app_vols/bitcoin_tracker:/app \
      -b /dev -b /proc -b /sys \
      /usr/bin/node /app/index.js
```

- **User-Space Firewall:** Use `LD_PRELOAD` hacks or seccomp filters (if possible) to prevent community apps from opening network sockets unless the user has granted the "Internet" permission in your UI.

## AWS Equivalence Summary

| Component | AWS Equivalent | ZeroClaw Implementation |
|-----------|---------------|------------------------|
| Compute | EC2 / Lambda | Drawer Phone / Pi via proot or Docker |
| Networking | AWS PrivateLink / VPC | Rathole encrypted tunnels |
| Identity | IAM / Cognito | WebAuthn Passkeys + JNI Biometrics |
| Routing | Route 53 + ALB | Cloudflare Workers + Caddy on VPS |
| Security | AWS GuardDuty | Agentic Audit: local AI scans community code before install |
