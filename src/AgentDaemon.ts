import { execSync, spawn } from 'node:child_process';
import { hostname } from 'node:os';

// ── Types ───────────────────────────────────────────────────────────────

interface AgentConfig {
  apiKey: string;
  apiUrl?: string;
  appId?: string;
  agentId?: string;
  agentName?: string;
  /**
   * Glob-style patterns of commands this agent is permitted to execute.
   * `*` matches any sequence of characters; everything else must match
   * literally. Patterns match the *entire* command string.
   *
   * SECURITY: an empty or undefined list means NO commands are permitted.
   * This is a fail-closed default — it is not "allow everything." Every
   * command the cloud API sends must be explicitly allowlisted before it
   * will be executed.
   */
  allowedCommands?: string[];
}

interface CommandPayload {
  id: number;
  command: string;
  payload: Record<string, unknown> | null;
  request_key: string | null;
}

const DEFAULT_API_URL = 'https://app.crontinel.com';
const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_S = 60;
const MAX_RECONNECT_DELAY_S = 60;
const POLL_HTTP_TIMEOUT_S = 15;

// ── Command allowlist ───────────────────────────────────────────────────

/**
 * Converts a glob-style pattern (`*` = wildcard, everything else literal)
 * into an anchored RegExp that matches the entire string.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '*' : `\\${ch}`));
  const regexBody = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${regexBody}$`);
}

/**
 * Checks whether `command` matches at least one glob-style pattern in
 * `patterns`. An empty/undefined pattern list always rejects — this is a
 * fail-closed check, matching the AgentConfig.allowedCommands contract.
 */
export function isCommandAllowed(command: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(command));
}

// ── Agent Daemon ────────────────────────────────────────────────────────

export class AgentDaemon {
  private running = true;
  private lastHeartbeatAt = 0;
  private startedAt = 0;
  private reconnectAttempt = 0;
  private outputWriter?: (msg: string) => void;

  private apiKey: string;
  private apiUrl: string;
  private appId: string;
  private agentId: string;
  private agentName: string;
  private allowedCommands: string[];

  constructor(config: AgentConfig) {
    if (!config.apiKey) {
      throw new Error('CRONTINEL_API_KEY is required');
    }
    if (!config.appId) {
      throw new Error('CRONTINEL_APP_ID is required — set the app slug or numeric ID');
    }

    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.appId = config.appId;
    this.agentId = config.agentId || hostname();
    this.agentName = config.agentName || `node-agent:${hostname()}`;

    // Fail-closed: if allowedCommands isn't explicitly passed, fall back to
    // the CRONTINEL_AGENT_ALLOWED_COMMANDS env var (comma-separated). If
    // neither is set, the allowlist is empty and NO commands will execute.
    this.allowedCommands =
      config.allowedCommands ??
      (process.env.CRONTINEL_AGENT_ALLOWED_COMMANDS
        ? process.env.CRONTINEL_AGENT_ALLOWED_COMMANDS.split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : []);
  }

  /**
   * Bind an output writer (defaults to stdout).
   */
  setOutputWriter(writer: (msg: string) => void): void {
    this.outputWriter = writer;
  }

