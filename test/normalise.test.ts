import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import * as zip from "@zip.js/zip.js";
// The built package, as a consumer gets it: run `npm run build` first.
import { containerKind, normalise, UnreadableArchiveError, type GameFile } from "../dist/index.js";
import { nodeSevenZip } from "../dist/seven-zip.js";

const text = (s: string) => new TextEncoder().encode(s);
const studioData = () => text("FORM\0\0\0\0GEN8 rest of a data.win");
const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);
const paths = (files: GameFile[]) => files.map((f) => f.path).sort();

/** A minimal PE: headers, one 0x200-byte section, then `overlay`. */
function pe(overlay: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(0x400 + overlay.length);
  const view = new DataView(out.buffer);
  out.set(text("MZ"));
  view.setUint32(0x3c, 0x40, true);
  out.set(text("PE\0\0"), 0x40);
  view.setUint16(0x46, 1, true); // one section, no optional header
  out.set(text(".text"), 0x58);
  view.setUint32(0x58 + 8, 0x200, true);
  view.setUint32(0x58 + 12, 0x1000, true);
  view.setUint32(0x58 + 16, 0x200, true);
  view.setUint32(0x58 + 20, 0x200, true);
  out.set(overlay, 0x400);
  return out;
}

async function zipOf(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of Object.entries(files)) await writer.add(name, new zip.Uint8ArrayReader(bytes));
  return writer.close();
}

/** An archive of `type` written by 7-Zip itself. */
async function sevenZipOf(type: string, files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const { FS, callMain } = await nodeSevenZip();
  FS.mkdir("/src");
  for (const [name, bytes] of Object.entries(files)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = `/src/${parts.slice(0, i).join("/")}`;
      try {
        FS.mkdir(dir);
      } catch {
        // already made for an earlier file
      }
    }
    FS.writeFile(`/src/${name}`, bytes);
  }
  FS.chdir("/src");
  callMain(["a", `-t${type}`, `/archive.${type}`, ...new Set(Object.keys(files).map((n) => n.split("/")[0]!)), "-bso0"]);
  return FS.readFile(`/archive.${type}`);
}

test("a folder that already holds a game is left alone, a zip beside it included", async () => {
  const game = await normalise([
    { path: "data.win", bytes: studioData() },
    { path: "extras.zip", bytes: await zipOf({ "a.txt": text("a") }) },
  ]);
  assert.deepEqual(paths(game.files), ["data.win", "extras.zip"]);
  assert.deepEqual(game.entries, ["data.win"]);
});

test("a zip is opened, its wrapping folder and macOS litter dropped", async () => {
  const download = await zipOf({
    "My Game/My Game.exe": pe(),
    "My Game/music/bgm.ogg": text("ogg"),
    "__MACOSX/My Game/._My Game.exe": text("fork"),
  });
  const game = await normalise([{ path: "My Game.zip", bytes: download }]);
  assert.deepEqual(paths(game.files), ["My Game.exe", "music/bgm.ogg"]);
  assert.deepEqual(game.entries, ["My Game.exe"]);
});

test("containers nested inside one another are opened in turn", async () => {
  const tar = await sevenZipOf("tar", { "Game/data.win": studioData(), "Game/snd.ogg": text("ogg") });
  const xz = await sevenZipOf("xz", { "game.tar": tar });
  const game = await normalise([{ path: "game.zip", bytes: await zipOf({ "game.tar.xz": xz }) }]);
  assert.deepEqual(paths(game.files), ["data.win", "snd.ogg"]);
});

test("a 7z self-extracting exe is opened, a plain exe is not", async () => {
  const sfx = pe(await sevenZipOf("7z", { "Game/game.exe": pe(), "Game/readme.txt": text("hi") }));
  assert.deepEqual(paths((await normalise([{ path: "setup.exe", bytes: sfx }])).files), ["game.exe", "readme.txt"]);
  const plain = await normalise([{ path: "game.exe", bytes: pe(text("game data, not an archive")) }]);
  assert.deepEqual(paths(plain.files), ["game.exe"]);
  assert.deepEqual(plain.entries, ["game.exe"]);
});

test("paths that leave the game's folder are dropped", async () => {
  const game = await normalise([
    { path: "game.exe", bytes: pe() },
    { path: "../outside.txt", bytes: text("x") },
    { path: "C:/Windows/x.dll", bytes: text("x") },
  ]);
  assert.deepEqual(paths(game.files), ["game.exe"]);
});

