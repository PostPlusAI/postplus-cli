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
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = commandSpawner(command)(command, args, {
        env: options.env,
        stdio: ['ignore', stdoutFile.fd, 'pipe'],
      });
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
      }, options.timeoutMs ?? 60_000);

      child.stderr?.on('data', (chunk) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stderrText = Buffer.concat(stderr).toString('utf8');

        if (code === 0) {
          resolve({
            stderr: stderrText,
            stdout: '',
          });
          return;
        }

        reject(
          new Error(
            `Command failed (${code ?? 'unknown'}): ${command} ${args.join(' ')}${
              stderrText ? `\n${stderrText}` : ''
            }`,
          ),
        );
      });
    });

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
  } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = commandSpawner(command)(command, args, {
      env: options.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new CommandInterruptedError(command, signal));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
