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

The patch changes only read-only JSON listing. `directories` preserves each
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
Installing, updating and removing remain upstream behavior. The adapter does
not grant overwrite approval or automatically resolve damaged local content.
