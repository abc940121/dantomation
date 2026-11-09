// question-cards panel (browser ES module). mount(el, { base, fetch }): base = "/m/question-cards";
// fetch is the authed fetch the UI hands every panel. All text goes in through textContent.
export function mount(el, { base, fetch }) {
  let stopped = false;
  const box = document.createElement('div');
  el.appendChild(box);
  const post = async (id, what, body) => {
    await fetch(`${base}/questions/${encodeURIComponent(id)}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    refresh();
  };
  const card = q => {
    const row = document.createElement('div');
    row.append(Object.assign(document.createElement('div'), { textContent: `${q.question_id}: ${q.text}` }));
    q.options.forEach((o, i) => {
      const b = Object.assign(document.createElement('button'), { textContent: o });
      b.onclick = () => post(q.question_id, 'answer', { choice: i + 1 });
      row.append(b);
    });
    if (q.allow_free) {
      const input = Object.assign(document.createElement('input'), { type: 'text', maxLength: 500, placeholder: 'or type an answer' });
      const send = Object.assign(document.createElement('button'), { textContent: 'send' });
      send.onclick = () => input.value.trim() && post(q.question_id, 'answer', { text: input.value });
      row.append(input, send);
    }
    return row;
  };
  async function refresh() {
    if (stopped) return;
    const { questions = [] } = await (await fetch(`${base}/questions`)).json();
    box.replaceChildren(...(questions.length ? questions.map(card) : [Object.assign(document.createElement('div'), { textContent: 'no questions waiting' })]));
  }
  refresh();
  return () => { stopped = true; box.remove(); };
}
