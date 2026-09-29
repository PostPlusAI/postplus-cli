import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const MARKER = '# PostPlus managed command';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function registerCommandPath(root, { home = homedir(), platform = process.platform, run = exec } = {}) {
  const directory = join(root, 'bin');
  if (platform === 'win32') {
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $bin=$env:POSTPLUS_REGISTER_BIN; $old=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($old -split ';' | Where-Object { $_ -and $_ -ine $bin }); [Environment]::SetEnvironmentVariable('Path', (@($bin)+$parts -join ';'), 'User')"],
    { env: { ...process.env, POSTPLUS_REGISTER_BIN: directory }, timeout: 30000 });
    return { registered: true, directory, effectiveInCurrentProcess: false };
  }
  await mkdir(home, { recursive: true });
  const line = `export PATH=${quote(directory)}:"$PATH" ${MARKER}`;
  // Shell startup files are plain text here: never source or execute user code.
  // Append only our entry. Preserve all existing settings and permissions.
  for (const name of ['.profile', '.bashrc', '.zprofile']) {
    const file = join(home, name);
    let existing;
    try { existing = await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = ''; }
    if (!existing.split('\n').includes(line)) await appendFile(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`, { mode: 0o600 });
  }
  return { registered: true, directory, effectiveInCurrentProcess: false };
}
