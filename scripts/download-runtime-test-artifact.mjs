import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { downloadArtifact, selectNodeArtifact } from '../runtime-manager/distribution.mjs';
const release = JSON.parse(await readFile(new URL('../dist/postplus-runtime.json', import.meta.url), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
if (process.env.POSTPLUS_EXPECT_PLATFORM && process.env.POSTPLUS_EXPECT_PLATFORM !== platform) {
  throw new Error(`Runner architecture mismatch: expected ${process.env.POSTPLUS_EXPECT_PLATFORM}, got ${platform}`);
}
const artifact = selectNodeArtifact(release);
const directory = resolve('dist/test-runtime');
await mkdir(directory, { recursive: true });
const archive = join(directory, process.platform === 'win32' ? 'node.zip' : 'node.tar.gz');
await rm(archive, { force: true });
await downloadArtifact(artifact, archive, fetch);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `POSTPLUS_TEST_NODE_ARCHIVE=${archive}\n`);
process.stdout.write(`Verified official Node ${release.node.version} archive for ${platform}.\n`);
