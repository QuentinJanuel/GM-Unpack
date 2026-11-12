// What a file is, read from its first bytes. Signature tests only: nothing here parses a format.

/** A container this package opens. Spelled as the extension 7-Zip picks a format from. */
export type ContainerKind = "zip" | "7z" | "rar" | "gz" | "bz2" | "xz" | "cab" | "tar" | "egg";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: readonly { kind: ContainerKind; offset: number; magic: readonly number[] }[] = [
  // A local file header, or the empty- and spanned-archive variants a zip may legally open with.
  { kind: "zip", offset: 0, magic: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "zip", offset: 0, magic: [0x50, 0x4b, 0x05, 0x06] },
  { kind: "zip", offset: 0, magic: [0x50, 0x4b, 0x07, 0x08] },
  { kind: "7z", offset: 0, magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { kind: "rar", offset: 0, magic: ascii("Rar!\x1a\x07") },
  { kind: "gz", offset: 0, magic: [0x1f, 0x8b] },
  { kind: "bz2", offset: 0, magic: ascii("BZh") },
  { kind: "xz", offset: 0, magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { kind: "cab", offset: 0, magic: ascii("MSCF") },
  { kind: "egg", offset: 0, magic: ascii("EGGA") },
  // POSIX tar has no leading magic: its marker sits inside the first header block.
  { kind: "tar", offset: 257, magic: ascii("ustar") },
];

const matchesAt = (bytes: Uint8Array, offset: number, magic: readonly number[]) =>
  bytes.length >= offset + magic.length && magic.every((byte, i) => bytes[offset + i] === byte);

/** Which container these bytes are, or null for none. */
export function containerKind(bytes: Uint8Array): ContainerKind | null {
  return SIGNATURES.find((sig) => matchesAt(bytes, sig.offset, sig.magic))?.kind ?? null;
}

export const isPe = (bytes: Uint8Array) => matchesAt(bytes, 0, ascii("MZ"));

/** A GameMaker Studio data file (`data.win`, `game.unx`, ...): an IFF `FORM` whose first chunk is `GEN8`. */
export const isStudioData = (bytes: Uint8Array) =>
  matchesAt(bytes, 0, ascii("FORM")) && matchesAt(bytes, 8, ascii("GEN8"));
