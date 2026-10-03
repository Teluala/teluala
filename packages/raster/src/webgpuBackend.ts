/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { FrameState, GlobeRenderPass, LayerContext } from 'teluala';
import {
  BoundedCache,
  D2R,
  WORLD_PER_METER,
  depthBiasForStratum,
  depthBiasSlopeScaleForStratum,
  ecef,
  geodeticNormal,
  uploadBuffer,
  viewProjectionAt,
} from 'teluala';

// Metres per world unit (the WGS84 semi-major axis), from core's own constant.
const EARTH_RADIUS_METERS = 1 / WORLD_PER_METER;

import { DEFAULT_MAX_CACHE_TILES, type RasterGpuBackend, type RasterRenderEntry } from './types.js';

// Vertices are Float32 offsets from the tile-centre origin (world units) plus
// the geodetic up vector; the tile is placed by vp × translate(origin) formed
// from the frame's double-precision vp64 (teluala `viewProjectionAt`). Float32
// world positions — and lon/lat evaluated in f32 on the GPU — carry a
// 0.2-1.2 m quantum that would let draped imagery and the geometry standing on
// it swap depth winners as the camera moves.
const VERTEX_FLOATS = 9; // offset f32x3, up f32x3, uv f32x2, drop f32
const PARAMS_BYTES = 80; // vp mat4x4<f32> (64) + resolution, heightScale, gradE, gradN (16)

const RASTER_WGSL = `
struct Params { vp: mat4x4<f32>, resolution: f32, heightScale: f32, gradE: f32, gradN: f32 };
@group(0) @binding(0) var tileTexture: texture_2d<f32>;
@group(0) @binding(1) var tileSampler: sampler;
@group(0) @binding(2) var heightTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn heightLoad(x: i32, y: i32, resolution: i32) -> f32 {
  return textureLoad(
    heightTexture,
    vec2<i32>(clamp(x, 0, resolution - 1), clamp(y, 0, resolution - 1)),
    0,
  ).r;
}

fn heightBilinear(uv: vec2<f32>) -> f32 {
  let resolution = i32(params.resolution);
  let position = uv * (params.resolution - 1.0);
  let x0 = i32(floor(position.x));
  let y0 = i32(floor(position.y));
  let fraction = position - vec2<f32>(f32(x0), f32(y0));
  let top = mix(
    heightLoad(x0, y0, resolution),
    heightLoad(x0 + 1, y0, resolution),
    fraction.x,
  );
  let bottom = mix(
    heightLoad(x0, y0 + 1, resolution),
    heightLoad(x0 + 1, y0 + 1, resolution),
    fraction.x,
  );
  return mix(top, bottom, fraction.y);
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) up: vec3<f32>,
};

@vertex fn vs(
  @location(0) offset: vec3<f32>,
  @location(1) up: vec3<f32>,
  @location(2) imageUv: vec2<f32>,
  @location(3) drop: f32,
) -> VertexOutput {
  var output: VertexOutput;
  let height = heightBilinear(imageUv);
  let local = offset + up * (height * params.heightScale) - up * drop;
  output.position = params.vp * vec4<f32>(local, 1.0);
  output.uv = imageUv;
  output.up = up;
  return output;
}

@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(tileTexture, tileSampler, input.uv);
  // Central difference at a continuous position. Sampling the rounded integer
  // grid halves the gradient along a tile edge, where heightLoad clamps one
  // side onto the sample itself, and that step reads as a grid of seams.
  // The span shrinks to one texel at an edge, so rescale to the two-texel
  // span gradE and gradN are expressed in. Without a height tile the
  // resolution is 1 and both gradients are 0, which keeps the span finite
  // and leaves the flat-lit result unchanged.
  let step = 1.0 / max(params.resolution - 1.0, 1.0);
  let lo = max(input.uv - vec2<f32>(step), vec2<f32>(0.0));
  let hi = min(input.uv + vec2<f32>(step), vec2<f32>(1.0));
  let slopeE = (
    heightBilinear(vec2<f32>(hi.x, input.uv.y))
      - heightBilinear(vec2<f32>(lo.x, input.uv.y))
  ) * params.gradE * (2.0 * step / max(hi.x - lo.x, step));
  let slopeN = (
    heightBilinear(vec2<f32>(input.uv.x, lo.y))
      - heightBilinear(vec2<f32>(input.uv.x, hi.y))
  ) * params.gradN * (2.0 * step / max(hi.y - lo.y, step));
  let up = normalize(input.up);
  var east = cross(vec3<f32>(0.0, 0.0, 1.0), up);
  let eastLength = length(east);
  east = select(vec3<f32>(1.0, 0.0, 0.0), east / max(eastLength, 1e-6), eastLength > 1e-4);
  let north = cross(up, east);
  let normal = normalize(-slopeE * east - slopeN * north + up);
  let azimuth = 5.4978;
  let elevation = 0.7854;
  let light = normalize(
    sin(elevation) * up
      + cos(elevation) * (sin(azimuth) * east + cos(azimuth) * north),
  );
  let shade = clamp(1.0 + (dot(normal, light) - dot(up, light)) * 2.2, 0.45, 1.35);
  return vec4<f32>(color.rgb * shade, 1.0);
}
`;

