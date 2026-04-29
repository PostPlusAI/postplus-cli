# PostPlus CLI

`PostPlus CLI` signs you in to PostPlus Cloud and reports local account and
hosted capability readiness. PostPlus skills are added from the public
`postplus-skills` repository.

## Install

Requires Node.js `>=20.10.0` and npm.

```bash
npm install -g @postplus/cli
postplus auth login
npx -y skills add PostPlusAI/postplus-skills --skill '*' --agent claude-code codex cursor --yes
```

## Commands

- `postplus auth login`
- `postplus auth status`
- `postplus auth validate`
- `postplus auth refresh`
- `postplus auth revoke`
- `postplus auth logout`
- `postplus doctor`
- `postplus list`
- `postplus status`

`postplus install`, `postplus update`, and `postplus uninstall` are not skill
installation commands. Use:

```bash
npx -y skills add PostPlusAI/postplus-skills --skill '*' --agent claude-code codex cursor --yes
```
