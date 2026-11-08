'use strict';
// Which tool calls change something. Shared by the modules that care
// (checkpoint snapshots before them; private rules with access "write" block them).
// Read-only shell: every segment starts with a listed command and nothing
// redirects, substitutes or runs a sub-command. Anything else counts as mutating.
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const READ_ONLY = /^(ls|dir|cat|type|pwd|echo|grep|rg|findstr|head|tail|wc|which|where|stat|file|tree|Get-ChildItem|gci|Get-Content|gc|Select-String|sls|Get-Location|Test-Path|Get-Item|Resolve-Path|git (status|log|diff|show|rev-parse|ls-files|blame))(\s|$)/i;
function readOnlyShell(cmd) {
  const c = cmd.trim();
  if (!c || /[>`]|\$\(|<\(|--output\b/.test(c)) return false;
  return c.split(/&&|\|\||[;|\n]/).every(seg => READ_ONLY.test(seg.trim()));
}
const isShell = tool => tool === 'Bash' || tool === 'PowerShell';
function mutating(tool, ti) {
  if (WRITE_TOOLS.test(tool)) return true;
  if (isShell(tool)) return !readOnlyShell(String((ti && ti.command) || ''));
  return false;
}
module.exports = { readOnlyShell, mutating, isShell, WRITE_TOOLS };
