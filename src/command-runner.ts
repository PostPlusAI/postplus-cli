import crossSpawn from 'cross-spawn';
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// npm/npx/postplus may resolve to a .cmd shim, including one supplied by a Node version
// manager. Preserve PATH selection and let cross-spawn escape the actual shim;
// do not guess a global npm JS entrypoint or enable a shell for native commands.
function commandSpawner(
  command: string,
): (command: string, args: string[], options: SpawnOptions) => ChildProcess {
  return process.platform === 'win32' &&
    /(?:^|[\\/])(?:npm|npx|postplus)(?:\.cmd|\.exe|\.com)?$/i.test(command)
    ? crossSpawn
    : spawn;
}

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export class CommandExecutionError extends Error {
  readonly code = 'postplus_command_failed';
  constructor(readonly command: string, readonly exitCode: number, readonly stdout: string, readonly stderr: string) {
    super(`Command ${command} failed with exit code ${exitCode}.`, { cause: new Error(stderr || stdout || `Exit code ${exitCode}.`) });
    this.name = 'CommandExecutionError';
  }
}

function boundedCapture() {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      truncated ||= bytes.length + data.length > 65536;
      bytes = Buffer.from(Buffer.concat([bytes, data]).subarray(-65536));
    },
    text: () => `${truncated ? '[output truncated; last 65536 bytes]\n' : ''}${bytes.toString('utf8')}`,
  };
}

export class CommandInterruptedError extends Error {
  readonly code = 'postplus_command_interrupted';
  constructor(
    readonly command: string,
    readonly signal: NodeJS.Signals,
  ) {
    super(
      `Command ${command} was interrupted by ${signal}; child processes may still be running.`,
    );
    this.name = 'CommandInterruptedError';
  }
}

export class CommandTimeoutError extends Error {
  readonly code = 'postplus_command_timeout';
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Command timed out: ${command} after ${timeoutMs}ms; child processes may still be running.`);
    this.name = 'CommandTimeoutError';
  }
}

// A separate process group is safe when stdin is ignored. Interactive terminal
// readers must stay in the foreground group to avoid SIGTTIN.
function waitForCommand(child: ChildProcess, command: string, timeoutMs: number, processGroup: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    let interruption: CommandInterruptedError | CommandTimeoutError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (processGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // A process that has already exited needs no signal. Other failures do
        // not establish cleanup; typed interruption errors remain conservative.
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    const interrupt = (error: CommandInterruptedError | CommandTimeoutError) => {
      if (interruption) return;
      interruption = error;
      kill('SIGTERM');
      // The leader can exit before its descendants. Still signal the group at
      // the deadline; do not interpret the leader's close event as tree cleanup.
      escalation = setTimeout(() => {
        kill('SIGKILL');
        cleanup();
        reject(error);
      }, 1_000);
    };
    const onInterrupt = () => interrupt(new CommandInterruptedError(command, 'SIGINT'));
    const onTerminate = () => interrupt(new CommandInterruptedError(command, 'SIGTERM'));
    const timer = setTimeout(() => interrupt(new CommandTimeoutError(command, timeoutMs)), timeoutMs);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (_code, signal) => {
      if (signal && !interruption) interrupt(new CommandInterruptedError(command, signal));
    });
    child.once('close', (code, signal) => {
      if (interruption) return;
      cleanup();
      if (signal) {
        kill('SIGKILL');
        reject(new CommandInterruptedError(command, signal));
      } else resolve(code ?? 1);
    });
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'postplus-cli-command-'));
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stdoutFile = await open(stdoutPath, 'w');

  try {
    const processGroup = process.platform !== 'win32';
    const child = commandSpawner(command)(command, args, {
      env: options.env,
      detached: processGroup,
      stdio: ['ignore', stdoutFile.fd, 'pipe'],
    });
    const stderrLimit = 64 * 1024;
    let stderr = Buffer.alloc(0);
    let truncated = false;
    child.stderr?.on('data', (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      truncated ||= stderr.length + data.length > stderrLimit;
      // Copy only the retained tail so a large backing buffer is not retained.
      stderr = data.length >= stderrLimit
        ? Buffer.from(data.subarray(data.length - stderrLimit))
        : Buffer.concat([stderr.subarray(Math.max(0, stderr.length + data.length - stderrLimit)), data]);
    });
    const code = await waitForCommand(child, command, options.timeoutMs ?? 60_000, processGroup);
    const stderrText = `${truncated ? '[stderr truncated; last 65536 bytes]\n' : ''}${stderr.toString('utf8')}`;
    if (code !== 0) {
      throw new Error(`Command failed (${code}): ${command} ${args.join(' ')}${stderrText ? `\n${stderrText}` : ''}`);
    }
    const result = { stderr: stderrText };

    await stdoutFile.close();

    return {
      ...result,
      stdout: await readFile(stdoutPath, 'utf8'),
    };
  } finally {
    await stdoutFile.close().catch(() => {});
    await rm(tempDir, { force: true, recursive: true });
  }
}

export async function runInteractiveCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: 'inherit' | 'stderr' | 'capture';
    onCapturedOutput?: (result: CommandResult) => void;
    stdin?: 'inherit' | 'ignore';
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const capture = options.stdout === 'capture';
  const processGroup = process.platform !== 'win32' && (capture || options.stdin === 'ignore');
  const child = commandSpawner(command)(command, args, {
    env: options.env,
    detached: processGroup,
    stdio: [capture ? 'ignore' : options.stdin ?? 'inherit', capture ? 'pipe' : options.stdout === 'stderr' ? 2 : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  const stdout = boundedCapture();
  const stderr = boundedCapture();
  child.stdout?.on('data', stdout.append);
  child.stderr?.on('data', stderr.append);
  try {
    const code = await waitForCommand(child, command, options.timeoutMs ?? 300_000, processGroup);
    if (capture) options.onCapturedOutput?.({ stdout: stdout.text(), stderr: stderr.text() });
    if (capture && code !== 0) throw new CommandExecutionError(command, code, stdout.text(), stderr.text());
    return code;
  } catch (error) {
    if (capture && error instanceof Error && !(error instanceof CommandExecutionError)) {
      Object.assign(error, { stdout: stdout.text(), stderr: stderr.text() });
    }
    throw error;
  }
}
