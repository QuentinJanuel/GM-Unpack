// Zips without 7-Zip. Legacy zips (common among GameMaker game downloads, many Japanese and a decade old) store
// names in Shift-JIS without the UTF-8 flag, and 7z-wasm garbles those. Here every unflagged name
// is sniffed together, one guess for the whole archive, since one short name rarely says enough.

import * as zip from "@zip.js/zip.js";
import chardet from "chardet";
import { concat, HEAD, UnreadableArchiveError, type Entry } from "./entry.js";

function decode(bytes: Uint8Array, label: string | null): string {
  for (const candidate of [label, "utf-8"]) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch {
      // chardet's 'mbcs'/'sbcs' placeholders are not labels TextDecoder knows.
    }
  }
  return new TextDecoder().decode(bytes);
}

/** An entry's first bytes, inflating no further than that. */
async function head(entry: zip.FileEntry): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  // Aborted through zip.js's signal: a writer that throws instead leaves zip.js closing a dead
  // stream, which fails the whole zip over to 7-Zip.
  const enough = new AbortController();
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(chunk);
      length += chunk.length;
      if (length >= HEAD) enough.abort();
    },
  });
  try {
    await entry.getData(writable, { signal: enough.signal });
  } catch (error) {
    if (!enough.signal.aborted) throw error;
  }
  return concat(parts).slice(0, HEAD);
}

/** The zip's files, inflated only when read; null when this reader can't (encryption, an exotic
 *  method, not a zip): 7-Zip gets it then. */
export async function readZip(data: Uint8Array | Blob): Promise<Entry[] | null> {
  const source = data instanceof Blob ? new zip.BlobReader(data) : new zip.Uint8ArrayReader(data);
  // Never closed: closing only cancels a stream source, and these entries read from it later.
  const reader = new zip.ZipReader(source, { useWebWorkers: false });
  try {
    const all = (await reader.getEntries()).filter((e) => !e.directory);
    const legacy = all.filter((e) => !e.filenameUTF8).map((e) => e.rawFilename);
    const label = legacy.length ? chardet.detect(concat(legacy)) : null;
    const out: Entry[] = [];
    for (const entry of all) {
      const path = entry.filenameUTF8 ? entry.filename : decode(entry.rawFilename, label);
      out.push({
        path,
        size: entry.uncompressedSize,
        // Inflating the start here is what catches an encrypted entry or an unsupported method, while
        // there is still time to hand the zip to 7-Zip.
        head: await head(entry),
        read: () =>
          entry.getData(new zip.Uint8ArrayWriter(), { checkCrc32: true, checkAmbiguity: true }).catch((error: unknown) => {
            throw new UnreadableArchiveError("zip", `${path}: ${error instanceof Error ? error.message : error}`);
          }),
      });
    }
    return out;
  } catch {
    return null;
  }
}
