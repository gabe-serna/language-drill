import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";

import { parseEntries, entryKey, type Entry } from "../core/vocabulary.ts";

function decode(text: string, path: string) {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`${path}: malformed JSON (${(error as Error).message})`); }
  return parseEntries(data, path);
}

export async function readFoundationalVocabulary(path: string) {
  const text = await readFile(path, "utf8").catch(error => {
    throw new Error(`${path}: could not read foundational vocabulary (${error.code ?? error.message})`);
  });
  return decode(text, path);
}

async function edit(path: string, change: (entries: Entry[]) => Entry[]) {
  const lockPath = path + ".lock";
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error(`${path}: another vocabulary edit is in progress`);
    throw error;
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const before = await readFile(path, "utf8");
    const entries = parseEntries(change(decode(before, path)), path);
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(JSON.stringify(entries, null, 2) + "\n", "utf8");
      await file.sync();
    } finally { await file.close(); }
    if (await readFile(path, "utf8") !== before) throw new Error(`${path}: changed on disk during the edit`);
    await rename(temporary, path);
    return entries;
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

// Call these only when applying an explicit user edit or approval.
export function addFoundationalEntry(path: string, value: Entry) {
  return edit(path, entries => [...entries, value]);
}

function findEntry(entries: Entry[], key: string) {
  const index = entries.findIndex(value => entryKey(value) === key);
  if (index < 0) throw new Error("Foundational vocabulary entry no longer exists");
  return index;
}

export function updateFoundationalEntry(path: string, key: string, value: Entry) {
  return edit(path, entries => entries.with(findEntry(entries, key), value));
}

export function removeFoundationalEntry(path: string, key: string) {
  return edit(path, entries => entries.toSpliced(findEntry(entries, key), 1));
}
