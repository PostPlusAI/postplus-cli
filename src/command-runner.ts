import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'postplus-cli-command-'));
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stdoutFile = await open(stdoutPath, 'w');

  try {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
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
      child.on('exit', (code) => {
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
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
