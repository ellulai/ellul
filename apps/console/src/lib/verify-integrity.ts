// SPDX-License-Identifier: MIT

// Trust-Verify Architecture - Frontend Verification Utility

// Hash a string using SHA-256 via Web Crypto API.
export async function sha256Hash(data: string): Promise<string> {
  // Encode string to UTF-8 bytes
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // Hash using Web Crypto API
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return hashHex;
}

// Verification result type
export interface VerificationResult {
  // Whether the hashes match
  verified: boolean;
  // Browser-computed hash of the config
  browserHash: string;
  // Hash from API (computed at provisioning time)
  apiHash: string;
  // Detailed message for display
  message: string;
  // Timestamp of verification
  verifiedAt: string;
}

// Verify server configuration integrity.
export async function verifyServerIntegrity(
  serverConfig: string,
  serverHash: string
): Promise<VerificationResult> {
  // Compute hash in browser
  const browserHash = await sha256Hash(serverConfig);

  // Compare hashes (case-insensitive)
  const verified =
    browserHash.toLowerCase() === serverHash.toLowerCase();

  // Build result
  const result: VerificationResult = {
    verified,
    browserHash,
    apiHash: serverHash,
    message: verified
      ? "✓ Integrity verified: Browser hash matches API hash"
      : "✗ Integrity mismatch: Browser hash does not match API hash",
    verifiedAt: new Date().toISOString(),
  };

  return result;
}

// Full verification flow including fetching config from API.
export async function fetchAndVerifyServer(
  serverId: string,
  apiUrl: string
): Promise<{
  success: boolean;
  result?: VerificationResult;
  config?: string;
  error?: string;
}> {
  try {
    // Fetch config from API
    const response = await fetch(`${apiUrl}/api/servers/${serverId}/config`, {
      credentials: "include",
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: (errorData as { error?: string }).error || `HTTP ${response.status}`,
      };
    }

    const data = await response.json();

    if (!data.cloudInitYaml || !data.cloudInitHash) {
      return {
        success: false,
        error: "Server config not available (may still be provisioning)",
      };
    }

    // Verify integrity
    const result = await verifyServerIntegrity(
      data.cloudInitYaml,
      data.cloudInitHash
    );

    return {
      success: true,
      result,
      config: data.cloudInitYaml,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Format hash for display (truncate middle for readability).
export function formatHash(hash: string, length = 16): string {
  if (hash.length <= length * 2) {
    return hash;
  }
  return `${hash.slice(0, length)}...${hash.slice(-length)}`;
}

// Copy text to clipboard.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
