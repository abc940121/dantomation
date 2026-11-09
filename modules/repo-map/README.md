# repo-map

A compact map of a code repository: files ranked by importance with their top-level symbols,
cut to a character budget. JS/TS, Python, Go, Rust, Java, C# and Markdown headings.

Enable with `"modules": { "repo-map": true }`. Add `"repo_map": { "inject": true }` to put the map
in each turn prompt (default false).

- Command: `taskmote dev repo-map [path]` prints the map of a folder (default: the configured root or the current folder).
- Route (owner): `GET /m/repo-map/map[?path=sub/folder]`.
- Settings: `inject`, `root`, `max_chars`, `max_files`, `max_bytes_total`, `max_file_bytes`,
  `max_symbols_per_file`, `cache_entries`, `use_git`.
- Symlink rule test: the check that links outside the root are skipped runs only where the test can create symlinks (Linux, macOS, or Windows with symlink rights such as Developer Mode). Elsewhere, including a default Windows account, it prints `SKIP symlink check`. There is no CI yet, so it runs only when someone runs the suite on such a machine.
