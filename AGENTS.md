# AGENTS.md — AIHub Connectors

## Project

This repo contains standalone AIHub connectors — self-contained agent tool packages that call external APIs. Each connector is a directory under `src/` that exports a `ConnectorDefinition`.

## Connector Contract

See `/Users/thinh/code/aihub/docs/connectors.md` for the full contract documentation.

Key points:
- Each connector exports a default `ConnectorDefinition` from its `index.ts`
- Tool `parameters` must be `z.object({})` — both Claude and Pi adapters require it
- Tools are auto-namespaced: `connector_id.tool_name`
- Secrets are managed via OneCLI Agent Vault (`$secret:name` refs in config, resolved by AIHub at startup)

## Build & Test

```bash
npm install
npm run build
npm test
```

## Conventions

- TypeScript with strict mode
- Zod for all schemas (config, tool params, API models)
- Each connector is self-contained in its `src/<name>/` directory
- Port Python Pydantic models to Zod schemas (camelCase field names)
- Respect HiveAge API rate limits (retry on 429)
