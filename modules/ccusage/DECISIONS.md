# Decisions: ccusage

- S-ccusage: wraps the ccusage CLI via npx instead of parsing logs, so it stays a thin report layer; spend-count remains the only guard. Version pinned in settings because the JSON shape differs between ccusage versions.
