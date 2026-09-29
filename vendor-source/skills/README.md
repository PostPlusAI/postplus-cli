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

The patch extends read-only JSON listing and one exact-path PostPlus removal command.
Its final shutdown drains stdout and stderr before exiting, preserving complete
large JSON results when the parent reads a pipe slowly. The upstream bounded
telemetry wait remains in place, and uncaught command errors retain a failure
exit status. `directories` preserves each
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
PostPlus selects names from the current bundle and previously recorded PostPlus
membership. Installing and updating retain upstream directory rules.
PostPlus uses `remove --postplus-remove-plan <manifest-path>` before replacing
outdated same-name slots, retiring skills, and uninstalling. The schemaVersion 2
manifest contains scope, names, and exact entries (`name`, `path`, `realPath`).
The runtime re-enumerates all entries and validates every path before deletion.
Links are removed before directories and are never followed for deletion;
paths outside the enumeration are rejected. No previous fingerprint, ownership
classification, consent, or backup is required. Unlisted entries remain.
Upstream lock entries are cleared only when no matching directory remains.
PostPlus removes the temporary plan after the installer finishes. A partial
failure does not advance the verified baseline; another maintenance invocation
reconciles the actual remaining installation.

Updating this ABI requires both `src/skills-retirement.test.ts` and the upstream
runtime acceptance suite. It does not introduce an ownership ledger, restore
command, lock-recovery command, or new agent directory rules.
