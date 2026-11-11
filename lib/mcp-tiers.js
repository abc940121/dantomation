'use strict';
// Tool tiers + expand on demand for the Taskmote MCP server (bin/taskmote-mcp.js).
// 工具分層：讓 agent 的提示大小不隨工具數量增加。
//   tier 1  always listed (at most MAX_TIER1 including the meta tool expand_tools)
//   tier 2  folded: only a category title + one line "when to use me" in the expand_tools description
//   tier 3  rare or dangerous: never in the menu; reachable by exact name only; every expand/call is journaled by the server
// A tool declares `tier` (1|2|3, default 2) and `category` (default: its module name). A bad tier means 2.
// A module that declares more tier 1 tools than the cap is demoted to tier 2 (extra ones, in order) with a logged warning,
// so a module can never break the flat prompt-size promise.
// Which tier 1 tools keep tier 1 under the cap is decided by a fixed order (core first, then module name, then tool name), never by load order.
// Pure functions, no I/O (the warn callback is the only side channel).
const MAX_TIER1 = 8;       // including the meta tool
const META_COUNT = 1;      // expand_tools
const MENU_CATS = 8;       // categories shown in the menu; the rest is "and N more"
const HINT_LEN = 60;
const WHEN_LEN = 60; // the one short "when to use me" line every tool carries (field `when`)
const FIND_LIMIT = 10;

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const whenOf = t => (t && typeof t.when === 'string' ? clip(t.when, WHEN_LEN) : '');
// Shown to the agent so it can choose a tool without reading its schema: expand results carry it as `when`; tools/list adds it to the description.
const pub = t => ({ name: t.name, when: whenOf(t), description: t.description, inputSchema: t.inputSchema });
const pubList = t => ({ name: t.name, description: whenOf(t) ? `${t.description} When to use: ${whenOf(t)}.` : t.description, inputSchema: t.inputSchema });
// -> names of the tools with no usable `when` line (missing, not text, or empty). The meta tools carry theirs below.
const missingWhen = tools => (tools || []).filter(t => !whenOf(t)).map(t => t && t.name);

function normalize(tool, moduleName) {
  const t = tool && tool.tier;
  const tier = t === 1 || t === 2 || t === 3 ? t : 2;
  const category = tool && typeof tool.category === 'string' && tool.category ? tool.category : (moduleName || (tool && tool.module) || 'other');
  return { tier, category };
}

const warned = new Set();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// -> [{ tool, tier, category }] in the input order, with the tier 1 cap applied: the first MAX_TIER1 - META_COUNT tier 1 tools
// in the fixed order (core, module name, tool name) keep tier 1, the rest are demoted.
function prepare(tools, warn) {
  const list = (tools || []).map(tool => ({ tool, ...normalize(tool, tool.module) }));
  const rank = p => [p.tool.module === 'core' ? 0 : 1, String(p.tool.module || ''), String(p.tool.name)];
  const order = list.filter(p => p.tier === 1).sort((x, y) => { const a = rank(x), b = rank(y); return cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]); });
  const keep = new Set(order.slice(0, MAX_TIER1 - META_COUNT));
  return list.map(p => {
    if (p.tier !== 1 || keep.has(p)) return p;
    if (warn && !warned.has(p.tool.name)) { warned.add(p.tool.name); warn(`tool ${String(p.tool.name).slice(0, 60)} declares tier 1 but the tier 1 cap (${MAX_TIER1}) is reached: demoted to tier 2`); }
    return { ...p, tier: 2 };
  });
}

const catInfo = (categories, id) => {
  const c = (categories && categories[id]) || {};
  return { title: clip(c.title || id, 40), when: clip(c.when || '', HINT_LEN) };
};

// The folded categories (tier 2 only), in first-seen order -> [{ category, title, when, tools }].
function folded(prep, categories) {
  const m = new Map();
  for (const p of prep) if (p.tier === 2) m.set(p.category, (m.get(p.category) || 0) + 1);
  return [...m].map(([category, tools]) => ({ category, ...catInfo(categories, category), tools }));
}

