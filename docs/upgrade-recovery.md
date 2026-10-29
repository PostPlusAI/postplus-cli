# Upgrade recovery contract and regression

Authenticated requests preserve structured HTTP 426 upgrade rejections in
`sendAuthedCloudRequest`; business commands must not replace them with generic
errors. The CLI entry owns the one-update limit and continuation. Diagnostics
report compatibility separately; accepted or uncertain writes retain their
original operation and are never blindly submitted again.

A verified update continues the original command in the same conversation, even
when the old server response requests a session restart. The CLI launches the
updated executable, retaining the original operation/checkpoint and the existing
one-update/one-retry guard. Installation, repair and update completion instruct
the agent to read the updated Skill and references needed for the current task;
they do not claim to refresh the host’s loaded context or require the user to
move the task to a new conversation.

`src/channel-upgrade-recovery.test.ts` runs compiled commands through rejection,
update and continuation, including failed updates, repeated rejection and accepted
write polling. Keep this coverage when adding a new request path. Run
`pnpm test:runtime` for integrity and repair tests; regular `.DS_Store` files must
not break reuse, while changed program bytes, unexpected directories and unsafe
links must still fail. The managed-runtime acceptance suite also inserts Finder
metadata before exercising an installed updater.

A fixed candidate does not change already installed old updaters. Before raising
the server's minimum client version, verify migration from released versions.
An old client blocked before recovery needs the official installer; use its
explicit repair option when it reports an integrity failure.
