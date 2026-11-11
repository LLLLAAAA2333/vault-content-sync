# Vault Content Sync

[中文说明](README.zh-CN.md) · [Community listing](https://community.obsidian.md/plugins/vault-content-sync)

Compare notes and attachments in your Obsidian vault with a WebDAV folder by their content. Inspect conflicts and use a conservative line-level three-way merge when a common version exists. The local Markdown top-level `updated` field stays local; other properties and content are compared.

**0.4.2 is experimental. External WebDAV connections provide read-only previews.** Uploads, downloads, applying conflict choices and recovery are only enabled for the bundled localhost simulation. Nothing connects or syncs automatically. The plugin has a public community listing; see its current scorecard for automated review results.

## Features

- Verify original file bytes and shared content separately, without relying on modification times.
- Inspect differences and conflicts across notes, YAML metadata and attachments.
- Preserve line endings, BOM, unchanged content and the local `updated` field.
- Merge independent line edits; stop on overlapping edits, ambiguous alignment or resource limits.
- Retain original versions and check preconditions before simulated writes; recover interrupted operations.
- Treat failed reads as unknown, never as a missing file. Different content without a common baseline is not automatically merged.

## Install and use

Requires **Obsidian desktop 1.14.4+**. App testing has been performed on macOS only; mobile is unsupported. Start in an **isolated test vault**.

1. Open the [community listing](https://community.obsidian.md/plugins/vault-content-sync) and choose **Add to Obsidian**, targeting your isolated test vault. Alternatively, download `main.js`, `manifest.json` and `styles.css` from the same [GitHub Release](https://github.com/LLLLAAAA2333/vault-content-sync/releases), and place them in `<your-config-directory>/plugins/vault-content-sync/` in that test vault.
2. Enable **Vault Content Sync** in Community plugins and open its settings. Setting labels are currently in Chinese; they also have English search keywords such as `WebDAV`, `username` and `password`.
3. Enter the exact WebDAV **HTTPS folder URL**, then your service username and password separately. Use your own WebDAV account if required. No Vault Content Sync account or paid plan is required.
4. Click the ribbon icon or run **完整核验并预览** (verify and preview), then **完整核验 / 刷新预览** (refresh). The first preview compares both sides without creating a sync baseline or changing files.
5. Use **比较内容** to inspect a conflict. External connections cannot execute uploads, downloads, merge applications or recovery. The **隔离模拟服务写入** setting only enables writes to the localhost test service.

Verification reads all in-scope file contents, so large folders take time. Redirects are not followed. URLs with embedded credentials, query parameters or fragments are rejected and not saved. Re-enter the password after disabling the plugin or restarting Obsidian.

## Network, storage and permissions

The plugin contacts only your configured WebDAV endpoint to list and read files. It has no telemetry, advertisements or project-operated service. HTTP is accepted only for localhost testing; external connections require HTTPS. HTTP Basic authentication uses base64 encoding for the username/password header, not to hide executable code. The bundled YAML parser also includes base64 handling for YAML binary values; those values are data, not scripts.

The endpoint, username and mock-mode preference are saved using Obsidian's plugin settings API. The password stays in memory for the plugin session and is not saved. Remote responses are treated as data, never executed as code.

This desktop plugin uses Node.js filesystem APIs rather than only the Vault API: streaming checksums, exclusive creates, hard-link preservation and disk flushes support exact bytes and interrupted-operation recovery. Those APIs technically permit system-wide file access. Normal plugin operations use the current vault; configured and default exclusion folders and symlinks are skipped. It does not scan other vaults. Development tools accept explicitly specified test paths; use synthetic data under `runtime/` only.

The actual Obsidian configuration directory comes from `Vault.configDir` and is excluded locally and remotely, including custom locations. `.obsidian` remains additionally excluded to protect default/configuration folders copied from other devices. State format **2** and the `.plain-sync/` directory are unchanged; original versions and checkpoints are not automatically deleted. Format 1 requires explicit migration.

External conditional-write and concurrency guarantees have not been verified, so external writes remain disabled. Other limitations include YAML field-level merging, character-level merging, moved-block recognition, directory rename recognition and automatic history cleanup.

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
