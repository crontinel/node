# @crontinel/node

Crontinel monitoring SDK for Node.js applications. Send cron, queue, and job monitoring events from any Node.js app — standalone or alongside the `crontinel/laravel` PHP package.

## Install

```bash
npm install @crontinel/node
# or
yarn add @crontinel/node
# or
pnpm add @crontinel/node
```

## Requirements

- Node.js 18+

## Quick Start

```typescript
import Crontinel from '@crontinel/node';

const crontinel = new Crontinel({
  apiKey: process.env.CRONTINEL_API_KEY!,
  apiUrl: process.env.CRONTINEL_API_URL,   // defaults to https://app.crontinel.com
  appName: 'my-service',                   // optional, default: 'node'
});

// Report a cron job run
await crontinel.scheduleRun({
  command: 'reports:generate',
  duration_ms: 2340,
  exit_code: 0,   // 0 = success, 1 = failure
});

// Report queue worker activity
await crontinel.queueProcessed({
  queue: 'emails',
  processed: 12,
  failed: 0,
  duration_ms: 8901,
});

// Send a custom event or alert
await crontinel.event({
  key: 'disk-space-warning',
  message: 'Disk usage above 90%',
  state: 'firing',
});
```

## `monitorSchedule` helper

Wrap any async function and automatically report its outcome:

```typescript
const reports = await crontinel.monitorSchedule('reports:generate', async () => {
  // your cron job logic
  await sendDailyReports();
  return { sent: 142, failed: 0 }; // return value is preserved
});
// { result: { sent: 142, failed: 0 }, duration_ms: 1840, exit_code: 0 }
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CRONTINEL_API_KEY` | — | Your Crontinel API key (required) |
| `CRONTINEL_API_URL` | `https://app.crontinel.com` | Crontinel SaaS or self-hosted endpoint |

## Framework integrations

### Node-cron

```typescript
import cron from 'node-cron';
import Crontinel from '@crontinel/node';

const crontinel = new Crontinel({ apiKey: process.env.CRONTINEL_API_KEY! });

cron.schedule('0 9 * * *', () => {
  crontinel.monitorSchedule('daily-reports', async () => {
    await sendMorningReports();
  });
});
```

### BullMQ

```typescript
import { Worker } from 'bullmq';
import Crontinel from '@crontinel/node';

const crontinel = new Crontinel({ apiKey: process.env.CRONTINEL_API_KEY! });

const worker = new Worker('emails', async (job) => {
  await processEmail(job.data);
}, { connection: redisConnection });

worker.on('completed', async (job) => {
  await crontinel.queueProcessed({
    queue: 'emails',
    processed: 1,
    failed: 0,
    duration_ms: job.processingTime,
  });
});

worker.on('failed', async (job, err) => {
  await crontinel.queueProcessed({
    queue: 'emails',
    processed: 0,
    failed: 1,
  });
});
```

## License

MIT
