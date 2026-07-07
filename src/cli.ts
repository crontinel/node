#!/usr/bin/env node

/**
 * Crontinel Node Agent — CLI entry point.
 *
 * Usage:
 *   npx crontinel agent                    Start the agent daemon
 *   npx crontinel agent --systemd          Print systemd unit file
 *   npx crontinel agent --help             Print usage
 */

import { hostname } from 'node:os';
import { AgentDaemon } from './AgentDaemon.js';

function printUsage(): void {
  console.log('Crontinel Node Agent');
  console.log('');
  console.log('Usage:');
  console.log('  npx crontinel agent                    Start the agent daemon');
  console.log('  npx crontinel agent --systemd          Generate systemd unit file');
  console.log('  npx crontinel agent --help             Show this help');
  console.log('');
  console.log('Environment:');
  console.log('  CRONTINEL_API_KEY     Required. Your Crontinel API key.');
  console.log('  CRONTINEL_APP_ID      Required. Your app slug or numeric ID.');
  console.log('  CRONTINEL_API_URL     Optional. Default: https://app.crontinel.com');
  console.log('  CRONTINEL_AGENT_ID    Optional. Default: hostname');
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  if (args[0] === 'agent' && args[1] === '--systemd') {
    AgentDaemon.printSystemdConfig();
    process.exit(0);
  }

  if (args[0] !== 'agent') {
    console.error(`Unknown command: ${args[0]}`);
    printUsage();
    process.exit(1);
  }

  // ── Validate environment ───────────────────────────────────────────
  const apiKey = process.env.CRONTINEL_API_KEY;
  const appId = process.env.CRONTINEL_APP_ID;

  if (!apiKey) {
    console.error('');
    console.error('Error: CRONTINEL_API_KEY is required.');
    console.error('');
    console.error('  export CRONTINEL_API_KEY=your-api-key');
    console.error('  export CRONTINEL_APP_ID=your-app-slug');
    console.error('');
    process.exit(1);
  }

  if (!appId) {
    console.error('');
    console.error('Error: CRONTINEL_APP_ID is required.');
    console.error('');
    console.error('  export CRONTINEL_APP_ID=your-app-slug');
    console.error('  (found in app.crontinel.com → Settings → App slug)');
    console.error('');
    process.exit(1);
  }

  // ── Start the daemon ───────────────────────────────────────────────
  const agentId = process.env.CRONTINEL_AGENT_ID || hostname();
  const agentName = `node-agent:${agentId}`;

  const daemon = new AgentDaemon({
    apiKey,
    apiUrl: process.env.CRONTINEL_API_URL || 'https://app.crontinel.com',
    appId,
    agentId: process.env.CRONTINEL_AGENT_ID,
    agentName,
  });

  daemon.setOutputWriter((msg: string) => console.log(msg));

  process.on('SIGINT', () => { /* daemon handles it */ });
  process.on('SIGTERM', () => { /* daemon handles it */ });

  await daemon.run();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
