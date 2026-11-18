# Vault Content Sync

[中文说明](README.zh-CN.md) · [Community listing](https://community.obsidian.md/plugins/vault-content-sync)

Compare notes and attachments in your Obsidian vault with a WebDAV folder by their content. Inspect conflicts and use a conservative line-level three-way merge when a common version exists. The local Markdown top-level `updated` field stays local; other properties and content are compared.

**Published 0.5.0 is experimental. Its external WebDAV connections provide read-only previews.** Uploads, downloads, applying conflict choices and recovery are only enabled for the bundled localhost simulation. Nothing connects or syncs automatically. The plugin has a public community listing; see its current scorecard for automated review results.

Version 0.5.0 adds a **Test connection** action in settings, a compact source-control sidebar, and a read-only comparison tab in the main editor. Quick conflict previews are available on demand.

**Unreleased working tree:** the settings now use one masked password field and a **记住密码** (remember password) switch. The default remains session-only. Remembered passwords use Obsidian's encrypted local secret storage; no secret picker is required. Missing passwords and HTTP 401 now show a single authentication message instead of marking every file unverified. These changes are not in the published 0.5.0 assets.

## Development version 0.6.1

The current development build supports real WebDAV upload, download, guarded deletion, explicit local/remote conflict choices, conservative merging and interrupted-operation recovery. The published 0.5.0 behavior described above is unchanged. Use **验证并开启同步** in the sidebar or settings: it creates a new excluded synthetic directory, checks exclusive collection locks, strong validators, conditional writes and interrupted uploads, then enables this connection for this session. It does not synchronize notes. Verification is revoked on restart or connection/credential changes. Unsupported servers remain preview-only; this is not universal WebDAV compatibility.

The sidebar now uses a Zed-style arrangement: changes and tools above, a scrollable file area, and a pinned remote/status/sync footer. Verify content, inspect the plan, then confirm **同步全部** or a file's **同步此文件** action. Conflicts and unfinished operations are handled separately. No commit-message box or Git history is implied.

See [WebDAV synchronization and isolated validation](docs/WEBDAV_SYNC.md). This development build was tested against a separately launched local Apache mod_dav_fs service; the capability check must also pass on your own server before writing.

## Features

- Verify original file bytes and shared content separately, without relying on modification times.
- Inspect differences and conflicts across notes, YAML metadata and attachments.
- Preserve line endings, BOM, unchanged content and the local `updated` field.
- Merge independent line edits; stop on overlapping edits, ambiguous alignment or resource limits.
- Retain original versions and check preconditions before writes; recover interrupted operations.
- Treat failed reads as unknown, never as a missing file. Different content without a common baseline is not automatically merged.

## Install and use

In the unreleased working build, clearing an edited saved password and leaving the field (or closing settings) removes its saved reference. Failed settings saves are reported and keep the previous committed configuration. Failed operations discard the old preview; verify again before continuing.

Requires **Obsidian desktop 1.14.4+**. App testing has been performed on macOS only; mobile is unsupported. Start in an **isolated test vault**.

1. Open the [community listing](https://community.obsidian.md/plugins/vault-content-sync) and choose **Add to Obsidian**, targeting your isolated test vault. Alternatively, download `main.js`, `manifest.json` and `styles.css` from the same [GitHub Release](https://github.com/LLLLAAAA2333/vault-content-sync/releases), and place them in `<your-config-directory>/plugins/vault-content-sync/` in that test vault.
2. Enable **Vault Content Sync** in Community plugins and open its settings. Setting labels are currently in Chinese; they also have English search keywords such as `WebDAV`, `username` and `password`.
3. Enter the exact WebDAV **HTTPS folder URL**, then your service username and password separately. Use your own WebDAV account if required. No Vault Content Sync account or paid plan is required.
4. Click **测试连接** (test connection) in plugin settings. It checks only the configured directory, with a 15-second deadline and a 64 KiB response limit; it does not read notes or create sync state. Click the ribbon icon or run **查看文件变化** (development; **完整核验并预览** in released 0.5.0), then the refresh icon **核验内容** (verify content). The first preview compares both sides without creating a sync baseline or changing files.
5. The preview opens in the left sidebar. Conflicts, local changes and remote changes are collapsible groups; the filter icon reveals filename/path and status filters. Click a filename to open a read-only local/remote comparison in the main editor. The eye icon opens optional conflict fragments in the sidebar; they start collapsed. File actions appear on hover or keyboard focus and in the context menu. Connection tests stay in settings; content rules are documented below. Without a common version, the interface explicitly shows two content previews rather than claiming to locate conflicting lines. Writes require a successful server capability check and confirmation of the planned operation.

In the current development build, refresh uses session-only incremental verification. The first refresh after loading the plugin reads all in-scope files. Later refreshes still list directories, but unchanged local file stamps reuse digests and remote conditional GETs can return 304 without transferring bodies. A request per remote file remains necessary; missing/weak validators or ignored conditions fall back to body reads. Choose **更多操作 → 完整核验所有文件**, or the command of the same name, to bypass the cache. The summary tooltip reports reused entries and bytes actually read. Testing the connection alone does not read notes. Published 0.5.0 always reads full contents. Redirects are not followed. URLs with embedded credentials, query parameters or fragments are rejected and not saved. In published 0.5.0, re-enter the password after disabling the plugin or restarting Obsidian. In development builds, enable **记住密码** after entering it to restore it next time; leave the switch off for session-only use. The password field masks its value and blocks copy/cut. Editing a remembered password saves it when you leave the field.

## Network, storage and permissions

The plugin contacts only your configured WebDAV endpoint to compare files and apply confirmed changes. It has no telemetry, advertisements or project-operated service. HTTP is accepted only for localhost testing; external connections require HTTPS. HTTP Basic authentication uses base64 encoding for the username/password header, not to hide executable code. The bundled YAML parser also includes base64 handling for YAML binary values; those values are data, not scripts.

The endpoint and username are saved using Obsidian's plugin settings API. Saved settings cannot grant write access, including on localhost. The development version also saves the password mode, an opaque secret reference and a connection binding; it never puts the password itself in `data.json`. The encrypted storage entry is bound to the folder URL and username. After upgrading from a development build with an older saved entry, check the address and re-enter the password once. Session-only passwords stay in memory. The optional remembered value is stored locally through Obsidian SecretStorage when host encryption is available. Switching it off clears the plugin-owned saved value when the store is accessible. Changing the endpoint or username clears the active credential binding; re-enter the password. Masking/copy restrictions are an interface choice, not protection from other enabled plugins or someone controlling the app. Published 0.5.0 only supports session passwords. Remote responses are treated as data, never executed as code.

This desktop plugin uses Node.js filesystem APIs rather than only the Vault API: streaming checksums, exclusive creates, hard-link preservation and disk flushes support exact bytes and interrupted-operation recovery. Those APIs technically permit system-wide file access. Normal plugin operations use the current vault; configured and default exclusion folders and symlinks are skipped. It does not scan other vaults. Development tools accept explicitly specified test paths; use synthetic data under `runtime/` only.

The actual Obsidian configuration directory comes from `Vault.configDir` and is excluded locally and remotely, including custom locations. `.obsidian` remains additionally excluded to protect default/configuration folders copied from other devices. State format **2** and the `.plain-sync/` directory are unchanged; original versions and checkpoints are not automatically deleted. Format 1 requires explicit migration.

Content checks omit only top-level Markdown `updated`, without reformatting other properties or text. In addition to the active configuration directory, exclusions are `.obsidian`, `.claudian`, `.git`, `.sync_state.json`, `.sync_trash`, `.DS_Store`, `.plain-sync`, `.trash` and symlinks.

Servers that do not pass the lock and conditional-write checks remain preview-only. Other limitations include YAML field-level merging, character-level merging, moved-block recognition, directory rename recognition and automatic history cleanup.

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
