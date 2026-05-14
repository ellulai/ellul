// SPDX-License-Identifier: MIT
"use client";

import { createAuthClient } from "better-auth/client";
import { inferAdditionalFields } from "better-auth/client/plugins";

// Note: 2FA is handled by OAuth providers (GitHub/Google).
// Users can enable 2FA in their provider's security settings.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  // Required for cross-origin cookie handling (frontend <-> API on different subdomains)
  fetchOptions: {
    credentials: "include" as RequestCredentials,
  },
  // Mirrors the server-side `additionalFields` config (auth.ts) so the
  // typed session payload exposes user.preferredLocale to console code.
  // Adding a new user-identity field? Add it in auth.ts AND here.
  plugins: [
    inferAdditionalFields({
      user: {
        preferredLocale: { type: "string", required: false },
      },
    }),
  ],
});

// Export commonly used methods
export const { signIn, signOut, signUp, getSession } = authClient;

// Type exports
export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
