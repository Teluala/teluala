# @teluala/raster

XYZ raster imagery layers for the [Teluala](https://teluala.github.io/) WebGPU globe.

`@teluala/raster` is an optional layer package. It plugs into the core `teluala`
package through `globe.attachLayer()` and has no runtime dependencies besides
`teluala` itself (a peer dependency). Combine it with `@teluala/terrain` to drape
imagery over elevation.

## Install

Install this package together with the core:

```sh
npm install teluala@beta @teluala/raster@beta
```

## Usage

```js
import { GlobeEngine } from 'teluala';
import {
  createRasterController,
  createRasterLayer,
  createWebGpuRasterBackend,
  createXyzRasterTileSource,
} from '@teluala/raster';

const globe = await GlobeEngine.create(document.querySelector('canvas'));
const controller = createRasterController({
  source: createXyzRasterTileSource({ url: 'https://tiles.example.com/{z}/{x}/{y}.png' }),
  minZoom: 1,
  maxZoom: 8,
  attribution: ['Imagery © your tile provider'],
});
globe.attachLayer(createRasterLayer({ controller, backend: createWebGpuRasterBackend() }));
```

Pass `groundSurface` (for example a surface from `@teluala/terrain`) to the
controller to follow the terrain.

## License

MIT
