'use strict';
// Model family from an engine/model name. Used only to check that the reviewer is
// not the same family as the model that wrote the report. A name we cannot place
// is "unknown" and is refused as a reviewer: a wrong guess would defeat the point.
const FAMILIES = [
  ['claude', /\b(claude|sonnet|opus|haiku|anthropic)\b|^(sonnet|opus|haiku)/i],
  ['openai', /\b(gpt|chatgpt|openai|codex|o[134](?:-|\b))|^o[134]\b/i],
  ['gemini', /\b(gemini|gemma|google)\b/i],
  ['deepseek', /deepseek/i],
  ['qwen', /\b(qwen|qwq)/i],
  ['llama', /\b(llama|meta-llama)/i],
  ['mistral', /\b(mistral|mixtral|codestral)/i],
  ['grok', /\b(grok|xai)\b/i],
  ['glm', /\b(glm|zhipu)/i],
  ['kimi', /\b(kimi|moonshot)/i],
];

function familyOf(name) {
  const s = String(name || '').trim();
  if (!s) return 'unknown';
  for (const [fam, re] of FAMILIES) if (re.test(s)) return fam;
  return 'unknown';
}

// -> { ok, reason, reviewer, worker }
function checkDifferent(reviewerName, workerName) {
  const reviewer = familyOf(reviewerName), worker = familyOf(workerName);
  if (reviewer === 'unknown') return { ok: false, reason: 'reviewer family unknown', reviewer, worker };
  if (worker === 'unknown') return { ok: false, reason: 'worker model family unknown (set worker_model)', reviewer, worker };
  if (reviewer === worker) return { ok: false, reason: `reviewer and worker are both ${reviewer}`, reviewer, worker };
  return { ok: true, reason: '', reviewer, worker };
}

module.exports = { familyOf, checkDifferent };
