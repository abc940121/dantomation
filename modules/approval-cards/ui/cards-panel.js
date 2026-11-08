// approval-cards panel (browser ES module). The UI calls mount(el, { base, fetch }):
// base = "/m/approval-cards"; fetch is the authed fetch the UI hands every panel
// (window.fetch's signature). The returned function unmounts it.
export function mount(el, { base, fetch }) {
  let stopped = false;
  const box = document.createElement('div');
  el.appendChild(box);
  const button = (label, card) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => {
      await fetch(`${base}/cards/${encodeURIComponent(card.card_id)}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: label }) });
      refresh();
    };
    return b;
  };
  async function refresh() {
    if (stopped) return;
    const res = await fetch(`${base}/cards`);
    const { cards = [] } = await res.json();
    box.replaceChildren(...(cards.length ? cards.map(c => {
      const row = document.createElement('div');
      row.textContent = `${c.card_id}: ${c.summary} (expires ${c.expires_at}) `;
      row.append(button('yes', c), button('no', c));
      return row;
    }) : [Object.assign(document.createElement('div'), { textContent: 'no cards waiting' })]));
  }
  refresh();
  return () => { stopped = true; box.remove(); };
}
