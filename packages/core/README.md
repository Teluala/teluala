# Teluala.js

**A lighter, faster globe engine for the web.**

Teluala is a small, framework-independent WebGPU engine for rendering a WGS84
ellipsoid and composing independently installed globe layers in the browser.

> **Public beta: `0.1.0-beta.3`.** APIs may change before the first stable
> release.

[Website](https://teluala.github.io/) ·
[Source](https://github.com/teluala/teluala/tree/main/packages/core) ·
[Issues](https://github.com/teluala/teluala/issues)

Use Teluala when you want a small globe renderer with control over your own
layers. The core provides the ellipsoid, camera controls, ground picking, and
layer/plugin contracts. It does not provide a ready-made basemap, labels,
terrain data, or a WebGL fallback.

## Install

```sh
npm install teluala@beta
```

Teluala is ESM-only and requires a browser with WebGPU in a secure context.
It has no runtime dependencies. The package declares `@webgpu/types` as a
type-only peer dependency; add it as a development dependency if your package
manager does not install peers automatically.

## Quick start

Use Teluala through a bundler or development server that resolves installed
packages. Start with this page:

```html
<canvas id="globe"></canvas>

<style>
  html, body { width: 100%; height: 100%; margin: 0; }
  #globe { display: block; width: 100%; height: 100%; touch-action: none; }
</style>

<script type="module" src="/src/main.js"></script>
```

Then create `src/main.js`:

```js
import { GlobeEngine } from 'teluala';

const canvas = document.querySelector('#globe');
if (!GlobeEngine.supported()) {
  throw new Error('This browser does not support WebGPU.');
}

const globe = await GlobeEngine.create(canvas);
globe.onPick = ({ lon, lat }) => console.log({ lon, lat });
globe.flyTo({ lon: 0, lat: 0, range: 0.3 }, 1500);
```

You should see an untextured ellipsoid, without map imagery or labels. Drag to
pan, scroll to zoom, and right-drag or Shift-drag to orbit. Click the globe to
log longitude and latitude. The flight changes the viewpoint; it does not load
a map of the destination.

WebGPU requires HTTPS or a trustworthy local origin such as localhost, plus a
compatible browser, GPU, and driver. `supported()` checks API availability;
`create()` can still reject if GPU initialization fails. Handle that error in
your application's UI. Call `globe.destroy()` when removing the canvas.

## CDN

For a page without a build step, load the standalone ES module from jsDelivr.
Save this as an HTML file and serve it over HTTPS or localhost:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Teluala globe</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      #globe { display: block; width: 100%; height: 100%; touch-action: none; }
    </style>
  </head>
  <body>
    <canvas id="globe"></canvas>
    <script type="module">
      import { GlobeEngine } from 'https://cdn.jsdelivr.net/npm/teluala@0.1.0-beta.3/dist/teluala.min.js';

      try {
        const globe = await GlobeEngine.create(document.querySelector('#globe'));
        globe.onPick = ({ lon, lat }) => console.log({ lon, lat });
      } catch (error) {
        document.body.textContent = `Unable to start the globe: ${error.message}`;
      }
    </script>
  </body>
</html>
```

Pin the full version and file path, as shown above, so upgrades are deliberate.
The equivalent UNPKG URL is
`https://unpkg.com/teluala@0.1.0-beta.3/dist/teluala.min.js`.

The CDN file includes all core exports, has no external imports, and retains
the MIT license notice. It requires `type="module"`; it does not create a
window global. For bundled applications, keep using `import ... from 'teluala'`
so your bundler can remove unused exports. WebGPU requirements are the same
for both installation methods.

## Core API

```ts
import { GlobeEngine } from 'teluala';

const globe = await GlobeEngine.create(canvas, {
  initial: { lon: 0, lat: 20, range: 2.4 },
  background: { r: 0.93, g: 0.94, b: 0.95 },
});

globe.camera.lon = 0;
globe.camera.lat = 0;
globe.invalidate();

globe.pickGround(clientX, clientY);
globe.flyTo({ lon: 0, lat: 0, range: 0.2 });
globe.cancelFly();

// What would that view cover? Asked without moving the camera.
const preview = globe.previewFrame({ lon: 0, lat: 0, range: 0.2 });
preview.viewBBox; // ground bounds of the target view, or null

globe.destroy();
```

`destroy()` is idempotent and completes resource cleanup even if a layer throws.
In that case it reports an `AggregateError` after cleanup.

`previewFrame(target, targetAltitudeWorld?)` returns the `FrameState` of a
camera the engine is not at. It moves, draws and caches nothing: the live
camera, the frame counter and the view-bounds cache are untouched, and
`frameNumber` repeats the last drawn frame. Unspecified fields keep their
current value and the target is clamped the way `flyTo()` clamps it. Use it to
judge what a destination would cover — which bounds, which tiles — before
deciding to fly there.

The camera is a plain object with `lon`, `lat`, `range`, `heading`, `pitch`,
and `roll`. Longitude and latitude are degrees; heading, pitch, and roll are
radians. `range` is the camera-to-target distance in world units, where one
unit is the WGS84 semi-major axis (6,378,137 metres).
Drawing is on demand: mutate the camera and call `invalidate()`.
Keep camera values finite and range positive. Camera controls constrain latitude
to ±85 degrees. Ground picking intersects the reference ellipsoid; it does not
intersect a supplied terrain mesh. The low-resolution background ellipsoid is
slightly inset to leave room for overlay layers, so it is not a precision surface
for close-range measurements.

### Geodesy helpers

Layers that place geometry on the ellipsoid use the same WGS84 conversions as
the engine. The entry point exports them so a layer package does not have to
carry its own copy:

```ts
import { ecef, geodeticNormal, rayEllipsoid, WORLD_PER_METER } from 'teluala';

const p = ecef(lon, lat, altitudeMeters * WORLD_PER_METER); // world units, a = 1
const up = geodeticNormal(lon, lat);                         // unit normal
const hit = rayEllipsoid(origin, direction);                 // [lon, lat] | null
```

`WGS84_A` (= 1), `WGS84_F`, `WGS84_E2`, `D2R`, and the `Vec3` / `Mat4` types
are exported alongside. World coordinates are ECEF divided by the semi-major
axis; altitudes in metres convert with `WORLD_PER_METER`.

### Web Mercator tile selection

Tiled layers share one selector. It picks the zoom that matches the on-screen
resolution, covers the visible bounds, coarsens while the cover exceeds the
tile budget, and returns the tiles nearest the look-at point first.

```ts
import { selectWebMercatorTiles, resolveWebMercatorTileOptions } from 'teluala';

const tiles = selectWebMercatorTiles(frame, { minZoom: 2, maxZoom: 18, maxTiles: 160 });
// [{ z, x, y }, ...] nearest first; [] when the frame has no ground bounds

const limits = resolveWebMercatorTileOptions({ maxZoom: 18 }); // defaults applied, ranges checked
```

Resolution is measured per device pixel, so a high-DPR display selects a
finer zoom than its CSS size alone would. Parent/child bookkeeping (overzoom,
fallback) stays with the layer; the selector knows nothing about tile content.

## Layers

`GlobeLayer` is the rendering extension point. A layer initializes its GPU
resources once, receives a `FrameState`, and draws into the engine's shared
render pass.

```ts
import { LAYER_SPEC, type GlobeLayer } from 'teluala';

const layer: GlobeLayer = {
  name: 'example',
  layerSpec: LAYER_SPEC,
  sortKey: 200,
  init(context) {
    // Create pipelines and GPU resources from context.device.
  },
  update(frame) {
    return false;
  },
  draw(pass, frame) {
    // Encode this layer's draw calls.
  },
  destroy() {},
};

globe.attachLayer(layer);
globe.detachLayer('example');
```

The core owns one shared GPU picking pass so independently installed layers can
participate without coupling to one another. A layer may implement
`pickDraw()` to emit local IDs and `pickResolve()` to turn the selected ID into
its own result; the engine handles depth, ID ranges, readback, and dispatch.
Format-specific feature tables and selection logic remain in their layer
packages. Shared tile-source coordination and attribution aggregation are not
part of this beta contract.

### Plugin lifecycle

`usePlugins()` catches synchronous and asynchronous setup failures and cleans up
failed plugins. Its returned `dispose()` is idempotent. If an asynchronous setup
is still pending, cleanup runs after it settles; setup must therefore settle
rather than wait indefinitely. The API does not cancel a pending setup promise.

## Optional packages

The first beta also includes independent packages for elevation sources and
shared height sampling (`@teluala/terrain`), raster imagery (`@teluala/raster`),
and Mapbox Vector Tiles (`@teluala/vector`). The core examples do not need
them; see each package's README in this repository.

Layers attach through `GlobeLayer`; navigation plugins use `GlobePlugin`.
Applications will install only the packages they need.

## Ground surfaces

The terrain boundary is the format-independent `GroundSurface`.
The engine samples it for camera/ground calculations and listens for newly
available heights without knowing how they were fetched or decoded:

```ts
import type { GroundSurface } from 'teluala';

const ground: GroundSurface = {
  heightAt(lon, lat) {
    return cachedHeightInMetres(lon, lat) ?? 0;
  },
  subscribe(listener) {
    return heightCache.subscribe(listener);
  },
};

globe.setGroundSurface(ground);
```

An injected surface remains owned by the caller: replacing it or destroying
the engine removes the subscription but does not destroy the provider. This
allows one optional terrain provider to serve camera sampling and independent
rendering layers. DEM fetching, encodings, workers, cache,
displacement, and shading stay outside the core.

If the old subscription cannot be removed, replacement throws and keeps the
old surface selected. The engine first attempts to remove the new subscription;
if that cleanup also throws, both errors are reported in an `AggregateError`.
Providers are responsible for completing their own unsubscribe operations.

## Development and feedback

From the repository root:

```sh
npm ci
npm test
npm run example --workspace teluala
```

Open `http://localhost:4174/examples/basic/` in a WebGPU-capable browser.
The tests build the core and check its browser-independent behavior; they do
not replace testing rendering and interaction on a real GPU.

See [CONTRIBUTING](https://github.com/teluala/teluala/blob/main/CONTRIBUTING.md).
For a bug report, include a minimal reproduction, package version, browser and
OS versions, GPU information if available, and the expected and actual result.

## License

[MIT](LICENSE) © 2026 The Teluala Authors.
