// SPDX-License-Identifier: MIT

// Salt is computed client-side from the label for domain separation across
// purposes (vault, operator, …). The server used to send prfSalt for the vault
// case — identical to SHA-256("ellul-luks-vault-v1"), so ignoring it preserves
// behavior.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function derivePrfKey(saltLabel: string): Promise<Uint8Array> {
  const saltBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(saltLabel)),
  );

  const options = await fetchAuthOptions();

  const allowCredentials = (
    options.allowCredentials as Array<{ id: string; transports?: string[] }> | undefined
  )?.map((cred) => ({
    id: base64URLToBuffer(cred.id),
    type: "public-key" as const,
    transports: cred.transports as AuthenticatorTransport[] | undefined,
  }));

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64URLToBuffer(options.challenge as string),
      rpId: options.rpId as string | undefined,
      allowCredentials,
      userVerification:
        (options.userVerification as UserVerificationRequirement) || "required",
      timeout: (options.timeout as number) || 60_000,
      extensions: { prf: { eval: { first: saltBytes } } },
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Authentication cancelled");
  }

  const extensions = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };

  const prfResult = extensions?.prf?.results?.first;
  if (!prfResult) {
    throw new Error(
      "PRF extension did not return a result. Your authenticator may not support PRF.",
    );
  }

  const bytes = new Uint8Array(prfResult);
  if (bytes.length !== 32) {
    throw new Error(`Unexpected PRF key length: ${bytes.length} (expected 32)`);
  }

  return bytes;
}

async function fetchAuthOptions(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}/api/servers/encryption/authenticate/options`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function base64URLToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
