import { DRIVE_ABOUT_URL } from "./models.js";

export type DriveFetch = typeof fetch;

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
}

/**
 * Thin Google Drive client for the tracer bullet. It only knows how to hit the
 * Drive `about` endpoint to prove the injected access token is valid. Real read
 * tools (list/search/read/download) land in ALG-358.
 */
export class GoogleDriveClient {
  #accessToken: string;
  #fetch: DriveFetch;

  constructor(accessToken: string, fetchImpl: DriveFetch = fetch) {
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
  }

  async about(): Promise<DriveUser> {
    const response = await this.#fetch(DRIVE_ABOUT_URL, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Google Drive request failed (HTTP ${response.status})${
          body ? `: ${body.slice(0, 200)}` : ""
        }`
      );
    }
    const data = (await response.json().catch(() => ({}))) as {
      user?: DriveUser;
    };
    return data.user ?? {};
  }
}
