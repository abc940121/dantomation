// trace panel (browser ES module): task list with duration, tools, cost and overrun; click a row for its timeline.
export function mount(el, { base, fetch }) {
  const root = document.createElement('div');
  const list = document.createElement('div');
  const detail = document.createElement('pre');
  root.append(list, detail);
  el.appendChild(root);
  const mmss = ms => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
  async function show(id) {
    const j = await (await fetch(`${base}/tasks/${encodeURIComponent(id)}`)).json();
    detail.textContent = j.task ? j.task.events.map(e => `+${mmss(e.offset_ms)}  ${e.type}  ${e.tool || ''}${e.ok === false ? ' (failed)' : ''}`).join('\n') : 'not found';
  }
  async function refresh() {
    let j; try { j = await (await fetch(`${base}/tasks`)).json(); } catch { return; }
    list.textContent = '';
    for (const t of j.tasks || []) {
      const b = document.createElement('button');
      b.textContent = `${t.task_id}  ${t.state}  ${t.duration_ms === null ? '-' : mmss(t.duration_ms)}  ${t.tool_count} tools  ${t.cost_usd === null ? 'cost unknown' : '$' + t.cost_usd}${t.overrun ? '  OVER PREDICTION' : ''}`;
      b.style.display = 'block';
      b.onclick = () => show(t.task_id);
      list.appendChild(b);
    }
    if (!list.firstChild) list.textContent = 'no traced tasks';
  }
  refresh();
  const timer = setInterval(refresh, 10000);
  return () => { clearInterval(timer); root.remove(); };
}
