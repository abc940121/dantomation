// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// True once an element has come within a screen of the viewport (latched; used to colour code blocks lazily).
import { useEffect, useState, type RefObject } from "react";

export function useNearScreen(ref: RefObject<Element | null>, margin = "600px"): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}
