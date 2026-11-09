# repo-map decisions

1. Regex, not a parser: only column-0 declarations are listed (functions, classes, types, Markdown
   headings up to level 3). Less precise than a syntax tree, but plain Node with no dependency.
2. Rank: for each symbol, the number of other files that contain its name as a token (capped at 20),
   summed per file, plus up to 3 for recent git history. Names common to many files are noisy; the cap limits the harm.
3. The file list comes from `git ls-files` (tracked plus untracked, minus ignored) when git works,
   otherwise a walk that skips node_modules, .git, dist and build.
4. Symlinks are followed only when their real path stays inside the root.
5. The cache (`state/m/repo-map/cache.json`) is keyed by root and path with mtime and size, written
   atomically, and capped at `cache_entries` by least recent use.
6. Off by default; `prepareTurn` adds the map only when `inject` is true. The hook catches every
   error and returns null. The route answers a generic error and never raises.
7. The route and command are read-only. The route maps only folders inside the configured root.
