# Local validation — 2026-10-06 (Europe/Berlin)

The Coding worklog previously failed after exactly 300 seconds. Both the
native page-provider phase and the MCP response-header deadline needed changes.
The fix preserves five-minute individual provider limits and bounds total
provider preparation to 30 minutes. MCP page requests permit 31 minutes for
response headers. Other API requests retain their original transport.

## Source and scope

- Branch: `codex/wiki-embedding-timeout-20261006`, based on `2b5b0ad`.
- Native fix: `eacc923`; MCP follow-up: `21423da`.
- No Wiki `main` merge or push. The existing canonical working changes remain
  untouched. The app validation tree includes the already deployed isolated
  runtime and internal-wiki watcher exclusions from the upgrade workspace.
- The Codex connector startup path now points to `/Applications/LLM Wiki.app`
  instead of the older SSD app bundle. Existing processes retain loaded code;
  the live check below starts a fresh connector using Node 24.20.0.

## Tests

- 12 existing native orchestration tests passed before the change.
- Two progressing-provider regressions reproduced the old 300-second cutoff;
  the aggregate-budget test also failed at 300 instead of 1800 seconds.
- All 17 Rust tests then passed. Provider and storage are deterministic doubles
  in this fast suite; it does not prove LanceDB or HTTP behavior by itself.
- MCP delayed-loopback-response regression failed before the transport fix.
  All 41 MCP tests passed afterward, including ordinary-request timeout retention.
- The 18 API tests also passed on the actual Node 24.20.0 runtime. Node 26.3.1
  was used for the complete MCP suite. Node 20 was not runtime-tested.
- TypeScript compilation, Rust formatting and Git whitespace checks passed.
- One independent review per successive code diff found no actionable issues.
  The MCP review additionally checked same-origin authorization retention,
  cross-origin authorization removal, redirects and dispatcher selection on
  Node 24 and 26. Those extra review checks used in-memory responses.

## Live reproduction

A fresh bundled MCP process called `llm_wiki_embed_page` for
`Coding/wiki/codex-worklog.md`, then polled `llm_wiki_embedding_status`.
The 1,744,659-byte page completed after about 506 seconds of server processing:
1,133 chunks and 1,133 vectors, status `indexed`. The resulting SHA-256 revision
matched the on-disk page at completion. This crosses both previous 300-second
cutoffs using the actual local Ollama provider and LanceDB storage.
See [the recorded result](evidence/2026-10-06-live-index.json).

## App packaging

Use the embedded frontend when building the installed app:

```sh
CARGO_BUILD_JOBS=1 RAYON_NUM_THREADS=1 cargo rustc \
  --manifest-path src-tauri/Cargo.toml --release --offline \
  --bin llm-wiki --features tauri/custom-protocol -- -C lto=off
```

The plain release build passed, but a window check found it still selected the
absent development server. A build with `tauri/custom-protocol` is required.
The production-mode rebuild passed after 225 seconds in a detached, tracked
build process (the preceding terminal-bound attempt received SIGTERM).
Strict bundle signature verification passed. The installed binary SHA-256 is
`0a5a99ea8b590bab148a10baa03d8513d09af560cabc2f62fdfa4d900facbc7f`.
A native accessibility check confirmed the rendered app at `tauri://localhost`,
including its sidebar and existing source-ingest queue. Existing Claude quota
errors in that queue are outside this indexing fix and were left unchanged.
The new app API reported version 0.6.12 and healthy status.
Old backup executables were removed only from the new bundle copy before
strict signing verification; the original full bundle remains preserved.
Rollback bundle: `/Applications/.LLM-Wiki-before-embedding-20261006.app`.

## Security diff coverage

Both exact diffs completed the Codex Security workflow with no reportable
findings: `cc68f54c-7320-4abe-a3da-7487dc2a2cee` and
`a742522d-586a-4fbc-964e-9b92c212c854`. Coverage is limited to the changed files
and their supporting request, cancellation, credential and storage boundaries.
This is not a repository-wide or dependency vulnerability audit.
Plugin token accounting (including cached input): 861,059 total / 830,336 cached
for the native scan; 459,813 total / 449,024 cached for the MCP follow-up.
