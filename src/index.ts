// Any download in, a normalised game out: plain files with every container opened,
// rooted at the game's own root, siblings intact.

import { readEgg } from "./egg.js";
import { fromBlob, fromBytes, UnreadableArchiveError, type Entry } from "./entry.js";
import { appendedArchive, embeddedCab } from "./pe.js";
import { nodeSevenZip, readWithSevenZip, type SevenZipFactory } from "./seven-zip.js";
import { containerKind, isPe, isStudioData, type ContainerKind } from "./signature.js";
import { readZip } from "./zip.js";

export { concat, UnreadableArchiveError } from "./entry.js";
export type { SevenZipFactory } from "./seven-zip.js";
export { containerKind, type ContainerKind } from "./signature.js";

export interface GameFile {
  /** "/"-separated, no leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** One file of a download. A Blob (a `File`, or Node's `fs.openAsBlob`) is read a piece at a time
 *  and never held whole unless it is an executable or an EGG, which are read into memory. */
export interface DownloadFile {
  readonly path: string;
  readonly bytes: Uint8Array | Blob;
}

export interface NormaliseOptions<T = GameFile> {
  /** Makes a 7-Zip instance; the default loads the `7z-wasm` package. Pass one that locates the
   *  `.wasm` yourself in a browser. */
  sevenZip?: SevenZipFactory;
  /**
   * Called once per file of the result, with its final path, one at a time and in order: the next
   * file is not read until the promise this returns settles. Its results are `files`. Write each
   * file out here and return something small, and the game is never held in memory whole.
   */
  map?: (file: GameFile) => T | Promise<T>;
  /** Called after each file has been through `map`, in bytes handed out so far of the total. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Where the game's root is, once every container is open.
   * - `"wrapper"` (default): strip folders that wrap everything, one after another; nothing is
   *   left out.
   * - `"shallowest-exe"`: the shallowest folder holding a `.exe` (by name, ties broken by
   *   `localeCompare`), and files outside it are left out. Falls back to `"wrapper"` when there is
   *   no `.exe`.
   */
  root?: "wrapper" | "shallowest-exe";
}

export interface NormalisedGame<T = GameFile> {
  readonly files: T[];
  /** Advisory: the files an engine would most likely load, zero or more. Studio data files when
   *  there are any, else every `.exe`. */
  readonly entries: string[];
}

/** How many containers deep a download may nest: a zip holding a `.tar.xz` is three. */
const MAX_DEPTH = 4;

/** Clean "/"-separated paths. Drops what could escape the game's folder and macOS archive litter. */
function tidy(files: readonly Entry[]): Entry[] {
  const out = new Map<string, Entry>();
  for (const file of files) {
    const segments = file.path.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0 || segments.includes("..") || segments.some((s) => s.includes(":"))) {
      console.warn(`left out ${JSON.stringify(file.path)}: not a path inside the game`);
      continue;
    }
    if (segments[0] === "__MACOSX" || segments.at(-1)!.startsWith("._") || segments.at(-1) === ".DS_Store") continue;
    const path = segments.join("/");
    out.set(path, { ...file, path });
  }
  return [...out.values()];
}

async function open(kind: ContainerKind, file: Entry, sevenZip: SevenZipFactory): Promise<Entry[]> {
  const data = file.blob ?? (await file.read());
  if (kind === "zip") {
    const files = await readZip(data);
    if (files) return files;
  }
  if (kind === "egg") {
    // shortcut: an EGG is read whole, as its reader takes bytes; stream it if large EGGs turn up.
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    try {
      return (await readEgg(bytes)).map((f) => fromBytes(f.path, f.bytes));
    } catch (error) {
      throw new UnreadableArchiveError("egg", error instanceof Error ? error.message : String(error));
    }
  }
  return readWithSevenZip(data, kind, sevenZip);
}

/** A self-contained Studio export's own files: its Cabinet's, when that holds a Studio data file. */
async function selfContained(bytes: Uint8Array, sevenZip: SevenZipFactory): Promise<Entry[] | null> {
  const cab = embeddedCab(bytes);
  if (!cab) return null;
  const files = await readWithSevenZip(cab, "cab", sevenZip);
  return files.some((f) => isStudioData(f.head)) ? files : null;
}

