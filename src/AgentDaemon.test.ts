import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentDaemon, isCommandAllowed } from './AgentDaemon.js';

// Mock fetch (used for acknowledge/report-result calls)
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock execSync so we can assert whether the daemon actually shelled out.
const mockExecSync = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

const API_KEY = 'ctn_test_key_123';
const APP_ID = 'test-app';

function makeDaemon(allowedCommands?: string[]) {
  return new AgentDaemon({
    apiKey: API_KEY,
    appId: APP_ID,
    allowedCommands,
  });
}

// executeAndReport is private; access it the same way the existing test
// suite reaches into private client internals for assertions.
function callExecuteAndReport(
  daemon: AgentDaemon,
  cmd: { id: number; command: string; payload: null; request_key: null },
) {
  return (
    daemon as unknown as {
      executeAndReport: (c: typeof cmd) => Promise<void>;
    }
  ).executeAndReport(cmd);
}

function reportedResults() {
  return mockFetch.mock.calls
    .filter((call) => (call[0] as string).includes('/api/v1/ingest/agent-result'))
    .map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockExecSync.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
  } as Response);
  delete process.env.CRONTINEL_AGENT_ALLOWED_COMMANDS;
});

describe('isCommandAllowed()', () => {
  it('rejects when the pattern list is empty', () => {
    expect(isCommandAllowed('php artisan schedule:run', [])).toBe(false);
  });

  it('rejects when the pattern list is undefined', () => {
    expect(isCommandAllowed('php artisan schedule:run', undefined)).toBe(false);
  });

  it('allows an exact string match', () => {
    expect(isCommandAllowed('php artisan schedule:run', ['php artisan schedule:run'])).toBe(true);
  });

  it('rejects a command that does not exactly match a literal pattern', () => {
    expect(isCommandAllowed('php artisan schedule:run --force', ['php artisan schedule:run'])).toBe(
      false,
    );
  });

  it('allows a command matching a wildcard pattern', () => {
    expect(isCommandAllowed('php artisan schedule:run --force', ['php artisan schedule:*'])).toBe(
      true,
    );
  });

  it('rejects a command that does not match any configured pattern', () => {
    expect(isCommandAllowed('rm -rf /', ['php artisan schedule:*', 'php artisan queue:work'])).toBe(
      false,
    );
  });

  it('escapes regex special characters in literal segments', () => {
    // A malicious command shouldn't sneak past because '.' or other regex
    // metacharacters in the pattern get interpreted as regex, not literal.
    expect(isCommandAllowed('phpXartisan', ['php.artisan'])).toBe(false);
    expect(isCommandAllowed('php.artisan', ['php.artisan'])).toBe(true);
  });
});

describe('AgentDaemon command allowlist enforcement', () => {
  it('executes and reports success when the command matches an exact allowlist entry', async () => {
    mockExecSync.mockReturnValue(Buffer.from('ok'));
    const daemon = makeDaemon(['php artisan schedule:run']);

    await callExecuteAndReport(daemon, {
      id: 1,
      command: 'php artisan schedule:run',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      'php artisan schedule:run',
      expect.objectContaining({ timeout: 300_000 }),
    );

    const results = reportedResults();
    const finalResult = results[results.length - 1];
    expect(finalResult.status).toBe('completed');
  });

  it('executes and reports success when the command matches a wildcard allowlist entry', async () => {
    mockExecSync.mockReturnValue(Buffer.from('ok'));
    const daemon = makeDaemon(['php artisan *']);

    await callExecuteAndReport(daemon, {
      id: 2,
      command: 'php artisan queue:work --once',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const results = reportedResults();
    expect(results[results.length - 1].status).toBe('completed');
  });

  it('rejects and reports failure when the allowlist is empty (default, fail-closed)', async () => {
    const daemon = makeDaemon(); // no allowedCommands passed, no env var set

    await callExecuteAndReport(daemon, {
      id: 3,
      command: 'php artisan schedule:run',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).not.toHaveBeenCalled();

    const results = reportedResults();
    const finalResult = results[results.length - 1];
    expect(finalResult.status).toBe('failed');
    expect(finalResult.error_message).toBe('Command rejected: not in allowlist');
  });

  it('rejects and reports failure when the command does not match any configured pattern', async () => {
    const daemon = makeDaemon(['php artisan schedule:run']);

    await callExecuteAndReport(daemon, {
      id: 4,
      command: 'rm -rf /',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).not.toHaveBeenCalled();

    const results = reportedResults();
    const finalResult = results[results.length - 1];
    expect(finalResult.status).toBe('failed');
    expect(finalResult.error_message).toBe('Command rejected: not in allowlist');
  });

  it('populates the allowlist from CRONTINEL_AGENT_ALLOWED_COMMANDS when not passed explicitly', async () => {
    process.env.CRONTINEL_AGENT_ALLOWED_COMMANDS = 'php artisan schedule:run, php artisan queue:work';
    mockExecSync.mockReturnValue(Buffer.from('ok'));

    const daemon = makeDaemon(); // undefined -> should fall back to env var

    await callExecuteAndReport(daemon, {
      id: 5,
      command: 'php artisan queue:work',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const results = reportedResults();
    expect(results[results.length - 1].status).toBe('completed');
  });

  it('an explicit empty array passed in code overrides the env var and still rejects everything', async () => {
    process.env.CRONTINEL_AGENT_ALLOWED_COMMANDS = 'php artisan schedule:run';
    const daemon = makeDaemon([]); // explicit empty array, not undefined

    await callExecuteAndReport(daemon, {
      id: 6,
      command: 'php artisan schedule:run',
      payload: null,
      request_key: null,
    });

    expect(mockExecSync).not.toHaveBeenCalled();
    const results = reportedResults();
    expect(results[results.length - 1].status).toBe('failed');
  });
});
