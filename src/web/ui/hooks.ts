import { useEffect, useRef, useState } from "preact/hooks";
import type { Call, CallView } from "../rtc/call.ts";

export function useCallView(call: Call): CallView {
  const [view, setView] = useState(call.view);
  useEffect(() => {
    setView(call.view);
    return call.subscribe(setView);
  }, [call]);
  return view;
}

/** Drive a CSS custom property from a per-frame reading, without re-rendering. */
export function useLevel<T extends HTMLElement>(read: () => number, property = "--level") {
  const ref = useRef<T>(null);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      ref.current?.style.setProperty(property, readRef.current().toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [property]);
  return ref;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!].map((p) => Array.from(p)[0]) : Array.from(parts[0] ?? "?").slice(0, 2);
  return letters.join("").toUpperCase();
}
