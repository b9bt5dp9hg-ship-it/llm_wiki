//! Project-local graph links. Shared fixtures in the TS resolver test the same
//! lookup contract; this module has no Tauri, filesystem or runtime dependency.
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiGraphNode {
    pub id: String,
    pub label: String,
    pub node_type: String,
    pub path: String,
    pub link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiGraphEdge {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

pub(crate) struct GraphPage {
    pub path: String,
    pub label: String,
    // Keep unreadable inventory entries for the same identity/ambiguity rules
    // as the reader, while excluding them from graph nodes and edges.
    pub content: Option<String>,
}

#[derive(Default)]
struct LinkIndex {
    paths: [BTreeMap<String, Option<usize>>; 4],
    stems: [BTreeMap<String, Option<usize>>; 4],
}

// Match JavaScript's whitespace normalization, including BOM but excluding NEL.
fn link_whitespace(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

fn keys(raw: &str) -> [String; 4] {
    let nfc: String = raw.nfc().collect();
    let lower = nfc.to_lowercase();
    let mut hyphenated = String::new();
    let mut was_whitespace = false;
    for c in lower.chars() {
        let whitespace = link_whitespace(c);
        if !whitespace {
            hyphenated.push(c);
        } else if !was_whitespace {
            hyphenated.push('-');
        }
        was_whitespace = whitespace;
    }
    [raw.to_string(), nfc, lower, hyphenated]
}

fn insert_alias(maps: &mut [BTreeMap<String, Option<usize>>; 4], raw: &str, index: usize) {
    for (map, key) in maps.iter_mut().zip(keys(raw)) {
        map.entry(key)
            .and_modify(|found| {
                if *found != Some(index) {
                    *found = None;
                }
            })
            .or_insert(Some(index));
    }
}

fn clean_target(raw: &str) -> Option<(String, bool)> {
    let raw = raw.trim_matches(link_whitespace);
    let raw = raw
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(raw);
    let raw = raw
        .split('|')
        .next()?
        .split('#')
        .next()?
        .trim_matches(link_whitespace)
        .replace('\\', "/");
    let has_scheme = raw.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if raw.is_empty()
        || raw.starts_with('/')
        || has_scheme
        || raw.contains('\0')
        || raw.split('/').any(|part| part == "..")
    {
        return None;
    }
    let explicit_path = raw.contains('/');
    let path = raw
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    let path = strip_wiki_prefix(&path);
    let path = without_markdown_extension(path).to_string();
    if path.is_empty() {
        None
    } else {
        Some((path, explicit_path))
    }
}

fn strip_wiki_prefix(path: &str) -> &str {
    if path
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("wiki/"))
    {
        &path[5..]
    } else {
        path
    }
}

fn without_markdown_extension(path: &str) -> &str {
    let suffix = path.len().saturating_sub(3);
    if path
        .get(suffix..)
        .is_some_and(|s| s.eq_ignore_ascii_case(".md"))
    {
        &path[..suffix]
    } else {
        path
    }
}

impl LinkIndex {
    fn insert(&mut self, path: &str, index: usize) {
        insert_alias(&mut self.paths, path, index);
        insert_alias(
            &mut self.stems,
            path.rsplit('/').next().unwrap_or(path),
            index,
        );
    }

    fn resolve(&self, raw: &str) -> Option<usize> {
        let (target, explicit_path) = clean_target(raw)?;
        let maps = if explicit_path {
            &self.paths
        } else {
            &self.stems
        };
        for (map, key) in maps.iter().zip(keys(&target)) {
            // An ambiguous match at a stronger rank must not fall through.
            if let Some(found) = map.get(&key) {
                return *found;
            }
        }
        None
    }
}

fn frontmatter(content: &str) -> Option<Yaml> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    // Match the reader's existing recovery window: LLM output may prepend
    // "frontmatter:" or a YAML code fence, but a later body divider is not
    // frontmatter. Only the opening fence is limited to the first six lines.
    let fence = |line: &str| {
        line.strip_prefix("---")
            .is_some_and(|rest| rest.trim_matches(link_whitespace).is_empty())
    };
    let mut opened = false;
    for _ in 0..6 {
        if fence(lines.next()?) {
            opened = true;
            break;
        }
    }
    if !opened {
        return None;
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if fence(line) {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return None;
    }
    let mut documents = YamlLoader::load_from_str(&yaml).ok()?;
    if documents.len() != 1 {
        return None;
    }
    let document = documents.pop()?;
    document.as_hash()?;
    Some(document)
}

fn wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let target = rest[..end].trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

pub(crate) fn build_graph_pages(pages: Vec<GraphPage>) -> (Vec<ApiGraphNode>, Vec<ApiGraphEdge>) {
    let mut pages: Vec<_> = pages
        .into_iter()
        .filter_map(|page| {
            let metadata = page.content.as_deref().and_then(frontmatter);
            let node_type = metadata
                .as_ref()
                .and_then(|m| m["type"].as_str())
                .unwrap_or("other")
                .trim()
                .to_lowercase();
            let normalized_path = page.path.replace('\\', "/");
            let relative = strip_wiki_prefix(&normalized_path);
            if relative.starts_with('/')
                || relative
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return None;
            }
            let path = without_markdown_extension(relative).to_string();
            let mut links = page.content.as_deref().map(wikilinks).unwrap_or_default();
            if let Some(metadata) = metadata {
                match &metadata["related"] {
                    Yaml::Array(items) => {
                        links.extend(items.iter().filter_map(Yaml::as_str).map(str::to_owned))
                    }
                    Yaml::String(link) => links.push(link.clone()),
                    _ => {}
                }
            }
            Some((page, path, node_type, links))
        })
        .collect();
    pages.sort_by(|a, b| a.1.cmp(&b.1));
    let visible: Vec<bool> = pages
        .iter()
        .map(|(page, _, node_type, _)| page.content.is_some() && node_type != "query")
        .collect();
    let mut stem_counts = BTreeMap::<String, usize>::new();
    for (_, path, _, _) in &pages {
        *stem_counts
            .entry(path.rsplit('/').next().unwrap_or(path).nfc().collect())
            .or_default() += 1;
    }
    let mut index = LinkIndex::default();
    let mut nodes = Vec::new();
    for (position, (page, path, node_type, _)) in pages.iter().enumerate() {
        let stem = path.rsplit('/').next().unwrap_or(path);
        let id = if stem_counts[&stem.nfc().collect::<String>()] == 1 {
            stem
        } else {
            path
        };
        index.insert(path, position);
        nodes.push(ApiGraphNode {
            id: id.to_string(),
            label: page.label.clone(),
            node_type: node_type.clone(),
            path: page.path.clone(),
            link_count: 0,
        });
    }
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, (_, _, _, links)) in pages.iter().enumerate() {
        if !visible[source] {
            continue;
        }
        for raw in links {
            let Some(target) = index.resolve(raw) else {
                continue;
            };
            if source == target || !visible[target] {
                continue;
            }
            if seen.insert((source.min(target), source.max(target))) {
                nodes[source].link_count += 1;
                nodes[target].link_count += 1;
                edges.push(ApiGraphEdge {
                    source: nodes[source].id.clone(),
                    target: nodes[target].id.clone(),
                    weight: 1.0,
                });
            }
        }
    }
    nodes = nodes
        .into_iter()
        .enumerate()
        .filter_map(|(i, node)| visible[i].then_some(node))
        .collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    (nodes, edges)
}

