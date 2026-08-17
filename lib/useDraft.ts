"use client";

// Autosaves a post-composer field (subject or body) to localStorage as the
// user types, so an accidental tab close/navigation before hitting submit
// doesn't lose what was typed - caught live: a real user closed the tab
// mid-post and lost it. Callers already call setValue("") on a successful
// submit (to reset the visible field either way) - since setValue treats
// an empty string as "clear," that same call also wipes the saved draft
// for free, so a successful post never leaves stale text to refill the
// box with next time.
//
// Same useSyncExternalStore + module-level listener-map pattern already
// used by lib/usePersona.ts for sessionStorage - not a useState+useEffect
// pair, which is exactly the hydration-mismatch/set-state-in-effect shape
// this codebase has hit and fixed more than once already. Server snapshot
// is always "" (SSR has no localStorage), matching the empty initial value
// a fresh composer already had, so there's nothing to reconcile on hydrate
// beyond the same "upgrades shortly after mount" pattern usePersona.ts
// already uses for its own localStorage/sessionStorage reads.
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string) {
  return (listener: () => void) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    return () => listeners.get(key)?.delete(listener);
  };
}

function getSnapshot(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function getServerSnapshot(): string {
  return "";
}

export function useDraftField(key: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe(key),
    () => getSnapshot(key),
    getServerSnapshot,
  );

  const setValue = useCallback(
    (next: string) => {
      try {
        if (next) {
          window.localStorage.setItem(key, next);
        } else {
          window.localStorage.removeItem(key);
        }
      } catch {
        // best-effort only - quota exceeded / private-mode storage
        // restrictions shouldn't break typing in the box.
      }
      notify(key);
    },
    [key],
  );

  return [value, setValue];
}
