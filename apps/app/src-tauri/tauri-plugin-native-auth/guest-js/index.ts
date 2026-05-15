import { invoke } from "@tauri-apps/api/core";

export interface AppleSignInResult {
  identity_token: string;
  user_id: string;
  email: string | null;
  given_name: string | null;
  family_name: string | null;
}

export interface OAuthBrowserResult {
  callbackUrl: string;
}

/**
 * Trigger native Apple Sign In (iOS only).
 * Returns the identity token and user info for server-side verification.
 */
export async function signInApple(): Promise<AppleSignInResult> {
  return invoke<AppleSignInResult>("plugin:native-auth|sign_in_apple");
}

/**
 * Open system browser for OAuth (GitHub/Google).
 * On iOS: ASWebAuthenticationSession (returns callback URL)
 * On Android: Chrome Custom Tabs (deep link handles callback)
 * On desktop: Default browser
 */
export async function openOauthBrowser(
  url: string
): Promise<OAuthBrowserResult | void> {
  return invoke<OAuthBrowserResult | void>("plugin:native-auth|open_oauth_browser", { url });
}

export type HapticIntensity = "light" | "medium" | "heavy";

/**
 * Trigger haptic feedback on mobile devices.
 * On desktop, this is a no-op.
 *
 * @param intensity - The haptic intensity: "light", "medium", or "heavy"
 */
export async function hapticFeedback(
  intensity: HapticIntensity
): Promise<void> {
  return invoke<void>("plugin:native-auth|haptic_feedback", { intensity });
}

export interface PushTokenResult {
  token: string;
}

/**
 * Register for remote push notifications and get the device token.
 * iOS: Returns APNs device token (hex-encoded).
 * Android: Returns FCM registration token.
 * Desktop: Throws — desktop uses local notifications.
 */
export async function registerPush(): Promise<PushTokenResult> {
  return invoke<PushTokenResult>("plugin:native-auth|register_push");
}

/**
 * Copy text to the native clipboard.
 * @param text - The text to copy
 * @param label - Optional label for the clipboard entry (Android only)
 */
export async function copyToClipboard(
  text: string,
  label?: string
): Promise<void> {
  return invoke<void>("plugin:native-auth|copy_to_clipboard", { text, label });
}

export interface ShareOptions {
  text?: string;
  title?: string;
  url?: string;
}

/**
 * Open the native share sheet (mobile only).
 * On desktop, this will return an error.
 */
export async function share(options: ShareOptions): Promise<void> {
  return invoke<void>("plugin:native-auth|share", options);
}
