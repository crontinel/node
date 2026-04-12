import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Crontinel } from '../src/index.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const API_KEY = 'ctn_test_key_123';
const BASE_URL = 'https://app.crontinel.com';

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: Date.now(), result: { ok: true } }),
  } as Response);
});

function lastRequest() {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return {
    url: call[0] as string,
    opts: call[1] as RequestInit,
    body: JSON.parse(call[1]?.body as string),
  };
}

describe('Crontinel Node SDK', () => {
  describe('constructor', () => {
    it('should require apiKey', () => {
      expect(() => new Crontinel({ apiKey: '' })).toThrow('apiKey is required');
    });

    it('should default apiUrl to app.crontinel.com', () => {
      const client = new Crontinel({ apiKey: 'test' });
      expect((client as unknown as { apiUrl: string }).apiUrl).toBe('https://app.crontinel.com');
    });

    it('should accept custom apiUrl', () => {
      const client = new Crontinel({ apiKey: 'test', apiUrl: 'https://custom.example.com' });
      expect((client as unknown as { apiUrl: string }).apiUrl).toBe('https://custom.example.com');
    });

    it('should default appName to "node"', () => {
      const client = new Crontinel({ apiKey: 'test' });
      expect((client as unknown as { appName: string }).appName).toBe('node');
    });
  });

  describe('scheduleRun()', () => {
    it('should send JSON-RPC request with correct method and params', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.scheduleRun({
        command: 'php artisan schedule:run',
        duration_ms: 1523,
        exit_code: 0,
      });

      const req = lastRequest();
      expect(req.url).toBe(`${BASE_URL}/api/mcp`);
      expect(req.opts.method).toBe('POST');
      expect(req.body.jsonrpc).toBe('2.0');
      expect(req.body.method).toBe('notify/schedule_run');
      expect(req.body.params.command).toBe('php artisan schedule:run');
      expect(req.body.params.duration_ms).toBe(1523);
      expect(req.body.params.exit_code).toBe(0);
      expect(req.body.params.app).toBe('node');
    });

    it('should default exit_code to 0', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.scheduleRun({ command: 'test', duration_ms: 100 });
      expect(lastRequest().body.params.exit_code).toBe(0);
    });

    it('should include ran_at timestamp', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.scheduleRun({ command: 'test', duration_ms: 50 });
      expect(lastRequest().body.params.ran_at).toBeTruthy();
    });

    it('should throw on API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'Unauthorized' } }),
      } as Response);
      const client = new Crontinel({ apiKey: API_KEY });

      await expect(
        client.scheduleRun({ command: 'test', duration_ms: 100, exit_code: 0 })
      ).rejects.toThrow('Unauthorized');
    });

    it('should throw on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new Crontinel({ apiKey: API_KEY });

      await expect(
        client.scheduleRun({ command: 'test', duration_ms: 100, exit_code: 0 })
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('queueProcessed()', () => {
    it('should send correct payload', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.queueProcessed({
        queue: 'emails',
        processed: 50,
        duration_ms: 3200,
      });

      const req = lastRequest();
      expect(req.body.method).toBe('notify/queue_processed');
      expect(req.body.params.queue).toBe('emails');
      expect(req.body.params.processed).toBe(50);
      expect(req.body.params.duration_ms).toBe(3200);
      expect(req.body.params.app).toBe('node');
    });

    it('should default processed to 0', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.queueProcessed({ queue: 'default', duration_ms: 100 });
      expect(lastRequest().body.params.processed).toBe(0);
    });

    it('should default failed to 0', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.queueProcessed({ queue: 'default', duration_ms: 100 });
      expect(lastRequest().body.params.failed).toBe(0);
    });
  });

  describe('horizonSnapshot()', () => {
    it('should send supervisor and queue state', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.horizonSnapshot({
        supervisors: {
          'supervisor-1': { status: 'running' },
          'supervisor-2': { status: 'paused' },
        },
        failedJobsPerMinute: 4.2,
        paused: false,
      });

      const req = lastRequest();
      expect(req.body.method).toBe('notify/horizon_snapshot');
      expect(req.body.params.supervisors['supervisor-1'].status).toBe('running');
      expect(req.body.params.supervisors['supervisor-2'].status).toBe('paused');
      expect(req.body.params.failed_jobs_per_minute).toBe(4.2);
      expect(req.body.params.paused).toBe(false);
    });
  });

  describe('event()', () => {
    it('should send custom event with key and message', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.event({
        key: 'deployment',
        message: 'Application deployed',
        metadata: { version: '2.1.0' },
      });

      const req = lastRequest();
      expect(req.body.method).toBe('notify/event');
      expect(req.body.params.key).toBe('deployment');
      expect(req.body.params.message).toBe('Application deployed');
      expect(req.body.params.metadata.version).toBe('2.1.0');
    });

    it('should default state to "info"', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.event({ key: 'test', message: 'Test event' });
      expect(lastRequest().body.params.state).toBe('info');
    });
  });

  describe('monitorSchedule()', () => {
    it('should execute function and return result with timing', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      const result = await client.monitorSchedule('my-task', async () => {
        return 'success';
      });

      expect(result.result).toBe('success');
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.exit_code).toBe(0);
    });

    it('should capture exit_code 1 when function throws', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      // The function throws but the error propagates — exit_code tracking happens in finally
      // We test the re-throw behavior:
      await expect(
        client.monitorSchedule('failing-task', async () => {
          throw new Error('Task failed');
        })
      ).rejects.toThrow('Task failed');
      // After the throw, scheduleRun was still called (from finally block)
      const req = lastRequest();
      expect(req.body.method).toBe('notify/schedule_run');
      expect(req.body.params.exit_code).toBe(1);
    });

    it('should call scheduleRun after execution (success)', async () => {
      const client = new Crontinel({ apiKey: API_KEY });
      await client.monitorSchedule('my-task', async () => 'done');

      // Last fetch call should be the scheduleRun notification
      const req = lastRequest();
      expect(req.body.method).toBe('notify/schedule_run');
      expect(req.body.params.command).toBe('my-task');
    });

    it('should call scheduleRun after execution (failure)', async () => {
      mockFetch.mockClear(); // clear the scheduleRun call from monitorSchedule
      const client = new Crontinel({ apiKey: API_KEY });
      try {
        await client.monitorSchedule('failing-task', async () => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }

      // The last call will be the scheduleRun from the finally block
      const req = lastRequest();
      expect(req.body.method).toBe('notify/schedule_run');
      expect(req.body.params.exit_code).toBe(1);
    });
  });
});