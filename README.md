# rvmark

A tree-based hypertext framework with a custom markup language and static site generator.
Each `.rvmark` file compiles to a HTML page with graceful degradation.

This repository is the **rvmark engine**: the static site generator and runtime.

See <https://rv.rvmark.net/> for a demonstration and human-written documentation.

## Installation

rvmark is not yet published to npm. For now, clone the repository and build the engine
locally:

```sh
git clone <repo-url> rvmark-engine
cd rvmark-engine
npm install
npm run build
```

This produces the `rvmark` CLI at `bin/rvmark.mjs` and the engine's
build/runtime entry points. A consuming project can depend on the engine via a local
path (`"rvmark": "file:../rvmark-engine"`).

An installable npm package (`npm install rvmark`) is planned but not yet available.

## Usage

Build a directory of `.rvmark` content into a static site (invoke the CLI via its bin
path, or the globally-installed `rvmark` command):

```sh
node bin/rvmark.mjs --content <dir> --out <dir> [--theme <file>] [--template <file>]
                    [--assets <dir>] [--custom-types <dir>] [--mount <path>] [--include-drafts]
```

Defaults: `--content rvmark`, `--out dist`.

The output in `--out` consists of pure static files (HTML, CSS, browser-side JS, and rvmark source files).
You can deploy its contents to any static host (GitHub Pages, Neocities, Netlify, etc.).

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

The name "rvmark" is reserved by the lead of this project. 
Forks and services derived from it should identify themselves distinctly.
