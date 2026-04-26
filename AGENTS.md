# AGENTS.md - AIHub Tool Extensions

## Project

This repo contains standalone AIHub tool extensions: self-contained agent tool packages that call external APIs. Each extension is a directory under `src/` that exports an AIHub `Extension` via the local `defineToolExtension()` helper.

## Extension Contract

See the AIHub unified extension model in `/Users/thinh/code/aihub/docs/llms.md`.

Key points:
- Each tool extension exports a default extension object from its `index.ts`
- Tool `parameters` must be `z.object({})`
- Root `extensions.<id>` holds shared defaults; `agents[].extensions.<id>` opts an agent in unless `enabled: false`
- AIHub prefixes tool names with the extension id for model-facing tools
- Secrets are configured with `$env:NAME` refs in AIHub config

## Build & Test

```bash
pnpm install
pnpm build
pnpm test
```

## Conventions

- TypeScript with strict mode
- Zod for all schemas (config, tool params, API models)
- Each extension is self-contained in its `src/<name>/` directory
- Port Python Pydantic models to Zod schemas (camelCase field names)
- Respect HiveAge API rate limits (retry on 429)
