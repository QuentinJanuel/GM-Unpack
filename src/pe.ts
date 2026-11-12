// The two containers a Windows executable can be: a GameMaker Studio self-contained export (a
// Cabinet in an RT_RCDATA resource) and a self-extracting archive (an archive appended after the
// last section). Reads PE headers and the resource directory, nothing else.

import { containerKind, isPe, type ContainerKind } from "./signature.js";

interface Section {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}

function sections(bytes: Uint8Array): Section[] | null {
  if (bytes.length < 0x40 || !isPe(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) return null; // "PE\0\0"
  const count = view.getUint16(pe + 6, true);
  const start = pe + 24 + view.getUint16(pe + 20, true);
  const out: Section[] = [];
  for (let i = 0; i < count && start + i * 40 + 40 <= bytes.length; i++) {
    const at = start + i * 40;
    const name = new TextDecoder("latin1").decode(bytes.subarray(at, at + 8)).replace(/\0.*$/s, "");
    out.push({
      name,
      virtualSize: view.getUint32(at + 8, true),
      virtualAddress: view.getUint32(at + 12, true),
      rawSize: view.getUint32(at + 16, true),
      rawPointer: view.getUint32(at + 20, true),
    });
  }
  return out;
}

const RT_RCDATA = 10;

/** IMAGE_RESOURCE_DIRECTORY (16 bytes) then its 8-byte entries; offsets are relative to `.rsrc`. */
function entries(rsrc: DataView, dir: number) {
  if (dir + 16 > rsrc.byteLength) return [];
  const count = rsrc.getUint16(dir + 12, true) + rsrc.getUint16(dir + 14, true);
  const out: { id: number; named: boolean; isDir: boolean; offset: number }[] = [];
  for (let i = 0; i < count && dir + 16 + i * 8 + 8 <= rsrc.byteLength; i++) {
    const id = rsrc.getUint32(dir + 16 + i * 8, true);
    const offset = rsrc.getUint32(dir + 20 + i * 8, true);
    out.push({ id: id & 0x7fffffff, named: id >>> 31 === 1, isDir: offset >>> 31 === 1, offset: offset & 0x7fffffff });
  }
  return out;
}

/** The Cabinet a GameMaker Studio self-contained export carries as an RT_RCDATA resource, if any. */
export function embeddedCab(bytes: Uint8Array): Uint8Array | null {
  const all = sections(bytes);
  const section = all?.find((s) => s.name === ".rsrc");
  if (!all || !section) return null;
  const end = Math.min(bytes.length, section.rawPointer + section.rawSize);
  const rsrc = new DataView(bytes.buffer, bytes.byteOffset + section.rawPointer, Math.max(0, end - section.rawPointer));
  // The tree is type -> name -> language -> data entry.
  for (const type of entries(rsrc, 0)) {
    if (type.named || type.id !== RT_RCDATA || !type.isDir) continue;
    for (const name of entries(rsrc, type.offset)) {
      if (!name.isDir) continue;
      for (const lang of entries(rsrc, name.offset)) {
        if (lang.isDir || lang.offset + 8 > rsrc.byteLength) continue;
        const rva = rsrc.getUint32(lang.offset, true);
        const size = rsrc.getUint32(lang.offset + 4, true);
        const holder = all.find((s) => rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
        if (!holder) continue;
        const at = holder.rawPointer + (rva - holder.virtualAddress);
        const cab = bytes.subarray(at, at + size);
        if (containerKind(cab) === "cab") return cab;
      }
    }
  }
  return null;
}

/** The archive a self-extracting executable carries after its last section, if any. */
export function appendedArchive(bytes: Uint8Array): { kind: ContainerKind; bytes: Uint8Array } | null {
  const all = sections(bytes);
  if (!all?.length) return null;
  const overlay = bytes.subarray(Math.max(...all.map((s) => s.rawPointer + s.rawSize)));
  const kind = containerKind(overlay);
  // A zip's offsets count from the start of the file, so a zip SFX is read whole.
  if (kind === "zip") return { kind, bytes };
  return kind === "7z" || kind === "rar" ? { kind, bytes: overlay } : null;
}
