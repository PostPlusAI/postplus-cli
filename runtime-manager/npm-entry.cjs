#!/usr/bin/env node
'use strict';
// The npm entry is intentionally limited to Node built-ins available on older
// hosts. Product code runs only after selecting PostPlus's own runtime.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(process.env.POSTPLUS_INSTALL_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'PostPlus')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'postplus')));
const env = { ...process.env, POSTPLUS_INSTALL_ROOT: root };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
function run(command, args, capture) {
  const result = cp.spawnSync(command, args, { env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error('PostPlus command failed.'), { commandExitCode: result.status || 1 });
  return result.stdout;
}
function managedFile(relative) {
  if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(value => !value || value === '.' || value === '..')) throw new Error('Invalid managed installation path.');
  const realRoot = fs.realpathSync(root);
  const file = path.join(realRoot, relative);
  const resolved = fs.realpathSync(file);
  const inside = path.relative(realRoot, resolved);
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('Invalid managed installation file.');
  return resolved;
}
try {
  if (!fs.existsSync(path.join(root, 'active'))) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'postplus-migrate-'));
    try {
      const windows = process.platform === 'win32';
      const installer = path.join(temp, windows ? 'install.ps1' : 'install.sh');
      run(windows ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '300', `https://postplus.io/${windows ? 'install.ps1' : 'install.sh'}`, '-o', installer], false);
      const output = windows
        ? run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProgramOnly'], true)
        : run('/bin/sh', [installer, '--program-only'], true);
      if (JSON.parse(output).ok !== true) throw new Error('PostPlus program preparation did not complete.');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const lines = fs.readFileSync(path.join(root, 'active'), 'utf8').split('\n');
  if (lines.length !== 7 || lines[0] !== 'postplus-installation-v1' || lines[6] !== '' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(lines[1]) || !/^\d+\.\d+\.\d+$/.test(lines[2]) ||
      !lines[3].startsWith(`runtimes/node-v${lines[2]}-`) || !lines[4].startsWith(`versions/${lines[1]}/`)) {
    throw new Error('PostPlus installation record needs repair. Run the official installer.');
  }
  run(managedFile(lines[3]), [managedFile(lines[4]), ...process.argv.slice(2)], false);
} catch (error) {
  if (error.commandExitCode) { process.exitCode = error.commandExitCode; } else {
  process.stderr.write(`PostPlus could not start: ${error.message}\nUse the official PostPlus installer to finish setup; your system Node does not need to change.\n`);
  process.exitCode = 1;
  }
}
