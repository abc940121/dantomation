// hello-stub panel (browser ES module). The UI calls mount(el, { base, fetch }):
// base = "/m/hello-stub"; fetch is an authed fetch (same signature as window.fetch)
// that panels use for every call to their routes. The returned function unmounts.
export function mount(el, { base, fetch }) {
  const p = document.createElement('p');
  el.appendChild(p);
  fetch(`${base}/hello`).then(r => r.json()).then(j => { p.textContent = j.greeting; });
  return () => p.remove();
}
