# Desktop instance guard tests

On macOS, run `cargo test --manifest-path tools/single-instance-tests/Cargo.toml`.
This small harness tests the same module used by the Tauri application without
linking the webview and vector-database dependencies.

The macOS guard keeps an advisory file lock for the primary process lifetime.
Its focus socket lives in a mode-0700 directory under the application's data
directory, verifies peer UID, and transmits no launch arguments or paths.
Startup fails closed if ownership or the notification channel cannot be verified.
The lock file is never unlinked, including during normal shutdown.

Coverage: twelve concurrent claims with exactly one owner, notification without
payload, restart/stale socket recovery, and rejection of unsafe permissions and
symlinks. The installed app also needs a real second-launch/focus smoke test.
Windows/Linux use the official single-instance plugin and require native tests
on those platforms before claiming platform-specific runtime verification.
