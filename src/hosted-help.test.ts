import assert from 'node:assert/strict';
import test from 'node:test';
import { runBalanceCommand, runRunsCommand } from './hosted-account-commands.js';
import { runHostedDomainCommand, runMediaFileCommand } from './hosted-domain-commands.js';
import { runStudioCommand } from './studio.js';

test('nested hosted help returns before authentication, requests, input reads, or local mutations', async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  let output = '';
  globalThis.fetch = async () => { throw new Error('Help attempted a network request'); };
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try {
    for (const flag of ['--help', '-h']) {
      const commands: Array<() => Promise<unknown>> = [
        () => runBalanceCommand([flag]),
        ...['list', 'show'].map(command => () => runRunsCommand([command, flag])),
        ...['init', 'open', 'status'].map(command => () => runStudioCommand([command, '--workdir', '/nonexistent/help-must-not-create', flag])),
        ...['upload', 'download'].map(command => () => runMediaFileCommand([command, flag])),
        ...(['research', 'media', 'publish'] as const).map(domain => () => runHostedDomainCommand(domain, ['schema', flag])),
        () => runHostedDomainCommand('media', ['poll', '--resume-from', '/nonexistent/help-checkpoint', flag]),
        () => runHostedDomainCommand('media', ['estimate', flag]),
        () => runHostedDomainCommand('media', ['create', flag]),
        () => runHostedDomainCommand('research', ['run', flag]),
        () => runHostedDomainCommand('research', ['run', '--resume-from', '/nonexistent/help-checkpoint', flag]),
      ];
      for (const command of commands) {
        output = '';
        assert.equal(await command(), 0);
        assert.match(output, /Usage:/);
      }
    }
    await assert.rejects(runHostedDomainCommand('media', ['create', 'not-a-real-endpoint', '--help']), /Unknown/);
    await assert.rejects(runHostedDomainCommand('research', ['run', 'not-a-real-route', '--help']), /Unknown/);
    await assert.rejects(runStudioCommand(['not-a-command', '--help']), /Unknown/);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
});
