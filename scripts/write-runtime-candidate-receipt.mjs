import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('dist/postplus-runtime.json', 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workflowRunId = process.env.GITHUB_RUN_ID;
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^\d+$/.test(workflowRunId ?? '')) throw new Error('Candidate receipt requires an exact Git commit and GitHub workflow run.');
await writeFile('dist/postplus-candidate.json', JSON.stringify({ schemaVersion: 1, sourceCommit,
  workflowRunId, cliVersion: release.cliVersion, skillsReleaseId: release.skillsReleaseId,
  archiveSha256: release.cli.sha256 }, null, 2) + '\n');
