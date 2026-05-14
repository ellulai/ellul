# ZeroClaw Vision

## 1. The Core Vision

ZeroClaw is a platform that transforms old or spare Android phones and Raspberry Pis into a Private AI VPS.

**The "Drawer Phone" Advantage:** It's faster than a Raspberry Pi, uses 10x less idle power, and has a built-in UPS (the battery).

**The "Privacy" Pitch:** Your files and SSH keys stay on your hardware. AI agents run locally via proot or Docker.

## 2. Strategic Architecture

We are moving to a Workspace/Crate model to support both Android and Headless Linux (Raspberry Pi):

- **crates/zeroclaw_core:** The "Brain." Contains Agent logic, Tunnel management, and Auth.
- **apps/android:** The "Remote Control" & "Local Server." A Tauri v2 app.
- **apps/server:** The "Headless Node." A Rust CLI that runs on Raspberry Pis or "Drawer Phones."
- **apps/api:** The "Control Plane." Handles $5/mo subscriptions, Cloud Builds, and Tunnel routing.

## 3. The Monetization Strategy ($5/mo Pro Tier)

The app is free for local use, but users pay for "Connectivity and Power":

- **Global Tunneling:** Public URLs (steve.ellul.ai) via Rathole to access the phone/Pi from anywhere.
- **Cloud APK Builds:** Offloading heavy Android compilation to your servers to save phone battery.
- **Pro Notifications:** Real-time background alerts when agents finish tasks or servers crash.
- **Device Fleet Management:** Managing multiple nodes (3 phones + 1 Pi) from one dashboard.

## 4. Critical Technical Implementation

### Android System "Hard" Fixes

- **W^X Workaround:** Renaming binaries to `libproot.so` and `librathole.so` and placing them in `jniLibs` to bypass Android 10+ execution restrictions.
- **Foreground Service:** Using `ZeroClawService.kt` with a `PARTIAL_WAKE_LOCK` to prevent the OS from killing the server when the screen is off.
- **JNI Class Caching:** Storing a global reference to the Kotlin service class to allow background Rust threads (like the supervisor) to fire notifications.

### Security & Sandboxing

- **Multi-Proot Jailing:** For the "Agent Marketplace," every community app runs in its own isolated proot instance with limited folder bindings (Home Assistant style).
- **Identity (Weblock/POP):** Using Passkeys (WebAuthn) and Proof of Possession (POP). Your phone's biometric sensor (fingerprint) is the "Key" to your Raspberry Pi. No passwords or `id_rsa` files needed.

## 5. Platform Features

- **Agent Marketplace:** A store where users can "One-Click Install" Node/Python agents (e.g., Stock Trackers, Home Automation, Discord Bots).
- **Unified Dashboard:** Replaces the "Projects" landing page. It shows "VPS Health" (CPU, RAM, Battery, Tunnel Status) and a list of all your active Nodes (Phones/Pis).
- **Share Intent:** Highlight a URL in Chrome -> Share to ZeroClaw -> Agent automatically summarizes or analyzes it.

## 6. The Execution Roadmap

### Phase 1: The "Engine" (W^X & Tunneling)
- Implement the `lib*.so` binary hack.
- Set up the Rathole tunnel manager with the $5/mo API gate.

### Phase 2: The "Identity" (Passkeys & Auth)
- Build the Device Flow login.
- Implement WebAuthn/Passkey registration for secure "POP" access.

### Phase 3: The "Platform" (Marketplace & Supervisor)
- Build the `process_supervisor.rs` to keep web apps alive.
- Launch the "Agent Marketplace" with a few official verified apps.

### Phase 4: The "Expansion" (Raspberry Pi)
- Release the Headless CLI for Linux.
- Add the "Node Switcher" to the Android Dashboard.
