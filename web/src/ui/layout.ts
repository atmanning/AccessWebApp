/**
 * Phone / touch detection. Two separate things are detected:
 * - compact: a small screen (phones, small tablets in portrait, phones in landscape) → phone layout:
 *   collapsed ribbon, navigation drawer, full-screen dialogs;
 * - touch: a finger is the main pointer → bigger rows, tap to open and edit, long-press menus.
 * People can override it (Automatic / Phone / Desktop), remembered in this browser.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

export type LayoutPref = "auto" | "mobile" | "desktop";
export interface Layout {
  compact: boolean;
  touch: boolean;
  pref: LayoutPref;
}

const PREF_KEY = "accessweb.layout";
// Narrow screens, or touch screens that are short (a phone held sideways).
const COMPACT_QUERY = "(max-width: 760px), (pointer: coarse) and (max-height: 520px)";
const TOUCH_QUERY = "(pointer: coarse), (hover: none)";

const listeners = new Set<() => void>();
const notify = () => {
  cached = null;
  listeners.forEach((l) => l());
};

function readPref(): LayoutPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "mobile" || v === "desktop" ? v : "auto";
  } catch {
    return "auto";
  }
}

let prefMemory: LayoutPref | null = null;
export function setLayoutPref(pref: LayoutPref) {
  prefMemory = pref;
  try {
    if (pref === "auto") localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, pref);
  } catch {
    /* storage blocked: keep it for this visit */
  }
  notify();
}

const media = (q: string) => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q) : null);
const compactMq = media(COMPACT_QUERY);
const touchMq = media(TOUCH_QUERY);
compactMq?.addEventListener?.("change", notify);
touchMq?.addEventListener?.("change", notify);

/** The browser's own "this is a phone" hint, where it gives one (Chromium-based browsers). */
function uaMobile(): boolean {
  const ua = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof ua.userAgentData?.mobile === "boolean") return ua.userAgentData.mobile;
  return /\b(iPhone|iPod|Android.+Mobile|Windows Phone|Mobile Safari)\b/i.test(navigator.userAgent);
}

let cached: Layout | null = null;
export function getLayout(): Layout {
  if (cached) return cached;
  const pref = prefMemory ?? readPref();
  if (pref === "mobile") cached = { compact: true, touch: true, pref };
  else if (pref === "desktop") cached = { compact: false, touch: false, pref };
  else {
    const phone = uaMobile();
    cached = {
      compact: !!compactMq?.matches || (phone && window.innerWidth < 1000),
      touch: !!touchMq?.matches || phone,
      pref,
    };
  }
  return cached;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, getLayout, getLayout);
}

/** Puts data-compact / data-touch on <html> so the stylesheet can adapt. Call once, near the root. */
export function useLayoutAttributes() {
  const { compact, touch } = useLayout();
  useEffect(() => {
    const el = document.documentElement;
    el.toggleAttribute("data-compact", compact);
    el.toggleAttribute("data-touch", touch);
  }, [compact, touch]);
}

export const LAYOUT_LABELS: Record<LayoutPref, string> = { auto: "Automatic", mobile: "Phone", desktop: "Desktop" };

/**
 * Long-press for touch screens (iOS doesn't send contextmenu). `bind(cb)` gives pointer handlers for an
 * element; `wasLongPress()` is true for the click that follows a long press, so it can be ignored.
 */
export function useLongPress(ms = 500) {
  const state = useRef<{ timer: ReturnType<typeof setTimeout> | null; start: { x: number; y: number } | null; fired: boolean }>({
    timer: null,
    start: null,
    fired: false,
  });
  return useMemo(() => {
    const s = state.current;
    const cancel = () => {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    };
    return {
      bind: (onLongPress: (x: number, y: number) => void) => ({
        onPointerDown: (e: React.PointerEvent) => {
          s.fired = false;
          if (e.pointerType !== "touch") return;
          s.start = { x: e.clientX, y: e.clientY };
          cancel();
          s.timer = setTimeout(() => {
            s.fired = true;
            navigator.vibrate?.(10);
            onLongPress(s.start!.x, s.start!.y);
          }, ms);
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (s.start && Math.hypot(e.clientX - s.start.x, e.clientY - s.start.y) > 10) cancel();
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
      }),
      wasLongPress: () => s.fired,
    };
  }, [ms]);
}