/// Degrees describe exactly the returned graph, including API search/limit cuts.
pub(crate) fn retain_edges_and_recount(
    nodes: &mut [ApiGraphNode],
    edges: Vec<ApiGraphEdge>,
) -> Vec<ApiGraphEdge> {
    let positions: BTreeMap<_, _> = nodes
        .iter_mut()
        .enumerate()
        .map(|(i, n)| {
            n.link_count = 0;
            (n.id.clone(), i)
        })
        .collect();
    edges
        .into_iter()
        .filter(
            |edge| match (positions.get(&edge.source), positions.get(&edge.target)) {
                (Some(&source), Some(&target)) => {
                    nodes[source].link_count += 1;
                    nodes[target].link_count += 1;
                    true
                }
                _ => false,
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_fixture(pages: &[(&str, &str)]) -> (Vec<ApiGraphNode>, Vec<ApiGraphEdge>) {
        build_graph_pages(
            pages
                .iter()
                .map(|(path, content)| GraphPage {
                    path: format!("wiki/{path}"),
                    label: path.to_string(),
                    content: Some(content.to_string()),
                })
                .collect(),
        )
    }

    #[test]
    fn graph_exact_case_wins_but_ambiguous_normalization_is_unresolved() {
        let (_, exact) = graph_fixture(&[
            ("start.md", "[[Foo]]"),
            ("Foo.md", "# A"),
            ("foo.md", "# B"),
        ]);
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].target, "Foo");
        let (_, ambiguous) = graph_fixture(&[
            ("start.md", "[[FOO]]"),
            ("Foo.md", "# A"),
            ("foo.md", "# B"),
        ]);
        assert!(ambiguous.is_empty());
    }

    #[test]
    fn graph_preserves_canonically_equivalent_unicode_paths_and_exact_identity() {
        let (nodes, edges) = graph_fixture(&[
            ("start.md", "[[concepts/grün]]"),
            ("concepts/grün.md", "# NFC"),
            ("concepts/gru\u{0308}n.md", "# NFD"),
        ]);
        assert_eq!(nodes.len(), 3);
        assert!(nodes.iter().any(|node| node.id == "concepts/grün"));
        assert!(nodes.iter().any(|node| node.id == "concepts/gru\u{0308}n"));
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, "concepts/grün");
    }

    #[test]
    fn graph_related_keeps_string_identity_and_rejects_malformed_metadata() {
        let (_, edges) = graph_fixture(&[
            (
                "start.md",
                "---\nrelated: [123, true, {target: foo}, \"456\"]\n---\n# Start",
            ),
            ("123.md", "# Number"),
            ("true.md", "# Boolean"),
            ("foo.md", "# Object"),
            ("456.md", "# String"),
        ]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, "456");
        for source in [
            "---\nrelated: [foo\n---\n# Invalid",
            "related: [foo]\n# No frontmatter",
        ] {
            let (_, edges) = graph_fixture(&[("start.md", source), ("foo.md", "# Foo")]);
            assert!(edges.is_empty());
        }
    }

    #[test]
    fn graph_frontmatter_supports_crlf_bom_and_quoted_scalar_related() {
        let (_, edges) = graph_fixture(&[
            ("start.md", "\u{feff}---\r\ntype: concept\r\nrelated: 'Wiki/concepts/ziel.MD#Abschnitt|Anzeige'\r\n---\r\n# Start"),
            ("concepts/ziel.md", "# Ziel"),
        ]);
        assert_eq!(edges.len(), 1);
        let (nodes, _) =
            graph_fixture(&[("visible.md", "# Visible\ntype: query\nThis is body text.")]);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_type, "other");
    }

    #[test]
    fn graph_short_prefixed_frontmatter_matches_reader_type_and_related() {
        let (nodes, edges) = graph_fixture(&[
            (
                "frage.md",
                "frontmatter:\n---\ntype: query\nrelated: ziel\n---\n# Hidden",
            ),
            (
                "start.md",
                "```yaml\n---\ntype: concept\nrelated: ziel\n---\n```\n# Start",
            ),
            ("ziel.md", "# Ziel"),
        ]);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().all(|node| node.id != "frage"));
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].source, "start");
        assert_eq!(edges[0].target, "ziel");
        assert!(nodes.iter().all(|node| node.link_count == 1));

        let (_, deep_edges) = graph_fixture(&[
            (
                "start.md",
                "one\ntwo\nthree\nfour\nfive\nsix\n---\nrelated: ziel\n---\n# Body",
            ),
            ("ziel.md", "# Ziel"),
        ]);
        assert!(deep_edges.is_empty());
    }

    #[test]
    fn graph_filtered_degrees_count_only_returned_edges() {
        let (mut nodes, edges) =
            graph_fixture(&[("a.md", "[[b]]"), ("b.md", "[[c]]"), ("c.md", "# C")]);
        assert_eq!(nodes.iter().find(|n| n.id == "b").unwrap().link_count, 2);
        nodes.retain(|node| node.id != "c");
        let edges = retain_edges_and_recount(&mut nodes, edges);
        assert_eq!(edges.len(), 1);
        assert!(nodes.iter().all(|node| node.link_count == 1));
        nodes.truncate(1);
        assert!(retain_edges_and_recount(&mut nodes, edges).is_empty());
        assert_eq!(nodes[0].link_count, 0);
    }

    #[test]
    fn graph_hidden_query_names_preserve_reader_identity_and_ambiguity() {
        let (nodes, edges) = graph_fixture(&[
            ("start.md", "[[dup]] [[queries/dup]]"),
            ("concepts/dup.md", "# Visible"),
            ("queries/dup.md", "---\ntype: query\n---\n# Hidden"),
        ]);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().any(|node| node.id == "concepts/dup"));
        assert!(edges.is_empty());
        assert!(nodes.iter().all(|node| node.link_count == 0));

        let (_, explicit) = graph_fixture(&[
            ("start.md", "[[concepts/dup]] [[queries/dup]]"),
            ("concepts/dup.md", "# Visible"),
            ("queries/dup.md", "---\ntype: query\n---\n# Hidden"),
        ]);
        assert_eq!(explicit.len(), 1);
        assert_eq!(explicit[0].target, "concepts/dup");
    }

    #[test]
    fn graph_unreadable_inventory_preserves_identity_without_inventing_edges() {
        let (nodes, edges) = build_graph_pages(vec![
            GraphPage {
                path: "wiki/start.md".into(),
                label: "Start".into(),
                content: Some("[[dup]] [[hidden/dup]] [[unreadable]]".into()),
            },
            GraphPage {
                path: "wiki/concepts/dup.md".into(),
                label: "Visible".into(),
                content: Some("# Visible".into()),
            },
            GraphPage {
                path: "wiki/hidden/dup.md".into(),
                label: String::new(),
                content: None,
            },
            GraphPage {
                path: "wiki/unreadable.md".into(),
                label: String::new(),
                content: None,
            },
        ]);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().any(|node| node.id == "concepts/dup"));
        assert!(edges.is_empty());
        assert!(nodes.iter().all(|node| node.link_count == 0));
    }
    #[test]
    fn graph_resolves_existing_page_paths_extensions_aliases_and_fragments() {
        for target in [
            "ziel",
            "ziel.md",
            "concepts/ziel",
            "concepts/ziel.md",
            "wiki/concepts/ziel.md",
            "concepts/ziel.md#Abschnitt|Anzeige",
            "wiki\\concepts\\ziel.md",
            "concepts/./ziel",
        ] {
            let source = format!("---\ntype: concept\n---\n[[{target}]]");
            let (nodes, edges) = graph_fixture(&[
                ("entities/start.md", &source),
                ("concepts/ziel.md", "---\ntype: concept\n---\n# Ziel"),
            ]);
            assert_eq!(edges.len(), 1, "existing target {target}");
            assert!(nodes.iter().all(|node| node.link_count == 1));
        }
    }

    #[test]
    fn graph_normalizes_unicode_and_preserves_case_and_space_fallbacks() {
        for target in ["gru\u{0308}ne-seite", "GRÜNE-SEITE", "Grüne Seite"] {
            let source = format!("[[{target}]]");
            let (_, edges) = graph_fixture(&[
                ("start.md", &source),
                ("concepts/grüne-seite.md", "# Seite"),
            ]);
            assert_eq!(edges.len(), 1, "normalized target {target}");
        }
    }

    #[test]
    fn graph_related_accepts_yaml_sequences_and_ignores_non_string_items() {
        for frontmatter in [
            "related:\n  - ziel\n  - 'concepts/zweite.md'\n  - ziel\n",
            "related: [ziel, \"concepts/zweite.md\", ziel, 7, {target: falsch}]\n",
        ] {
            let source = format!("---\ntype: concept\n{frontmatter}---\n# Start");
            let (nodes, edges) = graph_fixture(&[
                ("start.md", &source),
                ("concepts/ziel.md", "# Ziel"),
                ("concepts/zweite.md", "# Zweite"),
                ("concepts/falsch.md", "# Falsch"),
            ]);
            assert_eq!(edges.len(), 2);
            assert_eq!(
                nodes
                    .iter()
                    .find(|node| node.id == "start")
                    .unwrap()
                    .link_count,
                2
            );
            assert_eq!(
                nodes
                    .iter()
                    .find(|node| node.id == "falsch")
                    .unwrap()
                    .link_count,
                0
            );
        }
    }

    #[test]
    fn graph_excludes_query_nodes_before_edges_and_degrees() {
        let (nodes, edges) = graph_fixture(&[
            ("sichtbar.md", "[[frage]]"),
            ("frage.md", "---\ntype: query\n---\n[[sichtbar]]"),
        ]);
        assert_eq!(nodes.len(), 1);
        assert!(edges.is_empty());
        assert_eq!(nodes[0].link_count, 0);
    }

    #[test]
    fn graph_preserves_duplicate_stems_and_requires_unambiguous_targets() {
        let (nodes, edges) = graph_fixture(&[
            ("start.md", "[[dup]] [[concepts/dup]] [[entities/dup.md]]"),
            ("concepts/dup.md", "# Concept"),
            ("entities/dup.md", "# Entity"),
        ]);
        assert_eq!(nodes.len(), 3);
        assert!(nodes.iter().any(|node| node.id == "concepts/dup"));
        assert!(nodes.iter().any(|node| node.id == "entities/dup"));
        assert_eq!(edges.len(), 2);

        let (_, ambiguous) = graph_fixture(&[
            ("start.md", "[[dup]]"),
            ("concepts/dup.md", "# Concept"),
            ("entities/dup.md", "# Entity"),
        ]);
        assert!(ambiguous.is_empty());
    }

    #[test]
    fn graph_explicit_missing_or_external_paths_never_fall_back_to_a_basename() {
        let (_, edges) = graph_fixture(&[
            ("start.md", "[[wrong/ziel]] [[../ziel]] [[wiki/../ziel]] [[/ziel]] [[https://example.test/ziel]] [[OtherProject/wiki/ziel]]"),
            ("concepts/ziel.md", "# Ziel"),
        ]);
        assert!(edges.is_empty());
    }
}
