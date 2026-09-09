# Contributing to PostPlus CLI

Thank you for your interest in contributing.

## How to contribute

- **Bug reports and feature requests**: open an issue at
  https://github.com/PostPlusAI/postplus-cli/issues
- **Pull requests**: fork the repository, make your changes on a feature
  branch, and open a pull request against `main`.

## Development setup

```bash
node --version   # must be >= 24.5.0
pnpm install
pnpm build
pnpm test
pnpm release:package
node --test scripts/package-release.test.mjs
```

The standalone archive includes the locally installed, lockfile-resolved
`cross-spawn` dependency closure and its licenses. Packaging does not install
or update dependencies. The npm artifact retains its normal dependency install
contract. Package tests exercise both artifacts in temporary directories.

## Contribution guidelines

- Keep pull requests focused on a single change.
- Make sure `pnpm build` and `pnpm test` pass before submitting.
- If your change affects CLI behaviour visible to end users, update the
  relevant section of `README.md`.

## License

By submitting a contribution you agree that your contribution will be licensed
under the PolyForm Shield License 1.0.0 (the same license as this project).
