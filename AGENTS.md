# AGENTS.md - Yoplai Tool Extensions

## Project

This repo contains standalone Yoplai tool extensions: self-contained agent tool packages that call external APIs. Each extension is a directory under `src/` that exports an Yoplai `Extension` via the local `defineToolExtension()` helper.

## Extension Contract

See the authoritative Yoplai unified extension model in your platform workspace's `docs/llms.md` and `docs/extensions.md`. The former reference path `/Users/agents/code/algodyn/yoplai/platform/docs/llms.md` may be stale. Do not copy that large host-runtime document into this repository; keep extension-specific guidance local.

Key points:
- Each tool extension exports a default extension object from its `index.ts`
- Tool `parameters` must be `z.object({})`
- Declare a Zod `outputSchema` next to `parameters` for data tools; reuse existing result models. Hosts convert it without refs and provide a JSON-safe copy of the raw result as `structuredContent`, alongside unchanged text and details. Codemode resolves to that object; schemas describe success and are not enforced on results.
- Connection/reconnection refusals carry top-level `isError: true`. Hosts apply the Pi error flag only for exact `isError === true` on tools declaring `outputSchema`; legacy tools keep their existing behavior.
- Root `extensions.<id>` holds shared defaults; `agents[].extensions.<id>` opts an agent in unless `enabled: false`
- Yoplai prefixes tool names with the extension id for model-facing tools
- Secrets are configured with `$env:NAME` refs in Yoplai config

## Build & Test

```bash
pnpm install
pnpm build
pnpm test
```

## Release and catalog

Add `src/<folder>/extension.json` for each new extension. Use these fields:

| Field | Value |
| --- | --- |
| `version` | The extension version, in `major.minor.patch` format. |
| `tagline` | A short summary of what the extension does. |
| `category` | One of `communication`, `productivity`, `sales`, `support`, `data`, `search`, `finance`, or `developer`. |
| `minYoplai` | The earliest Yoplai version that supports the extension. |
| `docsUrl` | Optional. The default points to the source folder on `main`. |
| `catalog` | Optional. Set it to `false` to omit the extension from the catalog. The release still includes its archive. |

The release script uses the exported `id`, `displayName`, and `description`.
The script rejects duplicate IDs, including IDs that differ only in case.
Increase `version` for every change that users can see.

Each push to `main`, including a merge, starts the release workflow. The
workflow publishes a release if the build and tests pass.

Before you open a pull request, run these commands from the repository root:

```bash
node scripts/release.mjs
node scripts/release-smoke.mjs
```

The first command replaces `release/`. Neither command publishes a release.

## Conventions

- TypeScript with strict mode
- Zod for all schemas (config, tool params, API models)
- Each extension is self-contained in its `src/<name>/` directory
- Port Python Pydantic models to Zod schemas (camelCase field names)
- Respect HiveAge API rate limits (retry on 429)
