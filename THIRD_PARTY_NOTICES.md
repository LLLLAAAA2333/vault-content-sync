# Third-party notices

## Packaged libraries

- `@jest/diff-sequences` 30.5.0: MIT; bundled license is `LICENSE-Jest`.
- `yaml` 2.9.0: ISC; bundled license is `LICENSE-yaml`.
- Obsidian provides the host API; it is not bundled.

## Development provenance

Vault Content Sync starts from the current code snapshot of [the earlier experimental project](https://github.com/LLLLAAAA2333/obsidian-content-sync), originally developed from [MDSync](https://github.com/k1tbyte/mdsync). The earlier framework and identified derived merge implementations/tests were removed or replaced before this snapshot; there is no MDSync runtime or build dependency. This is not a strict clean-room authorship claim.

The original k1tbyte MIT notice remains in [LICENSE](LICENSE). Earlier commits and detailed historical records remain in the previous repository; they are not part of this repository's Git history.

The subsequent compact preview redesign uses MDSync screenshots as a visual reference for status, toolbar and grouped-file-list hierarchy. Its Obsidian UI and styles were implemented in this repository; no MDSync UI source was copied for that redesign. The development provenance and existing license notices above still apply.

The later sidebar and main-editor comparison layout references the public VS Code source-control and Zed Git documentation/screenshots for interaction patterns. This UI is implemented with Obsidian host components and local styles; no editor UI source or image assets are bundled. Earlier development provenance is unchanged.
