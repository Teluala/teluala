# @teluala/terrain

Elevation sources and shared height sampling for the [Teluala](https://teluala.github.io/) WebGPU globe.

`@teluala/terrain` is an optional package for the core `teluala` package (a peer
dependency). It turns raster DEM tiles into a ground surface. Pass the surface to
`globe.setGroundSurface()`; layers such as `@teluala/raster` can sample the same
heights.

## Install

npm packages: coming soon. Until then, build the repository as described in
the [root README](../../README.md#install), then add this package together
with the core, giving the path to your clone:

```sh
npm install ../teluala/packages/core ../teluala/packages/terrain
```

## Usage

```js
import { GlobeEngine } from 'teluala';
import { createTerrainSurface, createWorkerXyzDemTileSource } from '@teluala/terrain';

const globe = await GlobeEngine.create(document.querySelector('canvas'));
const ground = createTerrainSurface({
  source: createWorkerXyzDemTileSource({
    url: 'https://dem.example.com/{z}/{x}/{y}.png',
    encoding: 'terrarium', // or 'terrainrgb'
  }),
  minZoom: 2,
  maxZoom: 10,
  attribution: ['Elevation © your DEM provider'],
});
globe.setGroundSurface(ground);
```

## Encodings

- `'terrarium'`: the Terrarium PNG format, as served by AWS Terrain Tiles
  (`elevation-tiles-prod` on the Registry of Open Data on AWS).
- `'terrainrgb'`: the Terrain-RGB format used by Mapbox Terrain-RGB and
  MapTiler Terrain RGB.

Each dataset has its own terms of use and attribution requirements; follow
those of your provider. For another format, implement `HeightTileSource`
(`getHeightTile()` resolving to a `HeightTile`) and pass it as `source`.

## License

MIT
