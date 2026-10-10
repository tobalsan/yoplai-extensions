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
