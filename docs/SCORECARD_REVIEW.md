# 0.4.1 scorecard audit and 0.4.2 response

Observed on 2026-11-11 at the [public community scorecard](https://community.obsidian.md/plugins/vault-content-sync#scorecard), for release 0.4.1, source `02cc73d2eedf588b8c9c5eeccc6c806856d02adc`. The page reported **35 issues: 32 warnings and 3 other findings**. Its five disclosures were separate from that total. The following line references are to that original commit, so findings remain traceable after edits.

## All 35 findings

| # | Original finding / location | 0.4.2 disposition |
| --- | --- | --- |
| 1 | Unsafe assignment, register.ts:12 | `loadData()` enters as `unknown`; `loadSettings` validates the container and field types. |
| 2 | Unsafe assignment, register.ts:18 | Username is narrowed to string, otherwise empty. |
| 3 | Unsafe assignment, model.ts:126 | Typed empty prototype-free dictionary for scan files. |
| 4 | Unsafe assignment, model.ts:129 | Typed empty prototype-free dictionary for scan errors. |
| 5 | Unsafe assignment, state.ts:23 | Typed empty baseline dictionary. |
| 6 | Unsafe assignment, state.ts:24 | Typed empty pending dictionary. |
| 7 | Unsafe assignment, state.ts:35 | Same typed baseline construction when no checkpoint exists. |
| 8 | Unsafe assignment, state.ts:36 | Same typed pending construction when no checkpoint exists. |
| 9 | Unsafe assignment, state.ts:38–40 | Parsed JSON enters as `unknown`; `checkpoint` validates every used field before recovery. |
| 10 | Unsafe assignment, state.ts:78 | Validated baseline values copied into typed prototype-free map. |
| 11 | Unsafe assignment, state.ts:79 | Validated intents copied into typed prototype-free map. |
| 12 | Unsafe member access, register.ts:17 | Record guard before reading saved URL. |
| 13 | Unsafe member access, register.ts:18 (type check) | Record guard before username type check. |
| 14 | Unsafe member access, register.ts:18 (value) | Read username only after narrowing. |
| 15 | Unsafe member access, register.ts:19 | Record guard; mock mode requires boolean `true`. |
| 16 | Unsafe member access, files.ts:75 | Rejected value is `unknown`; `hasErrorCode` checks it. |
| 17 | Unsafe member access, files.ts:97 | Same guard for missing file; unrelated failures propagate. |
| 18 | Unsafe member access, files.ts:129 | `byteChunks` validates stream data before reading byte length. |
| 19 | Unsafe member access, files.ts:190 | Same error-code guard for concurrent directory creation. |
| 20 | Unsafe member access, state.ts:89 | Same error-code guard for journal directory creation. |
| 21 | Unsafe member access, webdav.ts:60 | Validated byte chunks before enforcing response size budget. |
| 22 | Unsafe argument, files.ts:59 | Digest consumes validated bytes, rejecting object-mode values. |
| 23 | Unsafe argument, files.ts:131 | Text buffering consumes validated bytes. |
| 24 | Unsafe argument, local-version.ts:21 | Local updated extraction consumes validated bytes. |
| 25 | Unsafe argument, local-version.ts:32 | Shared-content transform consumes validated bytes. |
| 26 | Unsafe argument, webdav.ts:65 | DAV response buffering consumes validated bytes. |
| 27 | Direct filesystem access | **Retained and disclosed.** Exact-byte streams, exclusive creates, hard-link preservation and fsync are part of current desktop recovery design. Normal entry point gets the current vault root; path traversal, symlink and config-directory tests remain. Node filesystem APIs themselves are not sandboxed. No claim that this warning will disappear. |
| 28 | Hardcoded `.obsidian`, model.ts:3 | **Retained with explanation, not suppressed.** This is an extra exclusion, not the active configuration location. `register.ts` passes actual `Vault.configDir` to both stores. Custom/nested directory and missing-old-baseline tests verify the real behavior. Deleting this exclusion would expose default config folders copied from another device. |
| 29 | Global setTimeout, webdav.ts:36 | Explicit `node:timers.setTimeout`: the deadline belongs to the Node HTTP request, independent of a UI window or popout. |
| 30 | Global clearTimeout, webdav.ts:41 | Matching Node timer cancellation on request close; deadline duration and behavior unchanged. |
| 31 | Missing getSettingDefinitions, view.ts:282 | Migrated to real declarative definitions with names and search aliases. Render callbacks preserve URL validation and session-only password handling. Old display override removed. |
| 32 | README not English | English primary README, Chinese translation, community listing and current limitations. Removed obsolete “not yet listed” claim. |
| 33 | Missing main.js attestation | Manual GitHub Actions build attests the actual output; release procedure verifies it and compares it with isolated-tested local bytes before publishing. |
| 34 | Missing styles.css attestation | Same workflow and verification, also covering manifest.json. |
| 35 | Unsupported release files | New release attaches only main.js, manifest.json and styles.css. Full licenses remain embedded in main.js; checksums move to release notes. Prior release and history remain unchanged. |

## Five disclosures and other page observations

- One network call site: Node HTTP(S) transport for the user-configured WebDAV endpoint. No project server or telemetry; no redirects. Preserved and documented.
- Runtime base64 (`atob`/`btoa`): included by `yaml`'s binary scalar implementation (`yaml/dist/schema/yaml-1.1/binary.js`). Our transport separately uses `Buffer` base64 for Basic authentication. Neither is code execution or a hidden endpoint; do not delete required parsing/authentication code to alter a scanner result.
- Malware scan unavailable, obfuscation scan unavailable, network-request scan unavailable: these three are platform scan availability disclosures, not locally repairable source defects. No replacement claim of a clean malware scan is made.
- The Health card mentioned a missing contribution guide; added `CONTRIBUTING.md` with synthetic-data, test and release guidance.
- Previous passes: no known vulnerable production dependencies; reproducible main.js. Continue verifying both for the new release.

## Validation and limits

The pinned official `eslint-plugin-obsidianmd` recommended rules run via `pnpm lint:community`, including typed checks. No source rule was disabled or warning hidden. Its one remaining warning is item 28; filesystem capability and attestation findings are outside this local lint check. Local success does not predict the exact count or grade of the community's next scan.

The 130 existing unit cases are retained. Twenty added cases cover malformed settings/checkpoints, field-level recovery validation, prototype-free dictionaries, bad stream chunks and safe error handling. A corrupt checkpoint leaves notes, remote data and the existing checkpoint unchanged (recovery may create empty journal subdirectories while acquiring its lock). The isolated app test now renders actual declarative settings, verifies indexed names/aliases, refuses a credential-bearing URL, and checks that saving settings does not persist the password or contact WebDAV. See [verification](VERIFICATION.md).

State format 2, `.plain-sync`, merge behavior and the external-write gate are unchanged. No daily-use vault was accessed or modified. Source provenance and applicable licenses are retained. The public listing and automated scorecard do not by themselves establish a separate human policy or provenance approval.

## References

- [Obsidian declarative settings migration](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [Original 0.4.1 source](https://github.com/LLLLAAAA2333/vault-content-sync/tree/02cc73d2eedf588b8c9c5eeccc6c806856d02adc)