const EXPAND_SCHEMA = { type: 'object', properties: {
  category: { type: 'string', description: 'Show the tools of one folded category.' },
  name: { type: 'string', description: 'Show one tool by exact name.' },
  query: { type: 'string', description: 'Find tools by a word in their name or description.' } } };

function metaTools(prep, categories) {
  const cats = folded(prep, categories);
  const shown = cats.slice(0, MENU_CATS).map(c => `- ${c.category}${c.title !== c.category ? ' (' + c.title + ')' : ''}${c.when ? ': ' + c.when : ''}`);
  const more = cats.length - shown.length;
  const menu = shown.length
    ? ` Folded tool groups (name one with category=...):\n${shown.join('\n')}${more > 0 ? `\nand ${more} more: call expand_tools with no arguments to list them.` : ''}`
    : '';
  return [
    { name: 'expand_tools', when: 'A tool you need is not listed: show the folded ones', description: 'Show the tools that are folded away to keep the list short. Give category, name or query (one of them); with no arguments it lists all folded groups. Call the tools it returns by their own name.' + menu, inputSchema: EXPAND_SCHEMA },
  ];
}

// The public tools/list: tier 1, the tools expanded so far (any tier), and the meta tool.
function listTools(tools, { categories, expanded, warn } = {}) {
  const prep = prepare(tools, warn);
  const ex = expanded || new Set();
  const own = prep.filter(p => p.tier === 1 || ex.has(p.tool.name)).map(p => pubList(p.tool));
  return [...own, ...metaTools(prep, categories).map(pubList)];
}

// expand_tools: -> { tools, reveal:[{name,tier}], matches?, categories?, error? }
function expand(tools, sel, categories, warn) {
  const prep = prepare(tools, warn);
  const s = sel && typeof sel === 'object' ? sel : {};
  const given = ['category', 'name', 'query'].filter(k => s[k] !== undefined && s[k] !== null && s[k] !== '');
  const out = { tools: [], reveal: [] };
  if (given.length > 1) return { ...out, error: 'give only one of category, name, query' };
  const take = p => { out.tools.push(pub(p.tool)); out.reveal.push({ name: p.tool.name, tier: p.tier }); };
  if (!given.length) return { ...out, categories: folded(prep, categories) };
  const key = given[0], val = String(s[key]);
  if (key === 'category') {
    const lv = val.toLowerCase(); // the id, or the title shown in the menu (any case)
    const hit = prep.filter(p => p.tier === 2 && (p.category === val || catInfo(categories, p.category).title.toLowerCase() === lv));
    if (!hit.length) return { ...out, error: `no folded category ${clip(val, 40)}. Call expand_tools with no arguments to list them.` };
    hit.forEach(take);
  } else if (key === 'name') {
    const p = prep.find(x => x.tool.name === val);
    if (!p) return { ...out, error: `unknown tool ${clip(val, 60)}` };
    take(p);
  } else {
    const q = val.toLowerCase();
    const hit = prep.filter(p => `${p.tool.name} ${p.tool.description} ${whenOf(p.tool)} ${p.category}`.toLowerCase().includes(q)).slice(0, FIND_LIMIT);
    out.matches = hit.map(p => ({ name: p.tool.name, tier: p.tier, category: p.category, when: whenOf(p.tool) }));
    hit.filter(p => p.tier !== 3).forEach(take); // tier 3: name only, never a schema
    if (!hit.length) out.error = `no tool matches ${clip(val, 40)}`;
  }
  return out;
}

const find = (tools, name) => (tools || []).find(t => t.name === name);
const tierOf = (tools, name, warn) => { const p = prepare(tools, warn).find(x => x.tool.name === name); return p ? p.tier : null; };

module.exports = { missingWhen, WHEN_LEN, MAX_TIER1, MENU_CATS, normalize, listTools, expand, find, tierOf, prepare };