  /**
   * Run the agent daemon (indefinite blocking loop).
   */
  async run(): Promise<void> {
    this.startedAt = Date.now();
    this.lastHeartbeatAt = this.startedAt;
    this.installSignalHandlers();

    this.log('Crontinel Node Agent starting...');
    this.log(`Agent ID: ${this.agentId}`);
    this.log(`App ID: ${this.appId}`);
    this.log(`API URL: ${this.apiUrl}`);

    // Register with the cloud on startup
    await this.register();

    this.log('Agent registered. Starting poll loop...');

    while (this.running) {
      try {
        await this.pollOnce();
        this.reconnectAttempt = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Poll error: ${message}`);
      }

      if (!this.running) break;

      await this.sleep(POLL_INTERVAL_MS);
    }

    this.log('Agent stopped.');
  }

  /**
   * Graceful stop (called from signal handlers).
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Generate a systemd unit file and print it to stdout.
   */
  static printSystemdConfig(): void {
    const nodeBin = process.execPath;
    const cwd = process.cwd();

    console.log('[Unit]');
    console.log('Description=Crontinel Node Agent — remote command execution daemon');
    console.log('After=network.target');
    console.log('');
    console.log('[Service]');
    console.log('Type=simple');
    console.log(`ExecStart=${nodeBin} ${cwd}/node_modules/.bin/crontinel agent`);
    console.log('Restart=always');
    console.log('RestartSec=5');
    console.log('TimeoutStopSec=30');
    console.log('KillSignal=SIGTERM');
    console.log(`Environment=CRONTINEL_API_KEY=${process.env.CRONTINEL_API_KEY || ''}`);
    console.log(`Environment=CRONTINEL_APP_ID=${process.env.CRONTINEL_APP_ID || ''}`);
    console.log(`Environment=CRONTINEL_API_URL=${process.env.CRONTINEL_API_URL || ''}`);
    console.log('');
    console.log('[Install]');
    console.log('WantedBy=multi-user.target');
    console.log('');
    console.log('# Save to: /etc/systemd/system/crontinel-agent.service');
    console.log('# Then:   sudo systemctl daemon-reload && sudo systemctl enable --now crontinel-agent');
  }

  // ── Private: Registration ──────────────────────────────────────────────

  private async register(): Promise<void> {
    try {
      const body = {
        agent_id: this.agentId,
        agent_name: this.agentName,
        metadata: {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      };

      const res = await fetch(`${this.apiUrl}/api/v1/agents/register`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Registration failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      this.log(`Registered: id=${data.id}, status=${data.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Registration error: ${message} (continuing anyway)`);
    }
  }

  // ── Private: Poll loop ─────────────────────────────────────────────────

  private async pollOnce(): Promise<void> {
    // Check heartbeat
    if (this.isHeartbeatDue()) {
      await this.sendHeartbeat();
    }

    // Poll for pending commands
    const commands = await this.fetchCommands();
    if (commands.length === 0) return;

    this.log(`Received ${commands.length} command(s)`);

    for (const cmd of commands) {
      if (!this.running) break;
      await this.executeAndReport(cmd);
    }
  }

  private async fetchCommands(): Promise<CommandPayload[]> {
    const url = `${this.apiUrl}/api/v1/agents/${encodeURIComponent(this.appId)}/commands`;

    const res = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(POLL_HTTP_TIMEOUT_S * 1000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Commands fetch failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      data: CommandPayload[];
    };

    return data.data ?? [];
  }

  // ── Private: Execute + Report ──────────────────────────────────────────

  private async executeAndReport(cmd: CommandPayload): Promise<void> {
    const { id: triggerId, command: commandStr } = cmd;

    this.log(`Executing [${triggerId}]: ${commandStr}`);

    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    let exitCode = 0;
    let output = '';
    let status: 'completed' | 'failed' = 'completed';
    let errorMessage: string | undefined;

    try {
      // Acknowledge receipt first
      await this.acknowledge(triggerId);

      if (!isCommandAllowed(commandStr, this.allowedCommands)) {
        this.log(`[${triggerId}] Rejected: command not in allowlist: ${commandStr}`);
        throw new Error('Command rejected: not in allowlist');
      }

      // Execute via shell
      output = execSync(commandStr, {
        timeout: 300_000, // 5 min default
        maxBuffer: 10_000_000, // 10 MB
        windowsHide: true,
      }).toString();

      exitCode = 0;
      status = 'completed';
    } catch (err) {
      exitCode = err instanceof Error && 'status' in err ? (err as { status?: number }).status ?? 1 : 1;
      output = err instanceof Error ? err.message : String(err);
      status = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - startMs;
    const finishedAt = new Date().toISOString();

    this.log(`[${triggerId}] ${status} (${durationMs}ms, exit ${exitCode})`);

    await this.reportResult({
      trigger_id: triggerId,
      status,
      exit_code: exitCode,
      output,
      error_message: errorMessage,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
    });
  }

  private async acknowledge(triggerId: number): Promise<void> {
    await this.reportResult({
      trigger_id: triggerId,
      status: 'acknowledged' as const,
    });
  }

  private async reportResult(payload: {
    trigger_id: number;
    status: 'acknowledged' | 'completed' | 'failed';
    exit_code?: number;
    output?: string;
    error_message?: string;
    started_at?: string;
    finished_at?: string;
    duration_ms?: number;
  }): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v1/ingest/agent-result`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        this.log(`Result report failed (${res.status}): ${text}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Result report error: ${message}`);
    }
  }

  // ── Private: Heartbeat ─────────────────────────────────────────────────

  private async sendHeartbeat(): Promise<void> {
    this.lastHeartbeatAt = Date.now();
    const uptime = Math.round((Date.now() - this.startedAt) / 1000);

    try {
      const res = await fetch(`${this.apiUrl}/api/v1/agents/heartbeat`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          agent_id: this.agentId,
          metadata: {
            uptime_seconds: uptime,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        this.log(`Heartbeat failed (${res.status}): ${text}`);
      } else {
        this.log(`Heartbeat sent (uptime: ${uptime}s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Heartbeat error: ${message}`);
    }
  }

  private isHeartbeatDue(): boolean {
    return (Date.now() - this.lastHeartbeatAt) >= HEARTBEAT_INTERVAL_S * 1000;
  }

  // ── Private: Helpers ───────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': `crontinel-node-agent/${this.agentId}`,
    };
  }

  private installSignalHandlers(): void {
    const shutdown = (signal: string) => {
      this.log(`Received ${signal}. Shutting down gracefully...`);
      this.running = false;
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const formatted = `[${timestamp}] Crontinel Agent: ${message}`;

    if (this.outputWriter) {
      this.outputWriter(formatted);
    } else {
      console.log(formatted);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
