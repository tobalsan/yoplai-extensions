import { z } from "zod";

/**
 * googleDrive config is intentionally minimal for the tracer bullet: no API key
 * lives here — the access token is injected by the host at tool-build time via
 * the OAuth requirement. Config only carries the enable flag (handled by the
 * base schema) so this is an empty object.
 */
export const GoogleDriveConfigSchema = z.object({}).passthrough();
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>;

export const ValidateParamsSchema = z.object({}).strict();
export type ValidateParams = z.infer<typeof ValidateParamsSchema>;

/** Google Drive `about` endpoint used to prove the token works end-to-end. */
export const DRIVE_ABOUT_URL =
  "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)";
