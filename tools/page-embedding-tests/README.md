# Page embedding timeout regression tests

Run `cargo test --offline --manifest-path tools/page-embedding-tests/Cargo.toml`.

This small Rust crate imports the production `page_embedding.rs` unchanged.
It uses a deterministic provider and storage double with paused Tokio time so
40 successful ten-second requests can exercise the old five-minute cutoff
without waiting. It covers both batch-capable and single-input providers,
stalled requests, the total 30-minute limit, ordered rows and preservation of
the previous index on failure. It also runs the page module's existing tests.

The doubles do not verify real HTTP timeout behavior or LanceDB transactions;
those require the application build and a local provider integration check.
No Wiki content or credentials are fixtures.
