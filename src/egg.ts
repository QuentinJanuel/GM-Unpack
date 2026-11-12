// ALZip's EGG format (ESTsoft, Korean). Hand-written because 7-Zip cannot open it at all, and the
// format is simple: a chain of magic-tagged records whose payloads are stored or raw deflate.
//
//   archive header: magic, u16 version, u32 header_id, u32 reserved, then extra fields
//   per file:       FILE_HEADER (u32 id, u64 size), extra fields, then BLOCK_HEADERs + their bytes
//   extra field:    magic, u8 bitflag, u16 size, `size` bytes
//   END_OF_FIELD closes both the archive header's field list and each file's.
//
// A file in an unsupported method (bzip2, LZMA, AZO) or encrypted is left out rather than failing
// the archive: in the archives seen so far those only ever hold an icon or a readme.

import { concat } from "./entry.js";
import type { GameFile } from "./index.js";

const EGG_HEADER = 0x41474745;
const END_OF_FIELD = 0x08e28222;
const FILE_HEADER = 0x0a8590e3;
const FILENAME_HEADER = 0x0a8591ac;
const BLOCK_HEADER = 0x02b50c13;
const ENCRYPT_HEADER = 0x08d1470f;
// Solid and split archives would be mis-split by a per-file reader; refused rather than mangled.
const SOLID_HEADER = 0x24f5a262;
const SPLIT_HEADER = 0x07cba3f2;
const STORE = 0;
const DEFLATE = 1;

let table: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The archive's files. Throws for bytes that are not a readable EGG. */
export async function readEgg(bytes: Uint8Array): Promise<GameFile[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const take = (n: number) => {
    if (at + n > bytes.length) throw new Error("egg: archive ends mid-record");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = () => take(1)[0]!;
  const u32 = () => (take(4), view.getUint32(at - 4, true));

  if (u32() !== EGG_HEADER) throw new Error("egg: not an egg archive");
  at = 14;
  const files: GameFile[] = [];
  const skipped: string[] = [];
  while (at < bytes.length) {
    const magic = u32();
    if (magic === END_OF_FIELD) continue;
    if (magic === SOLID_HEADER || magic === SPLIT_HEADER) throw new Error("egg: solid and split archives are not supported");
    if (magic !== FILE_HEADER) throw new Error(`egg: unexpected record ${magic.toString(16)}`);
    take(12);

    let path: string | null = null;
    let encrypted = false;
    for (let field = u32(); field !== END_OF_FIELD; field = u32()) {
      if (field === ENCRYPT_HEADER) encrypted = true;
      u8();
      const body = take(view.getUint16((take(2), at - 2), true));
      // EGG names are UTF-8, so there is no encoding to guess.
      if (field === FILENAME_HEADER) path = new TextDecoder().decode(body).replace(/\\/g, "/");
    }
    if (path === null) throw new Error("egg: file record with no name");

    const parts: Uint8Array[] = [];
    let usable = !encrypted;
    while (at + 4 <= bytes.length && view.getUint32(at, true) === BLOCK_HEADER) {
      at += 4;
      const method = u8();
      u8(); // compression level
      const size = u32();
      const packedSize = u32();
      const crc = u32();
      if (u32() !== END_OF_FIELD) throw new Error("egg: malformed block header");
      const packed = take(packedSize);
      if (!usable) continue;
      if (method !== STORE && method !== DEFLATE) {
        usable = false;
        continue;
      }
      const data = method === STORE ? packed.slice() : await inflateRaw(packed);
      if (data.length !== size) throw new Error(`egg: ${path}: expected ${size} bytes, got ${data.length}`);
      if (crc32(data) !== crc) throw new Error(`egg: ${path}: checksum mismatch`);
      parts.push(data);
    }
    if (!usable) skipped.push(path);
    else if (parts.length && !path.endsWith("/")) files.push({ path, bytes: parts.length === 1 ? parts[0]! : concat(parts) });
  }
  if (skipped.length) console.warn(`egg: left out ${skipped.length} file(s) it can't decode: ${skipped.join(", ")}`);
  return files;
}