/** What a lone file opens into, or null when it is not a container (a game, or anything else). */
async function unwrap(file: Entry, sevenZip: SevenZipFactory): Promise<Entry[] | null> {
  if (isPe(file.head)) {
    // shortcut: an executable is read whole to find its Cabinet or appended archive; read only its
    // headers and stream the payload if a huge self-extractor ever matters.
    const bytes = await file.read();
    const inner = await selfContained(bytes, sevenZip);
    if (inner) return inner;
    const sfx = appendedArchive(bytes);
    return sfx && open(sfx.kind, fromBytes(file.path, sfx.bytes), sevenZip);
  }
  const kind = containerKind(file.head);
  return kind && open(kind, file, sevenZip);
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const within = (dir: string, files: Entry[]) => files.map((f) => ({ ...f, path: dir + f.path }));
const depth = (dir: string) => dir.split("/").length;

/**
 * Normalises a download: one file (an archive, an executable, a bare game file) or a folder's files.
 *
 * It asks "is this already a game?" before opening anything, because an archiver will happily take
 * a game's executable apart. So: a folder that holds a Studio data file is done; a lone container
 * is opened and the result looked at again; failing both, a self-contained Studio export among the
 * files is replaced by its contents. A container sitting beside other files is left alone, since
 * the game may read it itself. Then the root is found (see {@link NormaliseOptions.root}).
 *
 * Throws {@link UnreadableArchiveError} when a container it opens turns out unreadable. A file
 * whose first bytes match no container is not one, whatever its name: it comes back as it is.
 *
 * The second argument may also be a {@link SevenZipFactory}, short for `{ sevenZip }`.
 */
export async function normalise<T = GameFile>(
  input: readonly DownloadFile[],
  options: NormaliseOptions<T> | SevenZipFactory = {},
): Promise<NormalisedGame<T>> {
  const opts: NormaliseOptions<T> = typeof options === "function" ? { sevenZip: options } : options;
  const { sevenZip = nodeSevenZip, map = (f: GameFile) => f as T, onProgress, root = "wrapper" } = opts;

  let files = tidy(await Promise.all(input.map((f) => (f.bytes instanceof Blob ? fromBlob(f.path, f.bytes) : fromBytes(f.path, f.bytes)))));
  for (let level = 0; level < MAX_DEPTH && !files.some((f) => isStudioData(f.head)); level++) {
    if (files.length === 1) {
      const inner = await unwrap(files[0]!, sevenZip);
      if (!inner) break;
      files = tidy(within(dirOf(files[0]!.path), inner));
      continue;
    }
    let opened = false;
    for (const file of files.filter((f) => isPe(f.head))) {
      const inner = await selfContained(await file.read(), sevenZip);
      if (!inner) continue;
      files = tidy([...files.filter((f) => f !== file), ...within(dirOf(file.path), inner)]);
      opened = true;
      break;
    }
    if (!opened) break;
  }

  if (root === "shallowest-exe") {
    const [dir] = files
      .filter((f) => /\.exe$/i.test(f.path))
      .map((f) => dirOf(f.path))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    if (dir !== undefined) files = files.filter((f) => f.path.startsWith(dir)).map((f) => ({ ...f, path: f.path.slice(dir.length) }));
  }
  for (;;) {
    const top = files[0]?.path.split("/")[0];
    if (!top || !files.every((f) => f.path.startsWith(`${top}/`))) break;
    files = files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
  }

  const studio = files.filter((f) => isStudioData(f.head));
  const entries = (studio.length ? studio : files.filter((f) => /\.exe$/i.test(f.path) && isPe(f.head))).map((f) => f.path);

  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const out: T[] = [];
  for (const file of files) {
    out.push(await map({ path: file.path, bytes: await file.read() }));
    file.drop?.();
    onProgress?.((done += file.size), total);
  }
  return { files: out, entries };
}
