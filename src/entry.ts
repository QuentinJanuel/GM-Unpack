// A file on its way through normalise(): its first bytes up front, the rest read only when needed,
// so an archive's contents can stay where its reader put them until they are handed out.

import type { ContainerKind } from "./signature.js";

/** Enough to tell every signature in ./signature.ts (tar's sits at 257). */
export const HEAD = 512;

export interface Entry {
  readonly path: string;
  readonly size: number;
  readonly head: Uint8Array;
  read(): Promise<Uint8Array>;
  /** Set when the bytes came from a Blob, so a container can be streamed rather than read whole. */
  readonly blob?: Blob;
  /** Frees whatever holds the bytes, once they have been handed out. */
  drop?(): void;
}

/** The download is a container that could not be read: corrupt, truncated, password-protected or
 *  in a format variant no reader here handles. Anything else (a failing Blob, out of memory) is
 *  thrown as it is. */
export class UnreadableArchiveError extends Error {
  override readonly name = "UnreadableArchiveError";
  /** The container it was read as. */
  readonly kind: ContainerKind;
  constructor(kind: ContainerKind, detail: string) {
    super(`could not open the ${kind} (${detail})`);
    this.kind = kind;
  }
}

export const fromBytes = (path: string, bytes: Uint8Array): Entry => ({
  path,
  size: bytes.length,
  head: bytes.subarray(0, HEAD),
  read: async () => bytes,
});

export const fromBlob = async (path: string, blob: Blob): Promise<Entry> => ({
  path,
  size: blob.size,
  head: new Uint8Array(await blob.slice(0, HEAD).arrayBuffer()),
  read: async () => new Uint8Array(await blob.arrayBuffer()),
  blob,
});

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
