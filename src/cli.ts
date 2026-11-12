#!/usr/bin/env node
// gm-unpack <download: file or folder> <out dir>
//
// Writes the normalised game into <out dir>, which must not exist yet or be empty, and prints
// { "entries": [...] } on stdout.

import { openAsBlob } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalise, type DownloadFile } from "./index.js";

const [input, out] = process.argv.slice(2);
if (!input || !out) {
  console.error("usage: gm-unpack <file or folder> <out dir>");
  process.exit(2);
}

// File-backed Blobs: nothing is read until normalise() needs it.
async function read(root: string): Promise<DownloadFile[]> {
  if (!(await stat(root)).isDirectory()) return [{ path: path.basename(root), bytes: await openAsBlob(root) }];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const full = path.join(e.parentPath, e.name);
        return { path: path.relative(root, full).split(path.sep).join("/"), bytes: await openAsBlob(full) };
      }),
  );
}

const existing = await readdir(out).catch(() => []);
if (existing.length) {
  console.error(`${out} is not empty`);
  process.exit(1);
}
const game = await normalise(await read(input), {
  // Each file is written as it comes out, so the game is never in memory whole.
  map: async (file) => {
    const target = path.join(out, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  },
});
console.log(JSON.stringify({ entries: game.entries }));
