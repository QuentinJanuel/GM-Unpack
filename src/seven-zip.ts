// Everything that isn't a zip or an egg goes through 7-Zip, compiled to wasm (7z-wasm, LGPL-2.1
// with the unRAR restriction; see NOTICE).

import type { SevenZipModule, SevenZipModuleFactory } from "7z-wasm";
import type { ContainerKind } from "./signature.js";
import { HEAD, UnreadableArchiveError, type Entry } from "./entry.js";

/** Makes a 7-Zip instance. Called once per archive: `callMain` is not re-entrant, and one
 *  instance's filesystem is one namespace. */
export type SevenZipFactory = () => Promise<SevenZipModule>;

export const nodeSevenZip: SevenZipFactory = async () => {
  const init = (await import("7z-wasm")).default as unknown as SevenZipModuleFactory;
  // 7-Zip's own listing would otherwise go to stdout, which the CLI keeps for its answer.
  return init({ print: () => {}, printErr: (line: string) => console.warn(line) });
};

/** Copies the archive into 7-Zip's filesystem. A Blob goes in a chunk at a time, so a whole game
 *  never sits in memory as one ArrayBuffer beside the filesystem's own copy. */
async function writeSource({ FS }: SevenZipModule, path: string, data: Uint8Array | Blob) {
  if (!(data instanceof Blob)) return FS.writeFile(path, data);
  const stream = FS.open(path, "w+");
  // Sized up front: grown on demand, MEMFS reallocates in 1.125x steps, copying all of it each time.
  FS.truncate(path, data.size);
  try {
    const reader = data.stream().getReader();
    for (let at = 0; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      FS.write(stream, value, 0, value.length, at);
      at += value.length;
    }
  } finally {
    FS.close(stream);
  }
}

/** The archive's files, left in 7-Zip's filesystem until they are read. `kind` names the input,
 *  because 7-Zip picks its format from the extension. */
export async function readWithSevenZip(data: Uint8Array | Blob, kind: ContainerKind, make: SevenZipFactory): Promise<Entry[]> {
  const sevenZip = await make();
  const { FS } = sevenZip;
  FS.mkdir("/in");
  FS.mkdir("/out");
  await writeSource(sevenZip, `/in/archive.${kind}`, data);
  // An Emscripten exception (a bare number) is how a password-protected or corrupt archive fails.
  let exit: unknown;
  // Under Node, Emscripten copies 7-Zip's exit status into process.exitCode: the host's to set, not ours.
  const exitCode = globalThis.process?.exitCode;
  try {
    exit = sevenZip.callMain(["x", `/in/archive.${kind}`, "-o/out", "-y", "-bso0", "-bsp0"]);
  } catch (cause) {
    throw new UnreadableArchiveError(kind, String(cause));
  } finally {
    if (globalThis.process) process.exitCode = exitCode;
  }
  if (typeof exit === "number" && exit !== 0) throw new UnreadableArchiveError(kind, `exit ${exit}`);
  FS.unlink(`/in/archive.${kind}`);

  const out: Entry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const full = `${dir}/${name}`;
      const { mode, size } = FS.stat(full);
      if (FS.isDir(mode)) {
        walk(full, `${prefix}${name}/`);
        continue;
      }
      const head = new Uint8Array(Math.min(HEAD, size));
      const stream = FS.open(full, "r");
      FS.read(stream, head, 0, head.length, 0);
      FS.close(stream);
      // MEMFS keeps file contents on the JS heap, so dropping a file once it is handed out frees it.
      out.push({ path: `${prefix}${name}`, size, head, read: async () => FS.readFile(full), drop: () => FS.unlink(full) });
    }
  };
  walk("/out", "");
  return out;
}