export interface WebGpuRasterBackendOptions {
  /** Requested minimum; coarse tiles use a curvature floor of at most two degrees per cell. */
  readonly subdivisions?: number;
  readonly maxCacheTiles?: number;
  readonly exaggeration?: number;
  /** Stacking order among layers on the same datum (integer >= 0, default 0 = base; each step draws nearer). */
  readonly stratum?: number;
}

export interface WebGpuRasterBackendSnapshot {
  readonly resources: number;
  readonly textures: number;
  readonly heightTextures: number;
  readonly bytes: number;
  readonly uploaded: number;
  readonly textureUploads: number;
  readonly reused: number;
  readonly destroyed: number;
  readonly draws: number;
}

export interface WebGpuRasterBackend extends RasterGpuBackend {
  snapshot(): WebGpuRasterBackendSnapshot;
}

interface RasterGpuResource {
  readonly image: ImageBitmap;
  readonly height: RasterRenderEntry['height'];
  readonly sourceKey: string;
  /** Tile-centre origin (world units, double): vertices are Float32 offsets from it. */
  readonly origin: readonly [number, number, number];
  /** Per-tile uniform: the placed view-projection (written per frame) and the height params. */
  readonly params: GPUBuffer;
  readonly vertex: GPUBuffer;
  readonly index: GPUBuffer;
  readonly indexCount: number;
  readonly bodyCount: number;
  readonly bindGroup: GPUBindGroup;
  readonly byteLength: number;
  destroy(): void;
}

interface RasterTextureResource {
  readonly image: ImageBitmap;
  readonly texture: GPUTexture;
  readonly byteLength: number;
  destroy(): void;
}

interface RasterIndexResource {
  readonly buffer: GPUBuffer;
  readonly count: number;
  readonly byteLength: number;
}

function tileIndices(subdivisions: number, skirt: boolean): Uint32Array {
  const width = subdivisions + 1;
  const bodyCount = subdivisions * subdivisions * 6;
  const values = new Uint32Array(bodyCount + (skirt ? subdivisions * 4 * 6 : 0));
  let offset = 0;
  for (let row = 0; row < subdivisions; row++) {
    for (let column = 0; column < subdivisions; column++) {
      const topLeft = row * width + column;
      const bottomLeft = topLeft + width;
      values.set(
        [topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1],
        offset,
      );
      offset += 6;
    }
  }
  if (skirt) {
    let skirtVertex = width * width;
    const quad = (first: number, second: number): void => {
      const skirtFirst = skirtVertex;
      skirtVertex += 2;
      values.set([first, second, skirtFirst + 1, first, skirtFirst + 1, skirtFirst], offset);
      offset += 6;
    };
    for (let column = 0; column < subdivisions; column++) quad(column, column + 1);
    for (let column = 0; column < subdivisions; column++) {
      quad(subdivisions * width + column, subdivisions * width + column + 1);
    }
    for (let row = 0; row < subdivisions; row++) quad(row * width, (row + 1) * width);
    for (let row = 0; row < subdivisions; row++) {
      quad(row * width + subdivisions, (row + 1) * width + subdivisions);
    }
  }
  return values;
}

