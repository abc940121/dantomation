// Entry point. Our own file (MIT). Order matters: the foundation registers first, then every area.
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./shell/register";
import "./areas";
import { App } from "./App";
import { consumeHash } from "./dantomation/token";
import { auth } from "./dantomation/client";
import { getToken } from "./dantomation/token";
import { browserLocale, loadLocale } from "./lib/i18n";

async function start() {
  await consumeHash();
  if (getToken()) auth.set("ok");
  await loadLocale(browserLocale());
  createRoot(document.getElementById("root")!).render(<App />);
}
void start();
