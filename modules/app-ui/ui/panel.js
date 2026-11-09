// app-ui panel entry (browser ES module). The host UI calls mount(el, { base }) with
// base = "/m/app-ui". The app keeps its own token handling, so the panel frames the page.
export function mount(el, { base }) {
  const f = document.createElement('iframe');
  f.src = `${base}/ui/index.html`;
  f.title = 'App';
  f.style.cssText = 'border:0;width:100%;height:100%;min-height:70vh';
  el.appendChild(f);
  return () => f.remove();
}
