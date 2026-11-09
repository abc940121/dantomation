// The voice area: hands-free call button and overlay, the install settings page, the service worker.
// Our own file (MIT).
import { createElement, useEffect, useState } from "react";
import { registerArea, useArea } from "../registry";
import { InstallPage, captureInstallPrompt } from "./InstallPage";
import { VoiceCall } from "./VoiceCall";
import { en, zhTw } from "./strings";

// Does the voice-chat module answer? Asked once per page load. An unknown playback state is refused with 400 and
// changes nothing, so a 400 means "the module is there"; 404 or 403 means it is off or not allowed.
let probe: Promise<boolean> | null = null;
function moduleAnswers(post: (path: string, body?: unknown) => Promise<unknown>): Promise<boolean> {
  probe ??= post("/m/voice-chat/playback", { state: "probe" }).then(
    () => true,
    (err: unknown) => (err as { status?: number })?.status === 400,
  );
  return probe;
}

function CallButton() {
  const { client, t, openOverlay } = useArea();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    void moduleAnswers((p, b) => client.post(p, b)).then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, [client]);
  if (!ok) return null;
  return createElement(
    "button",
    {
      type: "button",
      "aria-label": t("voice.callOpen"),
      title: t("voice.call"),
      onClick: () => openOverlay("voice-call"),
      className: "inline-flex min-h-10 items-center justify-center rounded-lg px-3 text-sm hover:bg-raised-hover",
    },
    t("voice.call"),
  );
}

function addAppleIcon() {
  if (document.querySelector('link[rel="apple-touch-icon"]')) return;
  const link = document.createElement("link");
  link.rel = "apple-touch-icon";
  link.href = new URL("./icons/apple-touch-icon.png", document.baseURI).href;
  document.head.appendChild(link);
}

registerArea({
  id: "voice",
  strings: { en, "zh-tw": zhTw },
  views: [
    { slot: "header-action", id: "voice", priority: 50, component: CallButton },
    { slot: "overlay", id: "voice-call", component: VoiceCall },
    { slot: "settings-page", id: "install", priority: 90, component: InstallPage },
  ],
  start() {
    const stop = captureInstallPrompt();
    try {
      addAppleIcon();
      if (window.isSecureContext && "serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      }
    } catch {
      /* installability is optional */
    }
    return stop;
  },
});
