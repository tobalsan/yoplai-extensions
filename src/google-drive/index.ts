import { defineToolExtension } from "../tool-extension.js";
import { GoogleDriveClient } from "./client.js";
import {
  GoogleDriveConfigSchema,
  ValidateParamsSchema,
} from "./models.js";

/**
 * googleDrive tracer-bullet extension. It declares a single `oauth` requirement
 * for Google Drive and exposes one `validate` tool that returns green when the
 * host has injected a fresh access token. No API key is configured here — the
 * token arrives via `config.oauth` at tool-build time.
 */
export default defineToolExtension({
  id: "googleDrive",
  displayName: "Google Drive",
  description:
    "Google Drive access via per-agent OAuth. Currently exposes a single validate tool that confirms the Drive connection is live.",
  systemPrompt: `Use googleDrive_validate to confirm the agent's Google Drive connection is working. If it reports not connected, tell the user to click "Connect Google Drive" in settings — do not attempt to guess or supply credentials.`,
  configSchema: GoogleDriveConfigSchema,
  requiredSecrets: [],
  oauth: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  createTools(config) {
    const oauth = config.oauth;

    return [
      {
        name: "validate",
        description:
          "Validate the Google Drive connection. Returns connected + the Google account when a fresh token is available, or a clear not-connected signal otherwise.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);

          if (!oauth || !oauth.connected) {
            // Documented not-connected signal — never a raw 401.
            return {
              connected: false,
              provider: "google",
              reason: oauth?.reason ?? "not_connected",
              message:
                oauth?.message ??
                "Google Drive is not connected. Click Connect Google Drive in settings.",
              authorizeUrl: oauth && "authorizeUrl" in oauth ? oauth.authorizeUrl : undefined,
            };
          }

          const client = new GoogleDriveClient(oauth.accessToken);
          const user = await client.about();
          return {
            connected: true,
            provider: "google",
            account: user.emailAddress ?? oauth.account,
            displayName: user.displayName,
            scopes: oauth.scopes,
          };
        },
      },
    ];
  },
});