test("an egg is opened", async () => {
  const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
  const u16 = (n: number) => new Uint8Array(new Uint16Array([n]).buffer);
  const END = u32(0x08e28222);
  const body = text("FORM\0\0\0\0GEN8 egg");
  const packed = deflateRawSync(body);
  const name = text("Game/data.win");
  const crc = (await import("node:zlib")).crc32(body);
  const egg = new Uint8Array(
    Buffer.concat([
      u32(0x41474745), u16(0x100), u32(1), u32(0), END,
      u32(0x0a8590e3), u32(0), u32(body.length), u32(0),
      u32(0x0a8591ac), new Uint8Array([0]), u16(name.length), name, END,
      u32(0x02b50c13), new Uint8Array([1, 0]), u32(body.length), u32(packed.length), u32(crc), END, packed,
      END,
    ]),
  );
  const game = await normalise([{ path: "game.egg", bytes: egg }]);
  assert.deepEqual(paths(game.files), ["data.win"]);
  assert.deepEqual(game.files[0]!.bytes, body);
});

test("a Blob is read like bytes, and the second argument may still be a 7-Zip factory", async () => {
  const sevenZip = await sevenZipOf("7z", { "Game/data.win": studioData(), "Game/snd.ogg": text("ogg") });
  const fromSevenZip = await normalise([{ path: "game.7z", bytes: blob(sevenZip) }], nodeSevenZip);
  assert.deepEqual(paths(fromSevenZip.files), ["data.win", "snd.ogg"]);
  assert.deepEqual(fromSevenZip.files.find((f) => f.path === "data.win")!.bytes, studioData());
  const big = new Uint8Array(100_000).map((_, i) => i * 7);
  const zipped = await zipOf({ "Game/game.exe": pe(), "Game/snd.ogg": text("ogg"), "Game/empty": new Uint8Array(), "Game/big.bin": big });
  // A zip must not need 7-Zip: zip.js reads it, legacy names and all.
  const noSevenZip = async () => assert.fail("7-Zip was asked to read a zip");
  const fromZip = await normalise([{ path: "game.zip", bytes: blob(zipped) }], noSevenZip);
  assert.deepEqual(paths(fromZip.files), ["big.bin", "empty", "game.exe", "snd.ogg"]);
  assert.deepEqual(fromZip.files.find((f) => f.path === "big.bin")!.bytes, big);
  assert.deepEqual(fromZip.files.find((f) => f.path === "snd.ogg")!.bytes, text("ogg"));
});

test("map gets each final file one at a time, and progress reaches the total", async () => {
  const download = await sevenZipOf("7z", { "Game/data.win": studioData(), "Game/music/a.ogg": text("aaaa") });
  let busy = false;
  const progress: [number, number][] = [];
  const game = await normalise([{ path: "game.7z", bytes: blob(download) }], {
    map: async (file) => {
      assert.ok(!busy, "map called again before the last one settled");
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      busy = false;
      return `${file.path}:${file.bytes.length}`;
    },
    onProgress: (done, total) => progress.push([done, total]),
  });
  const total = studioData().length + 4;
  assert.deepEqual(game.files.sort(), [`data.win:${studioData().length}`, "music/a.ogg:4"]);
  assert.deepEqual(game.entries, ["data.win"]);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.at(-1), [total, total]);
});

test("an unreadable archive throws UnreadableArchiveError", async () => {
  const good = await sevenZipOf("7z", { "a.txt": text("a".repeat(1000)) });
  const truncated = good.slice(0, good.length - 20);
  assert.equal(containerKind(truncated), "7z");
  await assert.rejects(normalise([{ path: "game.7z", bytes: truncated }]), (error) => {
    assert.ok(error instanceof UnreadableArchiveError);
    assert.equal(error.kind, "7z");
    return true;
  });
  await assert.rejects(normalise([{ path: "game.egg", bytes: text("EGGA and nothing else") }]), UnreadableArchiveError);
  // 7-Zip's failing exit status must not leak into the host process's.
  assert.ok(!process.exitCode);
});

test("root: shallowest-exe trims to the shallowest folder with an .exe, the default only strips wrappers", async () => {
  const download = await zipOf({
    "pack/readme.txt": text("hi"),
    "pack/Game/game.exe": pe(),
    "pack/Game/data/level.dat": text("x"),
    "pack/Game/tools/editor.exe": pe(),
  });
  const trimmed = await normalise([{ path: "pack.zip", bytes: download }], { root: "shallowest-exe" });
  assert.deepEqual(paths(trimmed.files), ["data/level.dat", "game.exe", "tools/editor.exe"]);
  const wrapped = await normalise([{ path: "pack.zip", bytes: download }]);
  assert.deepEqual(paths(wrapped.files), ["Game/data/level.dat", "Game/game.exe", "Game/tools/editor.exe", "readme.txt"]);
  const noExe = await normalise([{ path: "pack.zip", bytes: await zipOf({ "pack/data.win": studioData() }) }], { root: "shallowest-exe" });
  assert.deepEqual(paths(noExe.files), ["data.win"]);
});
