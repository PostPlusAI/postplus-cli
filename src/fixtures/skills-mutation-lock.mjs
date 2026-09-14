import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  runPostPlusSkillUpdate,
  runPostPlusSkillUninstall,
} from '../skill-management.ts';
import { runInteractiveCommand } from '../command-runner.ts';

const [action, scope, behavior] = process.argv.slice(2);
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      schemaVersion: 2,
      releaseId: 'isolated-lock-test',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'demo-skill',
          path: 'skills/demo-skill/SKILL.md',
          status: 'released',
        },
      ],
    }),
  );
process.send({ kind: 'attempting' });
try {
  const mutation =
    action === 'uninstall' ? runPostPlusSkillUninstall : runPostPlusSkillUpdate;
  const result = await mutation(
    {
      runCommand: async () => {
        throw new Error('Unexpected installer read in mutation-entry fixture');
      },
      runInteractiveCommand: async () => {
        process.send({ kind: 'entered' });
        if (behavior === 'descendant') {
          const child = spawn(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            { stdio: 'ignore' },
          );
          process.send({ kind: 'descendant', pid: child.pid });
        }
        if (behavior === 'interrupt') {
          return runInteractiveCommand(process.execPath, [
            '-e',
            "process.kill(process.pid, 'SIGTERM')",
          ]);
        }
        await once(process, 'message');
        // Stop after the first synthetic mutation: no public installer is launched.
        return 23;
      },
    },
    { scope },
  );
  process.send({ kind: 'done', result });
} catch (error) {
  process.send({ kind: 'failed', message: error.message });
}
process.disconnect();
