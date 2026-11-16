# Changelog

## [0.1.3] - 2026-11-16

- Fix: `require('@crontinel/node')` failed because `exports.require` pointed at a missing `dist/index.cjs`.
- Fix: `import Crontinel from '@crontinel/node'` gave the module object instead of the class (`Crontinel is not a constructor`). An ESM entry now re-exports the class as the default and named export.
- Tests are no longer compiled into `dist/`.

## v0.1.0 (2026-04-13)

First public release.

### Added
- `Crontinel` Node.js SDK for monitoring cron, queue, and job events
- `monitorSchedule` helper to wrap async cron job functions
- Framework integrations: `node-cron`, BullMQ
- TypeScript types included
- MIT license
