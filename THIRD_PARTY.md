# Third-party components (modules/voice/)

This repo bundles **no model weights and no third-party code**. `modules/voice/` is stdlib Python + Node written new for this repo (see PROVENANCE.md). The parts below are installed or downloaded separately on the Mac by the user, under their own licenses.

| Component | Used by | License | Bundled? | Source |
|---|---|---|---|---|
| Qwen3-ASR (speech to text) | `modules/voice/mac_client.py` via the local ASR server | Apache-2.0 | No, downloaded at install time | Official `Qwen/` repos on Hugging Face / `QwenLM` on GitHub |
| Qwen3-TTS (text to speech) | `modules/voice/mac_client.py` via the local TTS server | Apache-2.0 | No, downloaded at install time | Official `Qwen/` repos on Hugging Face, `QwenLM/Qwen3-TTS` on GitHub |
| mlx-audio (Blaizzy) | serves ASR/TTS on Apple silicon | MIT | No | `pip install mlx-audio` |
| AIRI | not used by `modules/voice/` | MIT | No | — |
| Claude Code CLI | `modules/voice/bridge.py` (via `bin/harness.js`) | Anthropic terms | No | user's own install and subscription |

## Apache-2.0 attribution (Qwen3-ASR, Qwen3-TTS)

Qwen3-ASR and Qwen3-TTS are Copyright Alibaba Cloud / the Qwen team, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). If you redistribute the weights, include their LICENSE and any NOTICE file from the official repo. This repo does not redistribute them.

## Rules

- Download weights only from the official `Qwen/` organisation. Do not use re-uploads with different license tags (e.g. an AGPL-tagged third-party "Qwen3-TTS" upload exists; it is not the official release).
- MLX conversions are accepted (review ruling 2026-11-08) only when the model card names the official `Qwen/` base and states Apache-2.0, pinned to a commit. If a card lacks either, use the official `Qwen/` id and convert locally. Weights are never committed here.

| Repo id (default in mac_client.py) | HF commit | Base model | License (card) | Checked |
|---|---|---|---|---|
| `mlx-community/Qwen3-ASR-1.7B-8bit` | `a8379a2e2f9e313c9292cdf1af4055ab56d50d55` | `Qwen/Qwen3-ASR-1.7B` (named in README text; card metadata has no base_model field) | apache-2.0 | 2026-11-08 HF API |
| `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` | `41d3337e8b7f2843a75841595fc14e4b9a7a4b96` | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (card metadata) | apache-2.0 | 2026-11-08 HF API |

- License facts above were taken from the repos' stated licenses, not from opening each LICENSE file; check the LICENSE file in the official repo before any redistribution.
