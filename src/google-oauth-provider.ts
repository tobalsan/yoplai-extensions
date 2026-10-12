import type { OAuthProviderDescriptor } from "./tool-extension.js";

/** Google OAuth descriptor, shared by every Google extension. */
export const googleOAuthProvider: OAuthProviderDescriptor = {
  id: "google",
  displayName: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  defaultScopes: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  authorizeParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
  extractAccount(userInfo) {
    if (
      userInfo &&
      typeof userInfo === "object" &&
      "email" in userInfo &&
      typeof (userInfo as { email?: unknown }).email === "string"
    ) {
      return (userInfo as { email: string }).email;
    }
    return undefined;
  },
};

const RATE_LIMIT_PATTERN = /rate.?limit|quota|daily.?limit/i;

/**
 * Maps a Google API failure to a reconnect/retry reason; undefined when the
 * status isn't an auth or throttling failure. `rateLimitPattern` lets a caller
 * recognise extra 403 throttling markers.
 */
export function googleFailureReason(
  status: number,
  body: string,
  rateLimitPattern: RegExp = RATE_LIMIT_PATTERN
): "expired" | "rate_limited" | "insufficient_scope" | undefined {
  if (status === 401) return "expired";
  if (status === 429) return "rate_limited";
  if (status === 403) return rateLimitPattern.test(body) ? "rate_limited" : "insufficient_scope";
  return undefined;
}
