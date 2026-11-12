# GM-Unpack

Any GameMaker game download in, one normalised game out: plain files with every container opened,
rooted at the game's own root, siblings intact. It reads folders, `.zip`, `.7z`, `.rar`, `.egg`,
`.tar` and its compressions (`.gz`, `.bz2`, `.xz`), `.cab`, self-extracting `.exe` files (7z, RAR,
zip) and GameMaker Studio self-contained `.exe` files.

Identification is signature-level only: a file is a container when its first bytes say so,
whatever its name, and no game format is parsed. It asks "is this already a game?" before opening
anything, opens a container only when it is all there is, and repeats, up to four levels deep.

## Command line

Node 24 or later.

```sh
npm install @sculptr/gm-unpack
npx gm-unpack <file or folder> <out dir>
```

It writes the normalised game into `<out dir>`, which must not exist yet or be empty, and prints
`{"entries": [...]}`. `entries` is advisory: the GameMaker Studio data files when there are any,
else every `.exe`.

## Library

```ts
import { normalise, UnreadableArchiveError, containerKind } from "@sculptr/gm-unpack";

const game = await normalise([{ path: file.name, bytes: file }], {
  map: async ({ path, bytes }) => { /* write it out */ return path; },
  onProgress: (done, total) => {},
  root: "wrapper", // or "shallowest-exe"
  sevenZip: myFactory, // default loads the 7z-wasm package; in a browser, locate its .wasm yourself
});
// game.files, game.entries
```

- Input files take a `Uint8Array` or a `Blob` (a `File`, Node's `fs.openAsBlob`). A Blob is
  streamed into 7-Zip or read by zip.js a piece at a time; executables and EGGs are read whole.
- `map` gets each file of the result with its final path, one at a time, the next not read until
  it settles. Write files out there and the game is never in memory whole. Without it, `files` is
  `{ path, bytes }[]`.
- Paths that would leave the game's folder are left out, as are macOS archive litter (`__MACOSX`,
  `._*`, `.DS_Store`).
- A container that cannot be read (corrupt, truncated, password-protected) throws
  `UnreadableArchiveError`; anything else is thrown as it is.
- The root. `"wrapper"` (default) strips folders that wrap everything, one after another, and
  leaves nothing out. `"shallowest-exe"` roots the game at the shallowest folder holding a `.exe`
  (by name; ties go to the first by `localeCompare`) and leaves out everything outside it, falling
  back to `"wrapper"` when there is no `.exe`.
- `containerKind(bytes)` names the container a file's first bytes (512 are enough) belong to.

## Development

```sh
npm ci
npm run build      # dist/, which the tests import
npm run typecheck
npm test
```

## Licence

MIT. See [LICENSE](LICENSE). The dependencies and their licences are listed in [NOTICE](NOTICE).
