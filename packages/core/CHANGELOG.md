# Changelog

## 0.1.0-beta.2

First release published to npm, together with `@teluala/terrain`,
`@teluala/raster`, and `@teluala/vector`. No API changes from 0.1.0-beta.1.

## 0.1.0-beta.1

Initial public beta, released on GitHub only.

- WebGPU globe engine with WGS84 ellipsoid rendering, camera controls,
  ground picking, and configurable camera limits and near-plane policy.
- Public WGS84 geodesy helpers and vector/matrix types for custom layers.
- Layer and plugin contracts, with an engine-owned shared GPU picking pass.
- `ControllerLayer`: the controller + backend layer shell (validation, init
  with rollback, entries, attribution, idempotent destroy) that layer
  packages subclass. `uploadBuffer()` and
  `BoundedCache.prune(isProtected, limit)` for the same backends.
- Format-independent `GroundSurface` injection. Subscriptions are detached
  on replacement or engine destruction; providers remain owned by the caller.
  Failed replacement attempts clean up the new subscription before returning an error.
- `selectWebMercatorTiles()` and `resolveWebMercatorTileOptions()`: one Web
  Mercator tile selector for every tiled layer. A golden test pins the
  selected tiles for fixed frames.
- `previewFrame()` builds the frame of a camera the engine is not at, without
  moving, drawing or caching anything, so a consumer can judge a destination
  view before flying to it.
- Double-precision frame matrices and `viewProjectionAt` /
  `composeViewProjection` helpers for placing local geometry accurately.
- Camera-basis ray construction for screen-space picking, and quantized
  view-bounds caching for small camera movements.
- Exception-safe, idempotent engine and plugin cleanup, including asynchronous
  plugin setup failures and pending ground notifications.
- Flight input validation, wrapped longitude/heading paths, and cancelled-drag cleanup.
- Render-pass state deduplication and optional bind-group dynamic offsets.
  `GlobeStats.setPipelines` counts calls submitted to the encoder.

Basemap imagery and data handling live in the optional packages
(`@teluala/terrain`, `@teluala/raster`, `@teluala/vector`). WebGPU is required;
the beta API may change before 1.0.
