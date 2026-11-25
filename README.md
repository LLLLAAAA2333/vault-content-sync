# Vault Content Sync

[中文说明](README.zh-CN.md) · [Community listing](https://community.obsidian.md/plugins/vault-content-sync)

Compare notes and attachments in your Obsidian vault with a WebDAV folder by their content. Inspect conflicts and use a conservative line-level three-way merge when a common version exists. The local Markdown top-level `updated` field stays local; other properties and content are compared.

Version **0.6.4** adds WebDAV synchronization and conflict review with per-block choices, a live result and manual Markdown editing. The plugin writes only after you submit a change. It retains the previous versions and uses file-level preconditions for WebDAV writes.

## Features

- Verify original file bytes and shared content separately, without relying on modification times.
- Inspect differences and conflicts across notes, YAML metadata and attachments.
- Preserve line endings, BOM, unchanged content and the local `updated` field.
- Merge independent line edits; stop on overlapping edits, ambiguous alignment or resource limits.
- Retain original versions and check preconditions before writes; recover interrupted operations.
- Treat failed reads as unknown, never as a missing file. Different content without a common baseline is not automatically merged.

## Install and use

Requires **Obsidian desktop 1.14.4+**. The plugin has been used on macOS and does not support mobile.

1. Install or update from [Community plugins](https://community.obsidian.md/plugins/vault-content-sync). For manual installation, download `main.js`, `manifest.json` and `styles.css` from the same [GitHub Release](https://github.com/LLLLAAAA2333/vault-content-sync/releases/latest) and place them in your vault's `<config-directory>/plugins/vault-content-sync/`.
2. Enable **Vault Content Sync** and enter the WebDAV HTTPS folder URL, service username and password in its settings.
3. Open the sidebar from the ribbon or run **查看文件变化** (View file changes), then click **刷新变更** (Refresh changes).
4. Open a conflict to compare the two versions. Choose a side for each changed block, choose a whole version, or edit the Markdown result. Click **提交结果** (Commit result) to sync it. Use **提交变更** (Commit changes) for non-conflicting changes.

The first refresh after loading the plugin reads all in-scope files. Later refreshes can reuse unchanged local digests and remote responses with matching strong validators. See [WebDAV synchronization](docs/WEBDAV_SYNC.md) for write and recovery behavior.

## Network, storage and permissions

The plugin contacts only your configured WebDAV endpoint to compare files and apply confirmed changes. It has no telemetry, advertisements or project-operated service. HTTP is accepted only for localhost testing; external connections require HTTPS. HTTP Basic authentication uses base64 encoding for the username/password header, not to hide executable code. The bundled YAML parser also includes base64 handling for YAML binary values; those values are data, not scripts.

The endpoint and username are saved in the vault's plugin settings. Passwords stay in memory by default. **记住密码** (Remember password) stores the password through Obsidian's encrypted SecretStorage when available. The plugin settings contain an opaque secret reference bound to the folder URL and username, and never contain the password. Changing the endpoint or username clears the binding. Remote responses are treated as data and never executed as code.

This desktop plugin uses Node.js filesystem APIs rather than only the Vault API: streaming checksums, exclusive creates, hard-link preservation and disk flushes support exact bytes and interrupted-operation recovery. Those APIs technically permit system-wide file access. Normal plugin operations use the current vault; configured and default exclusion folders and symlinks are skipped. It does not scan other vaults. Development tools accept explicitly specified test paths; use synthetic data under `runtime/` only.

The actual Obsidian configuration directory comes from `Vault.configDir` and is excluded locally and remotely, including custom locations. `.obsidian` remains additionally excluded to protect default/configuration folders copied from other devices. State format **2** and the `.plain-sync/` directory are unchanged; original versions and checkpoints are not automatically deleted. Format 1 requires explicit migration.

Content checks omit only top-level Markdown `updated`, without reformatting other properties or text. In addition to the active configuration directory, exclusions are `.obsidian`, `.claudian`, `.git`, `.sync_state.json`, `.sync_trash`, `.DS_Store`, `.plain-sync`, `.trash` and symlinks.

Existing-file WebDAV changes require a strong ETag and a server that enforces conditional requests. YAML field-level merging, character-level merging, moved-block recognition, directory rename recognition and automatic history cleanup are unsupported.

## Development and verification

Node.js 24+ and pnpm 10.17.0:

```sh
pnpm install --frozen-lockfile
pnpm check:release
pnpm test
pnpm demo
pnpm e2e
```

`pnpm check:release` runs formatting, type checking, community lint, builds, module boundary checks and release checks. `pnpm e2e` requires macOS and Obsidian; it launches a separate profile and synthetic vault under `runtime/`. It does not install into a daily-use vault.

`pnpm build` outputs `dist/vault-content-sync/`. Releases attach only the three files Obsidian installs. Full applicable licenses and development notices are embedded in `main.js`; SHA-256 checksums are in the release notes. A manually triggered GitHub Actions build provides artifact attestations; compare the checksums and verify with `gh attestation verify main.js --repo LLLLAAAA2333/vault-content-sync` (also applicable to the other two files).

- [Contributing](CONTRIBUTING.md)
- [Design and data protection](docs/DESIGN.md)
- [Merge contract](docs/MERGE_CONTRACT.md)
- [Verification](docs/VERIFICATION.md)
- [Scorecard findings and disposition](docs/SCORECARD_REVIEW.md)
- [Progress](PROGRESS.md)

## License and provenance

[MIT License](LICENSE). Applicable dependency licenses and the project's MDSync development origins are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Replacing implementations or starting a new repository does not erase that history or establish community-policy eligibility by itself.
