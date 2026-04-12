/**
 * Crontinel Node.js SDK
 * Report cron, queue, and job monitoring events from any Node.js application.
 *
 * @example
 * import Crontinel from '@crontinel/node'
 *
 * const crontinel = new Crontinel({
 *   apiKey: process.env.CRONTINEL_API_KEY,
 *   apiUrl: process.env.CRONTINEL_API_URL ?? 'https://app.crontinel.com',
 * })
 *
 * // In your Laravel-style scheduler:
 * await crontinel.scheduleRun({ command: 'reports:generate', duration_ms: 2340, exit_code: 0 })
 *
 * // After a queue worker processes jobs:
 * await crontinel.queueProcessed({ queue: 'emails', processed: 12, failed: 0, duration_ms: 8901 })
 */

export interface CrontinelConfig {
  apiKey: string;
  apiUrl?: string;
  appName?: string;
  agent?: string;
}

export interface ScheduleRunOptions {
  command: string;
  duration_ms?: number;
  exit_code?: number;
  ranAt?: Date;
}

export interface QueueProcessedOptions {
  queue: string;
  processed?: number;
  failed?: number;
  duration_ms?: number;
  ranAt?: Date;
}

export interface HorizonSnapshotOptions {
  supervisors: Record<string, { status: 'running' | 'paused' | 'stopped' }>;
  failedJobsPerMinute?: number;
  paused?: boolean;
  ranAt?: Date;
}

export interface CustomEventOptions {
  key: string;
  message: string;
  state?: 'firing' | 'resolved' | 'info';
  metadata?: Record<string, unknown>;
  ranAt?: Date;
}

const DEFAULT_API_URL = 'https://app.crontinel.com';

export class Crontinel {
  private apiKey: string;
  private apiUrl: string;
  private appName: string;
  private agent: string;

  constructor(config: CrontinelConfig) {
    if (!config.apiKey) {
      throw new Error('Crontinel: apiKey is required');
    }
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    this.appName = config.appName ?? 'node';
    this.agent = config.agent ?? `crontinel-node:${require('../package.json').version}`;
  }

  /**
   * Send a JSON-RPC 2.0 request to the Crontinel API.
   */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiUrl.replace(/\/$/, '')}/api/mcp`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': this.agent,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Crontinel API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { result?: unknown; error?: { message: string } };

    if (data.error) {
      throw new Error(`Crontinel RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Report a scheduled command run.
   * Call this after `php artisan schedule:run` completes (or your Node equivalent).
   *
   * @example
   * await crontinel.scheduleRun({ command: 'send-daily-reports', duration_ms: 1840, exit_code: 0 })
   */
  async scheduleRun(options: ScheduleRunOptions): Promise<void> {
    await this.request('notify/schedule_run', {
      command: options.command,
      duration_ms: options.duration_ms,
      exit_code: options.exit_code ?? 0,
      ran_at: (options.ranAt ?? new Date()).toISOString(),
      app: this.appName,
    });
  }

  /**
   * Report queue worker activity.
   * Call this after your queue worker processes a batch of jobs.
   *
   * @example
   * await crontinel.queueProcessed({ queue: 'emails', processed: 5, failed: 1, duration_ms: 2340 })
   */
  async queueProcessed(options: QueueProcessedOptions): Promise<void> {
    await this.request('notify/queue_processed', {
      queue: options.queue,
      processed: options.processed ?? 0,
      failed: options.failed ?? 0,
      duration_ms: options.duration_ms,
      ran_at: (options.ranAt ?? new Date()).toISOString(),
      app: this.appName,
    });
  }

  /**
   * Report Laravel Horizon snapshot.
   * Call this periodically (e.g. every 30s) if you run Horizon.
   *
   * @example
   * await crontinel.horizonSnapshot({
   *   supervisors: { 'emails-worker': { status: 'running' }, 'reports-worker': { status: 'paused' } },
   *   failedJobsPerMinute: 0.2,
   *   paused: false,
   * })
   */
  async horizonSnapshot(options: HorizonSnapshotOptions): Promise<void> {
    await this.request('notify/horizon_snapshot', {
      supervisors: options.supervisors,
      failed_jobs_per_minute: options.failedJobsPerMinute ?? 0,
      paused: options.paused ?? false,
      ran_at: (options.ranAt ?? new Date()).toISOString(),
      app: this.appName,
    });
  }

  /**
   * Send a custom alert or informational event.
   *
   * @example
   * await crontinel.event({ key: 'disk-space-warning', message: 'Disk usage above 90%', state: 'firing' })
   */
  async event(options: CustomEventOptions): Promise<void> {
    await this.request('notify/event', {
      key: options.key,
      message: options.message,
      state: options.state ?? 'info',
      metadata: options.metadata ?? {},
      ran_at: (options.ranAt ?? new Date()).toISOString(),
      app: this.appName,
    });
  }

  /**
   * Convenience: wrap any async function and report its outcome as a scheduled command.
   *
   * @example
   * const result = await crontinel.monitorSchedule('reports:generate', async () => {
   *   // your cron job logic
   *   await sendDailyReports()
   * })
   */
  async monitorSchedule<T>(
    command: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T; duration_ms: number; exit_code: number }> {
    const start = Date.now();
    let exitCode = 0;
    let duration_ms = 0;
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      exitCode = 1;
      throw err;
    } finally {
      duration_ms = Date.now() - start;
      await this.scheduleRun({ command, duration_ms, exit_code: exitCode }).catch(() => {
        // Don't fail the caller's job if reporting fails
      });
    }
    return { result: result as T, duration_ms, exit_code: exitCode };
  }
}

export default Crontinel;
