import Tauri

class ShieldPlugin: Plugin {
    // iOS secure storage is handled by the Rust `keyring` crate which uses
    // Apple's Security.framework (Keychain Services) directly. No native
    // Swift code needed — this file satisfies the Tauri iOS build requirement.
}
