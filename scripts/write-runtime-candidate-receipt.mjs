import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('dist/postplus-runtime.json', 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workflowRunId = process.env.GITHUB_RUN_ID;
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^\d+$/.test(workflowRunId ?? '')) throw new Error('Candidate receipt requires an exact Git commit and GitHub workflow run.');
const archiveName = `postplus-cli-v${release.cliVersion}.tar.gz`;
const files = [archiveName, `${archiveName}.sha256`, 'postplus-runtime.json', 'install.sh', 'install.ps1'];
const fileSha256 = Object.fromEntries(await Promise.all(files.map(async name => [name, createHash('sha256').update(await readFile(`dist/${name}`)).digest('hex')])));
if (fileSha256[archiveName] !== release.cli.sha256) throw new Error('Candidate archive does not match runtime metadata.');
await writeFile('dist/postplus-candidate.json', JSON.stringify({ schemaVersion: 1, sourceCommit,
  workflowRunId, cliVersion: release.cliVersion, skillsReleaseId: release.skillsReleaseId,
  archiveSha256: release.cli.sha256, fileSha256 }, null, 2) + '\n');