function tileLatitude(entry: RasterRenderEntry, v: number): number {
  const mercatorY = (entry.tile.y + v) / 2 ** entry.tile.z;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180) / Math.PI;
}

function tileVertices(
  entry: RasterRenderEntry,
  subdivisions: number,
  exaggeration: number,
): { readonly values: Float32Array; readonly origin: readonly [number, number, number] } {
  const width = subdivisions + 1;
  const skirtVertices = entry.height ? subdivisions * 4 * 2 : 0;
  const values = new Float32Array((width * width + skirtVertices) * VERTEX_FLOATS);
  const origin = ecef((entry.bounds.west + entry.bounds.east) / 2, tileLatitude(entry, 0.5), 0);
  let offset = 0;
  const addVertex = (row: number, column: number, drop: number): void => {
    const v = row / subdivisions;
    const u = column / subdivisions;
    const textureV = entry.uv.north + (entry.uv.south - entry.uv.north) * v;
    const textureU = entry.uv.west + (entry.uv.east - entry.uv.west) * u;
    const longitude = entry.bounds.west + (entry.bounds.east - entry.bounds.west) * u;
    const latitude = tileLatitude(entry, v);
    const surface = ecef(longitude, latitude, 0);
    const up = geodeticNormal(longitude, latitude);
    values[offset++] = surface[0] - origin[0];
    values[offset++] = surface[1] - origin[1];
    values[offset++] = surface[2] - origin[2];
    values[offset++] = up[0];
    values[offset++] = up[1];
    values[offset++] = up[2];
    values[offset++] = textureU;
    values[offset++] = textureV;
    values[offset++] = drop;
  };
  for (let row = 0; row <= subdivisions; row++) {
    for (let column = 0; column <= subdivisions; column++) {
      addVertex(row, column, 0);
    }
  }
  if (entry.height) {
    const drop = 4e-5 * (1 + exaggeration);
    const addEdge = (
      firstRow: number,
      firstColumn: number,
      secondRow: number,
      secondColumn: number,
    ): void => {
      addVertex(firstRow, firstColumn, drop);
      addVertex(secondRow, secondColumn, drop);
    };
    for (let column = 0; column < subdivisions; column++) {
      addEdge(0, column, 0, column + 1);
    }
    for (let column = 0; column < subdivisions; column++) {
      addEdge(subdivisions, column, subdivisions, column + 1);
    }
    for (let row = 0; row < subdivisions; row++) {
      addEdge(row, 0, row + 1, 0);
    }
    for (let row = 0; row < subdivisions; row++) {
      addEdge(row, subdivisions, row + 1, subdivisions);
    }
  }
  return { values, origin };
}

// Per-frame staging for the placed view-projection, reused across tiles.
const matrixStaging = new Float32Array(16);

class DefaultWebGpuRasterBackend implements WebGpuRasterBackend {
  #context: LayerContext | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #sampler: GPUSampler | null = null;
  #dummyHeight: GPUTexture | null = null;
  #indices = new Map<string, RasterIndexResource>();
  #resources: BoundedCache<string, RasterGpuResource>;
  #textures = new Map<string, RasterTextureResource>();
  #drawResources: RasterGpuResource[] = [];
  #lastEntries: readonly RasterRenderEntry[] | null = null;
  #destroyed = false;
  #subdivisions: number;
  #exaggeration: number;
  #depthBias: number;
  #depthBiasSlopeScale: number;
  #metrics = { uploaded: 0, textureUploads: 0, reused: 0, destroyed: 0, draws: 0 };

