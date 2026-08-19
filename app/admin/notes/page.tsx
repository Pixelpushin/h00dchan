"use client";

// Admin scratchpad - a persistent place to jot down "build this next"
// ideas without losing them in chat history. Same wallet-whitelist auth as
// every other admin page (lib/useAdminSession.ts).
import { useCallback, useEffect, useState } from "react";
import { useAdminSession, authHeaders } from "@/lib/useAdminSession";
import type { AdminNote } from "@/lib/adminNotesStore";

export default function AdminNotesPage() {
  const { session, connecting, connectError, connect, clearSession } =
    useAdminSession();
  const [notes, setNotes] = useState<AdminNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadNotes = useCallback(
    async (activeSession: NonNullable<typeof session>) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/notes", {
          headers: authHeaders(activeSession),
        });
        if (res.status === 401) {
          clearSession();
          throw new Error("Not authorized as admin for this wallet.");
        }
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const data = await res.json();
        setNotes(data.notes ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    },
    [clearSession],
  );

  // Load once a session exists - this page's own connect button is the
  // only entry point into having a session at all here, but a session can
  // also already be sitting in sessionStorage from a prior visit (or from
  // the Ads page, since the session is shared), in which case there's no
  // click to hang this off of. Deferred to a microtask (same class of fix
  // already applied elsewhere in this codebase for this exact lint rule):
  // loadNotes's first setState calls happen before its first `await`, so
  // calling it directly here would run them synchronously inside the
  // effect body itself.
  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => loadNotes(session));
  }, [session, loadNotes]);

  const handleConnect = async () => {
    await connect();
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session || !draft.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/notes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(session),
        },
        body: JSON.stringify({ text: draft.trim() }),
      });
      if (!res.ok) throw new Error(`Failed to add (${res.status})`);
      const data = await res.json();
      setNotes((current) => [data.note, ...current]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add note.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleDone = async (note: AdminNote) => {
    if (!session) return;
    setNotes((current) =>
      current.map((n) => (n.id === note.id ? { ...n, done: !n.done } : n)),
    );
    try {
      await fetch(`/api/admin/notes/${note.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(session),
        },
        body: JSON.stringify({ done: !note.done }),
      });
    } catch {
      // Optimistic update stands even if the write failed - a refresh will
      // reconcile it, and this is a low-stakes personal scratchpad, not
      // worth a rollback dance for.
    }
  };

  const handleDelete = async (id: string) => {
    if (!session) return;
    setNotes((current) => current.filter((n) => n.id !== id));
    try {
      await fetch(`/api/admin/notes/${id}`, {
        method: "DELETE",
        headers: authHeaders(session),
      });
    } catch {
      // same reasoning as handleToggleDone
    }
  };

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="hc-box flex flex-col gap-3 p-4 w-full max-w-sm text-center">
          <p className="hc-thread-meta text-xs">
            Connect and sign with a whitelisted admin wallet.
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="hc-button"
          >
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
          {connectError && (
            <p className="text-sm" style={{ color: "#a12b2b" }}>
              {connectError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-2xl flex-col gap-4 px-6 py-8">
        <h1 className="hc-title text-xl">Admin notes</h1>

        <form onSubmit={handleAdd} className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note..."
            rows={3}
            className="hc-form-input"
          />
          <button
            type="submit"
            disabled={submitting || !draft.trim()}
            className="hc-button self-start text-sm"
          >
            {submitting ? "Adding..." : "Add note"}
          </button>
        </form>

        {loading && <p className="text-center">Loading...</p>}
        {error && (
          <p className="text-sm text-center" style={{ color: "#a12b2b" }}>
            {error}
          </p>
        )}
        {!loading && notes.length === 0 && !error && (
          <p className="hc-thread-meta text-center">No notes yet.</p>
        )}

        <div className="flex flex-col gap-2">
          {notes.map((note) => (
            <div
              key={note.id}
              className="hc-box p-3 flex items-start gap-2"
              style={{ opacity: note.done ? 0.5 : 1 }}
            >
              <button
                onClick={() => handleToggleDone(note)}
                className="hc-thread-meta text-sm shrink-0"
                aria-label={note.done ? "Mark not done" : "Mark done"}
              >
                {note.done ? "☑" : "☐"}
              </button>
              <div className="flex-1 min-w-0">
                <p
                  className="text-sm whitespace-pre-wrap break-words"
                  style={{
                    textDecoration: note.done ? "line-through" : "none",
                  }}
                >
                  {note.text}
                </p>
                <p className="hc-thread-meta text-xs mt-1">
                  {new Date(note.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <button
                onClick={() => handleDelete(note.id)}
                className="hc-thread-meta text-xs shrink-0"
                style={{ color: "#a12b2b" }}
              >
                delete
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
