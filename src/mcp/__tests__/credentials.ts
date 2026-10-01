import type { CredentialKey, ScopedCredentials } from "../oauth.js";

export function credentials(): ScopedCredentials {
  const entries = new Map<string, unknown>();
  const key = (value: CredentialKey) => JSON.stringify(value);
  return {
    get<T>(value: CredentialKey) { return entries.get(key(value)) as T | undefined; },
    save<T>(value: CredentialKey, payload: T) { entries.set(key(value), payload); return payload; },
    delete(value) { entries.delete(key(value)); },
    resolve<T>(request: { agentId: string; integration: string; requesterUserId?: string; connectUrl: string }) {
      const scopes = request.requesterUserId
        ? [{ type: "personal" as const, userId: request.requesterUserId }, { type: "team" as const }]
        : [{ type: "team" as const }];
      for (const scope of scopes) {
        const payload = entries.get(key({ agentId: request.agentId, integration: request.integration, scope })) as T | undefined;
        if (payload) return { connected: true as const, payload, scope };
      }
      return { connected: false as const, reason: "not_connected" as const, connectUrl: request.connectUrl };
    },
  };
}
