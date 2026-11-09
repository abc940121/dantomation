# app-ui chat package provenance

Files copied or derived from OpenMausBot (Apache-2.0) for the chat transcript and composer. Copied files carry the
original header plus a modified-by line; derived files were cut down or rewritten around the original. Cut:
attachments, reactions, forks, multiple threads, export, dictation, slash commands, mentions, hover cards, file
previews, mermaid, the wasm grammar and the desktop bridge. The MIT files in `web/src/areas/chat/` (register,
ChatThread, ChatComposer, ToolRow, strings, drafts, task-id) and the adapter route are our own.

| File | Source repo | Path | Commit | Kind |
|---|---|---|---|---|
| modules/app-ui/web/src/areas/chat/components/ChatMarkdown.tsx | OpenMausBot | src/components/ChatMarkdown.tsx | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/components/CodeBlock.tsx | OpenMausBot | src/components/CodeBlock.tsx | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/components/MarkdownTable.tsx | OpenMausBot | src/components/RichTable.tsx | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/components/MessageActions.tsx | OpenMausBot | src/components/MessageActions.tsx | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/components/WorkingIndicator.tsx | OpenMausBot | src/components/WorkingIndicator.tsx | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/components/DaySeparator.tsx | OpenMausBot | src/components/DaySeparator.tsx | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/components/JumpToLatestButton.tsx | OpenMausBot | src/components/JumpToLatestButton.tsx | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/code-block.ts | OpenMausBot | src/lib/code-block.ts | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/lib/markdown-render-cache.ts | OpenMausBot | src/lib/markdown-render-cache.ts | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/transcript-window.ts | OpenMausBot | src/lib/transcript-window.ts | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/bottom-follow.ts | OpenMausBot | src/lib/bottom-follow.ts | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/copy-text.ts | OpenMausBot | src/lib/copy-text.ts | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/lib/markdown-tables.ts | OpenMausBot | src/lib/markdown-tables.ts | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/working-time.ts | OpenMausBot | src/lib/working-time.ts | b63bceb | copied |
| modules/app-ui/web/src/areas/chat/lib/day.ts | OpenMausBot | src/lib/transcript-derivations.ts | b63bceb | derived |
| modules/app-ui/web/src/areas/chat/hooks/use-near-screen.ts | OpenMausBot | src/lib/on-screen.ts | b63bceb | derived |
