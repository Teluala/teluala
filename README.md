# Teluala.js

**A lighter, faster globe engine for the web.**

Teluala is a small, framework-independent WebGPU globe engine. It renders a
WGS84 ellipsoid, handles camera navigation and picking, and lets applications
add their own layers through a shared rendering contract. The core has no
runtime dependencies.

[Website](https://teluala.github.io/) ·
[Getting started](packages/core/README.md#quick-start) ·
[Issues](https://github.com/teluala/teluala/issues)

## Install

```sh
npm install teluala@beta
```

Add `@teluala/terrain@beta`, `@teluala/raster@beta`, or `@teluala/vector@beta`
to the same command for the optional packages.

## Start with the core

In an application served by a development server or bundler:

```js
import { GlobeEngine } from 'teluala';

// Supply a canvas with an explicit CSS width and height.
const canvas = document.querySelector('#globe');
const globe = await GlobeEngine.create(canvas);
globe.onPick = ({ lon, lat }) => console.log(lon, lat);
```

This renders an untextured ellipsoid. Drag to pan, scroll to zoom, and
right-drag or Shift-drag to orbit. Map imagery, labels, and terrain data are
not included. See the [complete setup and API guide](packages/core/README.md)
for the HTML, compatibility checks, coordinate units, and extension contracts.

You need WebGPU on HTTPS or localhost, with a compatible browser and GPU.
There is no WebGL fallback. Handle initialization errors in your application
and call `globe.destroy()` when removing the canvas.

## Use a CDN

Without a build step, import the standalone ES module from a CDN with a pinned
version:

```html
<script type="module">
  import { GlobeEngine } from 'https://cdn.jsdelivr.net/npm/teluala@0.1.0-beta.2/dist/teluala.min.js';
  // Create the globe with a sized canvas, as in the setup guide.
</script>
```

See the [complete CDN example](packages/core/README.md#cdn) for a ready-to-use
HTML page and the alternative UNPKG URL. The npm and CDN builds expose the
same core API.

## Release scope

**The first public beta contains the core and three optional packages.**
APIs may change before the first stable release.

| Package | Purpose | Status |
| --- | --- | --- |
| [`teluala`](packages/core/) | Ellipsoid rendering, camera controls, ground picking, layer and plugin contracts | Public beta |
| [`@teluala/terrain`](packages/terrain/) | Elevation sources and shared height sampling | Public beta |
| [`@teluala/raster`](packages/raster/) | Raster imagery | Public beta |
| [`@teluala/vector`](packages/vector/) | Mapbox Vector Tiles | Public beta |

Each package is published separately; install only the features your
application needs.

## Develop

This repository uses npm workspaces. The core lives in `packages/core/`.

```sh
npm ci
npm test
npm run example --workspace teluala
```

Open `http://localhost:4174/examples/basic/` to try the core locally.
The example server requires Python 3; building requires Node.js 22.13 or later
and npm. Tests build the package and check browser-independent behavior.
Rendering and interaction changes also need a WebGPU browser smoke test.

Read [CONTRIBUTING](CONTRIBUTING.md) before making a change. For bug reports,
include a minimal reproduction, package version, browser and OS versions,
and the expected and actual behavior.

## License

[MIT](LICENSE) © 2026 The Teluala Authors.