  constructor(options: WebGpuRasterBackendOptions) {
    this.#subdivisions = options.subdivisions ?? 12;
    const maxCacheTiles = options.maxCacheTiles ?? DEFAULT_MAX_CACHE_TILES;
    if (!Number.isInteger(maxCacheTiles) || maxCacheTiles < 1) {
      throw new RangeError('maxCacheTiles must be a positive integer');
    }
    this.#resources = new BoundedCache({ limit: maxCacheTiles });
    this.#exaggeration = options.exaggeration ?? 1;
    this.#depthBias = depthBiasForStratum(options.stratum);
    this.#depthBiasSlopeScale = depthBiasSlopeScaleForStratum(options.stratum);
    if (
      !Number.isInteger(this.#subdivisions) ||
      this.#subdivisions < 1 ||
      this.#subdivisions > 128
    ) {
      throw new RangeError('subdivisions must be an integer within 1..128');
    }
    if (!Number.isFinite(this.#exaggeration) || this.#exaggeration < 0) {
      throw new RangeError('exaggeration must be a non-negative finite value');
    }
  }

  init(context: LayerContext): void {
    if (this.#destroyed) throw new Error('WebGPU raster backend is destroyed');
    if (this.#context) throw new Error('WebGPU raster backend is already initialized');
    this.#context = context;
    const module = context.device.createShaderModule({ code: RASTER_WGSL });
    this.#pipeline = context.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
              { shaderLocation: 3, offset: 32, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: context.colorFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: context.depthFormat,
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: this.#depthBias,
        depthBiasSlopeScale: this.#depthBiasSlopeScale,
        depthBiasClamp: 0,
        stencilFront: {
          compare: 'equal',
          passOp: 'increment-clamp',
          failOp: 'keep',
          depthFailOp: 'keep',
        },
        stencilBack: {
          compare: 'equal',
          passOp: 'increment-clamp',
          failOp: 'keep',
          depthFailOp: 'keep',
        },
      },
      multisample: { count: context.samples },
    });
    this.#sampler = context.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#dummyHeight = context.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  #subdivisionsFor(entry: RasterRenderEntry): number {
    // Mercator's largest angular step is at the equator. Apply the same
    // curvature floor to flat and DEM meshes so coarse chords do not sink
    // through the globe base. At z0 this requires 180 subdivisions.
    return Math.max(this.#subdivisions, Math.ceil(180 / 2 ** entry.tile.z));
  }

  #indexFor(subdivisions: number, skirt: boolean): RasterIndexResource {
    const key = `${subdivisions}:${skirt ? 'skirt' : 'flat'}`;
    const existing = this.#indices.get(key);
    if (existing) return existing;
    const context = this.#context;
    if (!context) throw new Error('WebGPU raster backend is not initialized');
    const values = tileIndices(subdivisions, skirt);
    const created = {
      buffer: uploadBuffer(context.device, values, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST),
      count: values.length,
      byteLength: values.byteLength,
    };
    this.#indices.set(key, created);
    return created;
  }

  #discardSource(sourceKey: string): void {
    for (const [key, resource] of this.#resources) {
      if (resource.sourceKey !== sourceKey) continue;
      resource.destroy();
      this.#resources.delete(key);
      this.#metrics.destroyed++;
    }
    this.#textures.get(sourceKey)?.destroy();
    this.#textures.delete(sourceKey);
  }

  #textureFor(entry: RasterRenderEntry): RasterTextureResource {
    const context = this.#context;
    if (!context) {
      throw new Error('WebGPU raster backend is not initialized');
    }
    if (
      !Number.isFinite(entry.image.width) ||
      !Number.isFinite(entry.image.height) ||
      entry.image.width < 1 ||
      entry.image.height < 1
    ) {
      throw new RangeError('raster image dimensions must be positive');
    }
    const existing = this.#textures.get(entry.sourceKey);
    if (existing?.image === entry.image) return existing;
    if (existing) this.#discardSource(entry.sourceKey);
    const texture = context.device.createTexture({
      size: [entry.image.width, entry.image.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      context.device.queue.copyExternalImageToTexture({ source: entry.image }, { texture }, [
        entry.image.width,
        entry.image.height,
      ]);
      const value = {
        image: entry.image,
        texture,
        byteLength: entry.image.width * entry.image.height * 4,
        destroy: () => texture.destroy(),
      };
      this.#textures.set(entry.sourceKey, value);
      this.#metrics.textureUploads++;
      return value;
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }

  #createResource(entry: RasterRenderEntry): RasterGpuResource {
    const context = this.#context;
    const pipeline = this.#pipeline;
    const sampler = this.#sampler;
    const dummyHeight = this.#dummyHeight;
    if (!context || !pipeline || !sampler || !dummyHeight) {
      throw new Error('WebGPU raster backend is not initialized');
    }
    const texture = this.#textureFor(entry);
    const subdivisions = this.#subdivisionsFor(entry);
    const height = entry.height;
    if (
      height &&
      (!Number.isInteger(height.size) ||
        height.size < 2 ||
        !(height.data instanceof Float32Array) ||
        height.data.length !== height.size * height.size)
    ) {
      throw new TypeError('raster height tile must be a square Float32Array with size >= 2');
    }
    const index = this.#indexFor(subdivisions, height !== undefined);
    const { values: vertices, origin } = tileVertices(entry, subdivisions, this.#exaggeration);
    let heightTexture = dummyHeight;
    let params: GPUBuffer | null = null;
    let vertex: GPUBuffer | null = null;
    try {
      if (height) {
        heightTexture = context.device.createTexture({
          size: [height.size, height.size],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const rowBytes = height.size * 4;
        const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
        const upload = new Float32Array((bytesPerRow / 4) * height.size);
        for (let row = 0; row < height.size; row++) {
          upload.set(
            height.data.subarray(row * height.size, (row + 1) * height.size),
            (row * bytesPerRow) / 4,
          );
        }
        context.device.queue.writeTexture(
          { texture: heightTexture },
          upload,
          { bytesPerRow, rowsPerImage: height.size },
          [height.size, height.size],
        );
      }
      const latitudeMidpoint = (entry.bounds.north + entry.bounds.south) / 2;
      const metresEast = height
        ? ((entry.bounds.east - entry.bounds.west) *
            D2R *
            EARTH_RADIUS_METERS *
            Math.cos(latitudeMidpoint * D2R)) /
          Math.max(1, height.size - 1)
        : 1;
      const metresNorth = height
        ? ((entry.bounds.north - entry.bounds.south) * D2R * EARTH_RADIUS_METERS) /
          Math.max(1, height.size - 1)
        : 1;
      params = context.device.createBuffer({
        size: PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      context.device.queue.writeBuffer(
        params,
        64,
        new Float32Array([
          height?.size ?? 1,
          height ? this.#exaggeration / EARTH_RADIUS_METERS : 0,
          height ? this.#exaggeration / (2 * Math.max(metresEast, 1e-6)) : 0,
          height ? this.#exaggeration / (2 * Math.max(metresNorth, 1e-6)) : 0,
        ]),
      );
      vertex = uploadBuffer(
        context.device,
        vertices,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      const bindGroup = context.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.texture.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: heightTexture.createView() },
          { binding: 3, resource: { buffer: params } },
        ],
      });
      const paramsBuffer = params;
      return {
        image: entry.image,
        height,
        sourceKey: entry.sourceKey,
        origin,
        params: paramsBuffer,
        vertex,
        index: index.buffer,
        indexCount: index.count,
        bodyCount: subdivisions * subdivisions * 6,
        bindGroup,
        byteLength: vertices.byteLength + PARAMS_BYTES + (height ? height.data.byteLength : 0),
        destroy() {
          vertex?.destroy();
          params?.destroy();
          if (height) heightTexture.destroy();
        },
      };
    } catch (error) {
      vertex?.destroy();
      params?.destroy();
      if (height) heightTexture.destroy();
      throw error;
    }
  }

  draw(pass: GlobeRenderPass, frame: FrameState, entries: readonly RasterRenderEntry[]): void {
    if (this.#destroyed) throw new Error('WebGPU raster backend is destroyed');
    const context = this.#context;
    if (!context || !this.#pipeline) {
      throw new Error('WebGPU raster backend is not initialized');
    }
    if (!(frame.vp instanceof Float32Array) || frame.vp.length !== 16) {
      throw new TypeError('FrameState.vp must be a 16-value Float32Array');
    }
    if (entries !== this.#lastEntries) {
      const current = new Set(entries.map((entry) => entry.key));
      this.#drawResources = [];
      for (const entry of entries) {
        let resource = this.#resources.peek(entry.key);
        if (
          resource &&
          (resource.image !== entry.image ||
            resource.sourceKey !== entry.sourceKey ||
            resource.height !== entry.height)
        ) {
          resource.destroy();
          this.#resources.delete(entry.key);
          this.#metrics.destroyed++;
          resource = undefined;
        }
        if (resource) {
          this.#resources.get(entry.key); // touch: drawn this frame
          this.#metrics.reused++;
        } else {
          resource = this.#createResource(entry);
          this.#resources.set(entry.key, resource);
          this.#metrics.uploaded++;
        }
        this.#drawResources.push(resource);
      }
      for (const [, resource] of this.#resources.prune((key) => current.has(key))) {
        resource.destroy();
        this.#metrics.destroyed++;
      }
      const referencedSources = new Set(
        [...this.#resources.values()].map((resource) => resource.sourceKey),
      );
      for (const [sourceKey, texture] of this.#textures) {
        if (referencedSources.has(sourceKey)) continue;
        texture.destroy();
        this.#textures.delete(sourceKey);
      }
      this.#lastEntries = entries;
    } else {
      this.#metrics.reused += entries.length;
    }
    for (const resource of this.#drawResources) {
      const [originX, originY, originZ] = resource.origin;
      viewProjectionAt(matrixStaging, frame.vp, frame.vp64, originX, originY, originZ);
      context.device.queue.writeBuffer(resource.params, 0, matrixStaging);
    }
    pass.setPipeline(this.#pipeline);
    pass.setStencilReference(0);
    let currentIndex: GPUBuffer | null = null;
    for (const resource of this.#drawResources) {
      pass.setBindGroup(0, resource.bindGroup);
      pass.setVertexBuffer(0, resource.vertex);
      if (resource.index !== currentIndex) {
        currentIndex = resource.index;
        pass.setIndexBuffer(resource.index, 'uint32');
      }
      pass.drawIndexed(resource.bodyCount, 1, 0);
      this.#metrics.draws++;
    }
    for (const resource of this.#drawResources) {
      if (resource.indexCount <= resource.bodyCount) continue;
      pass.setBindGroup(0, resource.bindGroup);
      pass.setVertexBuffer(0, resource.vertex);
      if (resource.index !== currentIndex) {
        currentIndex = resource.index;
        pass.setIndexBuffer(resource.index, 'uint32');
      }
      pass.drawIndexed(resource.indexCount - resource.bodyCount, 1, resource.bodyCount);
      this.#metrics.draws++;
    }
  }

  snapshot(): WebGpuRasterBackendSnapshot {
    return {
      resources: this.#resources.size,
      textures: this.#textures.size,
      heightTextures: [...this.#resources.values()].filter(
        (resource) => resource.height !== undefined,
      ).length,
      bytes:
        [...this.#indices.values()].reduce((sum, index) => sum + index.byteLength, 0) +
        [...this.#resources.values()].reduce((sum, resource) => sum + resource.byteLength, 0) +
        [...this.#textures.values()].reduce((sum, texture) => sum + texture.byteLength, 0),
      ...this.#metrics,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const resource of this.#resources.values()) {
      resource.destroy();
      this.#metrics.destroyed++;
    }
    this.#resources.clear();
    for (const texture of this.#textures.values()) texture.destroy();
    this.#textures.clear();
    this.#drawResources = [];
    this.#lastEntries = null;
    this.#dummyHeight?.destroy();
    for (const index of this.#indices.values()) index.buffer.destroy();
    this.#indices.clear();
    this.#dummyHeight = null;
    this.#sampler = null;
    this.#pipeline = null;
    this.#context = null;
  }
}

export function createWebGpuRasterBackend(
  options: WebGpuRasterBackendOptions = {},
): WebGpuRasterBackend {
  return new DefaultWebGpuRasterBackend(options);
}
