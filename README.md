# PostPlus CLI

`PostPlus CLI` installs PostPlus skills into your local AI agent, keeps them up
to date, and signs you in to PostPlus Cloud for hosted capabilities such as
research providers, generation providers, billing, and account status.

## Install

Requires Node.js `>=20.10.0` and npm.

```bash
npm install -g @postplus/cli
```

After installing the CLI, complete setup with:

```bash
postplus doctor
postplus auth login
postplus auth validate
postplus install
postplus status
```

## Common Commands

- `postplus auth login`
- `postplus auth status`
- `postplus install`
- `postplus list`
- `postplus status`
- `postplus uninstall`
- `postplus update --apply`
- `postplus doctor`

## Skill Install Targets

By default, the CLI installs released skills into:

- `~/.claude/skills` for Claude Code
- `~/.agents/skills` for official Codex
- `$CODEX_HOME/skills` for the Codex app, defaulting to `~/.codex/skills`

If you keep your agent configuration somewhere else, set the matching directory
before running `postplus install`:

- `POSTPLUS_CLAUDE_SKILLS_DIR`
- `POSTPLUS_CODEX_SKILLS_DIR`
- `POSTPLUS_CODEX_APP_SKILLS_DIR`

To remove tracked PostPlus installs from every configured target:

```bash
postplus uninstall
```

To remove only specific tracked skills:

```bash
postplus uninstall <skill-id ...>
```
