# rvmark

An interactive, tree-based document system for structured writing and exploration —
a bespoke markup language and static site generator. Each `.rvmark` file compiles to a
single HTML page with progressive enhancement: a static outline that hydrates into an
interactive, navigable tree in the browser.

This repository is the **rvmark engine** — the language, runtime, and static site
generator. Site *content* lives in a separate repository that consumes rvmark as a
dependency.

## Installation

rvmark is not yet published to npm. For now, clone the repository and build the engine
locally:

```sh
git clone <repo-url> rvmark-engine
cd rvmark-engine
npm install
npm run build
```

This produces the `rvmark-build` CLI at `bin/rvmark.mjs` and the engine's
build/runtime entry points. A consuming project can depend on the engine via a local
path (`"rvmark": "file:../rvmark-engine"`).

> An installable npm package (`npm install rvmark`) is planned but not yet available.

## Usage

Build a directory of `.rvmark` content into a static site (invoke the CLI via its bin
path, or through a consuming project's `rvmark-build` script):

```sh
node bin/rvmark.mjs --content <dir> --out <dir> [--theme <file>] [--template <file>]
                    [--assets <dir>] [--custom-types <dir>] [--mount <path>] [--include-drafts]
```

Defaults: `--content rvmark`, `--out dist`.

The output in `--out` is pure static files (HTML, CSS, and browser-side JS) — deploy its
contents to any static host (GitHub Pages, Neocities, Netlify, etc.). There is no
server-side runtime: the engine runs at build time, and the hydration runtime runs in
the visitor's browser.

## Package exports

Once a project depends on the engine (via npm or a `file:` path), it resolves by name:

```js
import { buildSite } from 'rvmark/build';   // programmatic build entry
import { registerTransform } from 'rvmark/envoy';  // custom-type guest runtime
```

## Development

```sh
npm run build   # compile the engine (node build/build.mjs)
npm test        # build test fixtures + run the Playwright suite
```

The first time you run the tests, install the browser:

```sh
npx playwright install chromium
```

## License

rvmark is licensed under the **GNU Affero General Public License v3.0**
([AGPL-3.0-only](LICENSE)).

In plain terms: you may use, modify, host, and redistribute rvmark freely — including
running it as a hosted service — but **modifications to the engine must be made available
under the same license**, including when the modified engine is only ever run on a server.
The goal is simply that improvements to rvmark stay open.

Note that this concerns the **engine**. The static sites you *build* with rvmark are your
own work and are not covered by the engine's license.

## Trademark

"rvmark"™ is a trademark of the project's author. The AGPL covers the engine's **code**;
it does **not** license the **name**.

- You may **fork and modify** the code freely under the AGPL.
- A fork or redistribution that is **modified** must **not** be called "rvmark" — please
  choose your own name, to avoid confusion about what is the canonical project.
- **Nominative use is fine**: you may truthfully say your work is "built with rvmark",
  "rvmark-compatible", or "based on rvmark".

This reservation exists so that the rvmark name continues to identify this project,
not to restrict what you build.
