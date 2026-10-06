//! Compile the production page-indexing orchestration without the desktop UI.
//! Provider latency and storage are deterministic test doubles; time is virtual.
#![allow(dead_code)]
#[path = "../../src-tauri/src/commands/page_embedding.rs"]
mod page_embedding;

mod search {
    use std::{collections::BTreeMap, time::Duration};
    #[derive(Clone)]
    pub struct SearchEmbeddingConfig {
        pub enabled: bool,
        pub endpoint: String,
        pub api_key: String,
        pub model: String,
        pub output_dimensionality: Option<f64>,
        pub extra_headers: Option<BTreeMap<String, String>>,
        pub max_chunk_chars: Option<usize>,
        pub overlap_chunk_chars: Option<usize>,
        pub batch_size: Option<usize>,
    }
    pub fn supports_embedding_batch(config: &SearchEmbeddingConfig) -> bool {
        config.endpoint != "single"
    }
    pub async fn fetch_embedding_batch(
        texts: &[String],
        config: &SearchEmbeddingConfig,
    ) -> Result<Vec<Vec<f32>>, String> {
        tokio::time::sleep(Duration::from_secs(config.model.parse().unwrap())).await;
        Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
    }
    pub async fn fetch_embedding_with_retry(
        text: &str,
        config: &SearchEmbeddingConfig,
        _: usize,
    ) -> Result<Vec<f32>, String> {
        Ok(fetch_embedding_batch(&[text.into()], config)
            .await?
            .remove(0))
    }
}

mod vectorstore {
    use std::{fs, path::Path};
    pub struct ChunkUpsertInput {
        pub chunk_index: u32,
        pub chunk_text: String,
        pub heading_path: String,
        pub embedding: Vec<f32>,
    }
    pub fn validate_page_id_for_v2(_: &str) -> Result<(), String> {
        Ok(())
    }
    pub async fn vector_page_revision_match(
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Option<usize>, String> {
        Ok(None)
    }
    pub async fn vector_upsert_chunks_with_revision(
        root: &str,
        _: &str,
        rows: Vec<ChunkUpsertInput>,
        _: &str,
    ) -> Result<(), String> {
        assert!(rows
            .iter()
            .enumerate()
            .all(|(i, row)| row.chunk_index as usize == i));
        fs::write(Path::new(root).join("stored-index"), rows.len().to_string())
            .map_err(|e| e.to_string())
    }
    pub async fn vector_delete_page(_: String, _: String) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod regression {
    use super::{
        page_embedding::{embed_wiki_page, PageEmbeddingErrorKind},
        search::SearchEmbeddingConfig,
    };
    use std::{fs, path::PathBuf, time::Duration};
    struct Project(PathBuf);
    impl Project {
        fn new(sections: usize) -> Self {
            let root =
                std::env::temp_dir().join(format!("wiki-timeout-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("wiki")).unwrap();
            let content = (0..sections)
                .map(|i| format!("# Section {i}\n\nA separate paragraph for section {i}.\n\n"))
                .collect::<String>();
            fs::write(root.join("wiki/test-page.md"), content).unwrap();
            fs::write(root.join("stored-index"), "previous-index").unwrap();
            Self(root)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn stored(&self) -> String {
            fs::read_to_string(self.0.join("stored-index")).unwrap()
        }
    }
    impl Drop for Project {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn config(batch: bool, delay: u64) -> SearchEmbeddingConfig {
        SearchEmbeddingConfig {
            enabled: true,
            endpoint: if batch { "batch" } else { "single" }.into(),
            api_key: String::new(),
            model: delay.to_string(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: Some(1000),
            overlap_chunk_chars: Some(0),
            batch_size: Some(1),
        }
    }
    async fn progressing_page(batch: bool) {
        let project = Project::new(40);
        let started = tokio::time::Instant::now();
        let result = embed_wiki_page(
            project.path(),
            "wiki/test-page.md",
            config(batch, 10),
            false,
        )
        .await;
        assert!(
            result.is_ok(),
            "A provider making progress must finish this large page: {result:?}"
        );
        let result = result.unwrap();
        assert!(started.elapsed() > Duration::from_secs(300));
        assert_eq!(result.chunks, 40);
        assert_eq!(result.vectors_written, 40);
        assert_eq!(project.stored(), "40");
    }
    #[tokio::test(start_paused = true)]
    async fn progressing_batches_can_finish_after_five_minutes() {
        progressing_page(true).await;
    }
    #[tokio::test(start_paused = true)]
    async fn progressing_single_requests_can_finish_after_five_minutes() {
        progressing_page(false).await;
    }
    async fn stalled_request(batch: bool) {
        let project = Project::new(2);
        let started = tokio::time::Instant::now();
        let error = embed_wiki_page(
            project.path(),
            "wiki/test-page.md",
            config(batch, 301),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, PageEmbeddingErrorKind::Timeout);
        assert_eq!(started.elapsed(), Duration::from_secs(300));
        assert_eq!(project.stored(), "previous-index");
    }
    #[tokio::test(start_paused = true)]
    async fn stalled_batch_keeps_previous_index() {
        stalled_request(true).await;
    }
    #[tokio::test(start_paused = true)]
    async fn stalled_single_request_keeps_previous_index() {
        stalled_request(false).await;
    }
    #[tokio::test(start_paused = true)]
    async fn total_budget_still_bounds_progressing_work() {
        let project = Project::new(181);
        let started = tokio::time::Instant::now();
        let error = embed_wiki_page(project.path(), "wiki/test-page.md", config(true, 10), false)
            .await
            .unwrap_err();
        assert_eq!(error.kind, PageEmbeddingErrorKind::Timeout);
        assert_eq!(started.elapsed(), Duration::from_secs(1800));
        assert_eq!(project.stored(), "previous-index");
    }
}
