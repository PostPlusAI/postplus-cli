# Pinned local skills installer

The runtime ships at `vendor/skills-runtime/cli.mjs`. Invoke it with the current
Node executable, never `npx` or an installer discovered in a user's cache.

`skills@1.5.26` and its complete production dependency closure are fixed in
`sources.json`. The original npm tarballs are retained here for offline rebuilds;
each is verified against its registry SHA-512 integrity before extraction.
This source directory and the esbuild tool are not included in npm or archive
releases. The shipped integrity manifest retains the origin/version/integrity
of every upstream package, the patch hash, and every runtime/license file hash.

To rebuild, install development dependencies, then run:

```
pnpm vendor:skills:build
pnpm vendor:skills:check
pnpm vendor:skills:test
```

Build requires Node >=24.5, Git, tar and the exact esbuild version in the source
manifest. Updating dependencies requires updating the reviewed source manifest
and tarballs, reapplying the patch, and rerunning acceptance. Builds do not fetch
network content or resolve moving dependency versions. No upstream install hooks
are executed. License and notice files are copied from every original package.

The patch extends read-only JSON listing and one narrowly scoped PostPlus retirement command. `directories` preserves each
physical entry instead of collapsing independent copies by display name:

- `path`: actual entry path, including the agent's symlink path.
- `realPath`: resolved path, or null for a dangling link.
- `agentIds`: registry IDs whose existing installer roots contain the entry.
- `directoryName`: actual slot name, retained if metadata is changed.
- `metadataName`: parsed skill name, or null when absent/invalid.
- `metadataError`: null, `missing-skill-file`, `invalid-skill-metadata`,
  `occupied-file`, or `dangling-link`.

Directory discovery reuses upstream `agents`, `getAgentBaseDir`, and Eve
subagent discovery. It includes the configured roots already scanned by upstream
list/remove, so old independent copies remain visible. Canonical content does
not stand in for an independent agent entry. Non-skill entries are exposed with
metadata diagnostics, not treated as an installation failure for every skill;
PostPlus must select only its managed names, verify content, and protect edits.
Installing and updating remain upstream behavior. Ordinary upstream removal is
unchanged. PostPlus retirement uses `remove --postplus-retirement-plan <manifest-path>`:
only exact directory paths returned by the existing upstream discovery can be
removed. It does not search by name for additional removal targets.

PostPlus writes this private manifest after protection/approval and backup. Each
entry binds the retired name, installed path and real path, backup manifest and
backup path, and content hash. `user-approved` means the user approved replacing
or removing that precise backed-up content; it is not evidence of historical
ownership. `verified-baseline` retains automatic retirement for unchanged content
matching PostPlus's recorded baseline. Unknown content never enters that route.
The runtime checks the whole manifest, upstream roots, path identity, backup
record, backup hash and installed hash before deletion. A mismatch stops without
writing. Links are removed before content directories. Other same-name entries
not in the manifest remain; upstream lock entries are cleared only when no
matching directory remains. The manifest and backups remain local evidence.

Updating this ABI requires both `src/skills-retirement.test.ts` and the upstream
runtime acceptance suite. It does not introduce an ownership ledger, restore
command, lock-recovery command, or new agent directory rules.
