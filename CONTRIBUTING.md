# Contributing

Use Node.js 24+ and pnpm 10.17.0. Install with `pnpm install --frozen-lockfile`, then run `pnpm check:release`, `pnpm test` and `pnpm demo`. On macOS with Obsidian installed, `pnpm e2e` launches an isolated profile and synthetic vault under `runtime/`.

Use synthetic notes and localhost WebDAV fixtures. Do not include credentials, real vault contents, private paths or raw personal logs in issues or pull requests. Never run tests against a daily-use vault or enable external writes.

For bug reports, include the plugin and Obsidian versions, OS, minimal synthetic input, expected behavior and actual behavior. For changes, explain the behavior and relevant tests. Keep format 2 compatibility and exact text preservation; see [the merge contract](docs/MERGE_CONTRACT.md) and [design](docs/DESIGN.md).

The community lint check deliberately reports the extra `.obsidian` exclusion: the actual configuration directory comes from `Vault.configDir`, and the default folder remains excluded as defense in depth. Do not remove it simply to silence a scan. See [the scorecard audit](docs/SCORECARD_REVIEW.md).

Release maintainers manually run the build-provenance workflow, compare its three install files with the locally tested build, verify attestations, and publish those exact files under a tag matching `manifest.json`. There is no automatic deployment or real-vault installation.
