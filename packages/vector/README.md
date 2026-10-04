# @teluala/vector

Mapbox Vector Tile (MVT) layers for the [Teluala](https://teluala.github.io/) WebGPU globe.

`@teluala/vector` is an optional layer package for the core `teluala` package (a
peer dependency). Tiles are decoded in a module worker and drawn through
`globe.attachLayer()`. The worker bundles `@mapbox/vector-tile`, `pbf` and
`earcut`; see `THIRD_PARTY_NOTICES.txt`.

## Install

Install this package together with the core:

```sh
npm install teluala@beta @teluala/vector@beta
```

## Usage

```js
import { GlobeEngine } from 'teluala';
import {
  createDefaultMvtWorkerProcessor,
  createMvtVectorController,
  createVectorLayer,
  createWebGpuVectorBackend,
  createXyzMvtTileSource,
} from '@teluala/vector';

const globe = await GlobeEngine.create(document.querySelector('canvas'));
const controller = createMvtVectorController({
  sourceId: 'basemap',
  source: createXyzMvtTileSource({ urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.pbf', maxZoom: 14 }),
  processor: createDefaultMvtWorkerProcessor(),
  style: {
    version: 1,
    layers: [
      { id: 'water', sourceLayer: 'water', type: 'fill', paint: { color: '#7fb3d5' } },
      { id: 'roads', sourceLayer: 'transportation', type: 'line', paint: { color: '#888888', width: 1 } },
    ],
  },
  processorOptions: { sourceLayers: ['water', 'transportation'] },
  maxNativeZoom: 14,
  attribution: ['© your tile provider'],
});
globe.attachLayer(createVectorLayer({ name: 'basemap', controller, backend: createWebGpuVectorBackend() }));
```

`sourceLayer` names come from the tile schema of your provider.

## License

MIT
