// Admin notes/todo list - same shape as lib/adStore.ts's ad-submission
// pattern (note:counter INCR for ids, note:<id> JSON blob, notes:index
// ZSET for ordered listing), reusing store.ts's redisCommand rather than a
// second Redis client. A plain persistent scratchpad for the site owner,
// not a product surface - deliberately no editing, just add/delete.
import { redisCommand } from "@/lib/store";

export interface AdminNote {
  id: string;
  text: string;
  createdAt: string;
  createdByAddress: string;
  done: boolean;
}

const NOTES_INDEX_KEY = "admin-notes:index";

async function nextNoteId(): Promise<string> {
  const id = await redisCommand("INCR", "admin-note:counter");
  return String(id);
}

async function writeNote(note: AdminNote): Promise<void> {
  await redisCommand("SET", `admin-note:${note.id}`, JSON.stringify(note));
  await redisCommand(
    "ZADD",
    NOTES_INDEX_KEY,
    Date.parse(note.createdAt),
    note.id,
  );
}

export async function addAdminNote(
  text: string,
  createdByAddress: string,
): Promise<AdminNote> {
  const id = await nextNoteId();
  const note: AdminNote = {
    id,
    text,
    createdAt: new Date().toISOString(),
    createdByAddress,
    done: false,
  };
  await writeNote(note);
  return note;
}

export async function listAdminNotes(): Promise<AdminNote[]> {
  const ids = (await redisCommand(
    "ZREVRANGE",
    NOTES_INDEX_KEY,
    0,
    -1,
  )) as string[];
  if (!ids.length) return [];
  const notes = await Promise.all(
    ids.map(async (id) => {
      const raw = await redisCommand("GET", `admin-note:${id}`);
      return typeof raw === "string" ? (JSON.parse(raw) as AdminNote) : null;
    }),
  );
  return notes.filter((n): n is AdminNote => n !== null);
}

export async function setAdminNoteDone(
  id: string,
  done: boolean,
): Promise<AdminNote | null> {
  const raw = await redisCommand("GET", `admin-note:${id}`);
  if (typeof raw !== "string") return null;
  const note = JSON.parse(raw) as AdminNote;
  note.done = done;
  await redisCommand("SET", `admin-note:${id}`, JSON.stringify(note));
  return note;
}

export async function deleteAdminNote(id: string): Promise<void> {
  await redisCommand("DEL", `admin-note:${id}`);
  await redisCommand("ZREM", NOTES_INDEX_KEY, id);
}
