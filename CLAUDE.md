# @crontinel/node — CLAUDE.md

Node.js SDK for Crontinel cron and queue monitoring.

## Package
- npm: `@crontinel/node`
- GitHub: `github.com/crontinel/node`
- Publish: `npm publish --access public` (CI auto-publishes on git tag push)

## Stack
- TypeScript, Vitest, tsx for tests
- `output: 'standalone'` not needed (library)

## Key files
- `src/index.ts` — main SDK
- `src/index.test.ts` — tests
- `package.json` — exports, bin, scripts
- `dist/` — compiled output (generated on build)

## Commands
```bash
npm install
npm test          # Vitest tests
npm run typecheck # tsc --noEmit
npm run build     # tsc
```

## Publish
```bash
npm version patch  # bump version
git push origin v<x.y.z>  # push tag → CI publishes
```

## Env vars (for testing)
- `CRONTINEL_API_KEY` — test API key
- `CRONTINEL_API_URL` — test endpoint (default: https://app.crontinel.com)
