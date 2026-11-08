// chat-ui panel (browser ES module). The host UI calls mount(el, { base, fetch }) with
// base = "/m/chat-ui". The chat page keeps its own token handling, so the panel frames
// the standalone page (static files are public; every /api call there sends the token).
export function mount(el, { base }) {
  const f = document.createElement('iframe');
  f.src = `${base}/ui/index.html`;
  f.title = 'Chat';
  f.style.cssText = 'border:0;width:100%;height:100%;min-height:70vh';
  el.appendChild(f);
  return () => f.remove();
}
