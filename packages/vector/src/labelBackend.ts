/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { repeatedPathSamples, rotatedBox, graphemes, lineTextSamples } from './symbolLayout.js';
import {
  WORLD_PER_METER,
  ecef,
  geodeticNormal,
  type FrameState,
  type GlobeRenderPass,
  type LayerContext,
} from 'teluala';
import type { VectorSpriteAtlas } from './sprites.js';
import type { VectorLabel } from './types.js';

/** A label may overlap an already placed box when its style opts out of
 * colliding with the style that placed it. Unattributed boxes always collide. */
export function labelIgnoresCollision(label: VectorLabel, placedStyleId?: string): boolean {
  return (
    placedStyleId !== undefined && (label.ignoreCollisionWith?.includes(placedStyleId) ?? false)
  );
}

// Text is rasterized only when its content/style changes. Positions are updated
// in CSS pixels each frame; the shared engine render pass owns compositing.
const SHADER = `
struct U { rect: vec4<f32>, axes: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let corners = array<vec2<f32>, 4>(vec2<f32>(0,0), vec2<f32>(1,0), vec2<f32>(1,1), vec2<f32>(0,1));
  var o: Out;
  o.uv = corners[i];
  o.position = vec4<f32>(u.rect.xy + (corners[i].x-0.5)*u.axes.xy + (corners[i].y-0.5)*u.axes.zw, 0, 1);
  return o;
}
@fragment fn fs(i: Out) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, i.uv);
}`;

/** Project an ellipsoid anchor; reject the far side and the clip volume. */
export function projectLabel(
  label: Pick<VectorLabel, 'lon' | 'lat'>,
  frame: FrameState,
  altitude: number,
  allowOutside = false,
): [number, number] | null {
  const p = ecef(label.lon, label.lat, altitude * WORLD_PER_METER);
  const normal = geodeticNormal(label.lon, label.lat);
  if (normal.reduce((sum, v, i) => sum + v * (frame.cameraPosWorld[i] - p[i]), 0) <= 0) return null;
  const m = frame.vp64 ?? frame.vp;
  const clip = [0, 1, 2, 3].map((i) => m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12]);
  const [x, y, z, w] = clip;
  if (w <= 0 || z < 0 || z > w || (!allowOutside && (Math.abs(x) > w || Math.abs(y) > w))) {
    return null;
  }
  const dpr = frame.viewportPx.dpr || 1;
  return [
    ((x / w + 1) * frame.viewportPx.width) / dpr / 2,
    ((1 - y / w) * frame.viewportPx.height) / dpr / 2,
  ];
}

type Box = readonly [number, number, number, number];
export function labelBoxesOverlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
interface TextResource {
  signature: string;
  width: number;
  height: number;
  texture: GPUTexture;
  uniform: GPUBuffer;
  group: GPUBindGroup;
}

export class LabelBackend {
  #atlas: VectorSpriteAtlas | null = null;
  #advances = new Map<string, number[]>();
  setSpriteAtlas(atlas: VectorSpriteAtlas | null): void {
    this.#atlas = atlas;
    this.#clear();
    this.context.invalidate();
  }
  #pipeline: GPURenderPipeline | null = null;
  #indices: GPUBuffer | null = null;
  #sampler: GPUSampler | null = null;
  #resources = new Map<string, TextResource>();
  #fontChanged: () => void;
  constructor(
    private context: LayerContext,
    private altitude: number,
  ) {
    this.#fontChanged = () => {
      this.#clear();
      context.invalidate();
    };
    if (typeof document !== 'undefined') {
      document.fonts?.addEventListener('loadingdone', this.#fontChanged);
    }
  }
  #clear(): void {
    this.#advances.clear();
    for (const r of this.#resources.values()) {
      r.texture.destroy();
      r.uniform.destroy();
    }
    this.#resources.clear();
  }
  #init(): void {
    if (this.#pipeline) return;
    const { device, colorFormat, depthFormat, samples } = this.context;
    const module = device.createShaderModule({ code: SHADER });
    this.#pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: samples },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.#indices = device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.#indices, 0, new Uint16Array([0, 1, 2, 0, 2, 3]));
    this.#sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }
  #text(label: VectorLabel, dpr: number): TextResource {
    const signature = JSON.stringify([
      label.text,
      label.size,
      label.fontFamily,
      label.color,
      label.haloColor,
      label.haloWidth,
      label.icon,
      label.iconSize,
      label.iconTextFit,
      label.iconPadding,
      label.textOffset,
      dpr,
    ]);
    const previous = this.#resources.get(label.key);
    if (previous?.signature === signature) return previous;
    if (previous) {
      previous.texture.destroy();
      previous.uniform.destroy();
      this.#resources.delete(label.key);
    }
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is required for vector labels');
    const font = `${label.size}px ${label.fontFamily}`;
    ctx.font = font;
    const metrics = ctx.measureText(label.text);
    const padding = label.haloWidth + 2;
    const left = Math.max(0, metrics.actualBoundingBoxLeft);
    const ascent = Math.max(label.size, metrics.actualBoundingBoxAscent);
    const descent = Math.max(label.size * 0.3, metrics.actualBoundingBoxDescent);
    const sprite = label.icon ? this.#atlas?.entries[label.icon] : undefined;
    let iconWidth = sprite ? (sprite.width / sprite.pixelRatio) * (label.iconSize ?? 1) : 0;
    let iconHeight = sprite ? (sprite.height / sprite.pixelRatio) * (label.iconSize ?? 1) : 0;
    if (sprite && label.iconTextFit === 'both') {
      iconWidth = Math.max(iconWidth, metrics.width + 2 * (label.iconPadding?.[0] ?? 4));
      iconHeight = Math.max(iconHeight, ascent + descent + 2 * (label.iconPadding?.[1] ?? 2));
    }
    const contentWidth = Math.max(
      iconWidth,
      Math.ceil(Math.max(metrics.width, left + metrics.actualBoundingBoxRight) + padding * 2),
    );
    const contentHeight = Math.max(
      iconHeight,
      label.text ? Math.ceil(ascent + descent + padding * 2) : 0,
    );
    const width = contentWidth + 2 * Math.abs(label.textOffset?.[0] ?? 0),
      height = contentHeight + 2 * Math.abs(label.textOffset?.[1] ?? 0);
    // Bound glyph textures, including malformed or unusually long text properties.
    const scale = Math.min(dpr, 2048 / width, 512 / height);
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.shadowColor = label.haloColor;
    ctx.shadowBlur = label.haloWidth;
    if (sprite && this.#atlas) {
      ctx.drawImage(
        this.#atlas.image,
        sprite.x,
        sprite.y,
        sprite.width,
        sprite.height,
        (width - iconWidth) / 2,
        (height - iconHeight) / 2,
        iconWidth,
        iconHeight,
      );
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = label.haloColor;
    ctx.lineWidth = label.haloWidth * 2;
    ctx.translate(label.textOffset?.[0] ?? 0, label.textOffset?.[1] ?? 0);
    ctx.fillStyle = label.color;
    if (label.haloWidth > 0) {
      ctx.strokeText(label.text, (width - metrics.width) / 2, (height + ascent - descent) / 2);
    }
    ctx.fillText(label.text, (width - metrics.width) / 2, (height + ascent - descent) / 2);
    const { device } = this.context;
    const texture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const uniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    try {
      device.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture, premultipliedAlpha: true },
        [canvas.width, canvas.height],
      );
      const group = device.createBindGroup({
        layout: this.#pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.#sampler! },
        ],
      });
      const resource = { signature, width, height, texture, uniform, group };
      this.#resources.set(label.key, resource);
      return resource;
    } catch (error) {
      texture.destroy();
      uniform.destroy();
      throw error;
    }
  }
  draw(pass: GlobeRenderPass, frame: FrameState, labels: readonly VectorLabel[]): void {
    const expanded: Array<{
      label: VectorLabel;
      anchor: readonly [number, number];
      angle: number;
      group?: string;
    }> = [];
    for (const label of labels) {
      if (label.path) {
        let run: Array<readonly [number, number]> = [];
        let part = 0;
        const flush = () => {
          if (label.text && !label.icon) {
            const glyphs = graphemes(label.text);
            const measureKey = JSON.stringify([label.text, label.size, label.fontFamily]);
            let advances = this.#advances.get(measureKey);
            if (!advances) {
              const c = new OffscreenCanvas(1, 1).getContext('2d')!;
              c.font = `${label.size}px ${label.fontFamily}`;
              advances = glyphs.map((g) => c.measureText(g).width);
              if (this.#advances.size >= 512) {
                this.#advances.delete(this.#advances.keys().next().value!);
              }
              this.#advances.set(measureKey, advances);
            }
            const samples = lineTextSamples(run, advances);
            if (samples.length && expanded.length + samples.length <= 512) {
              const group = `${label.key}/${part}`;
              for (const [i, p] of samples.entries()) {
                expanded.push({
                  label: { ...label, text: glyphs[i], key: `${group}/${i}` },
                  anchor: [p.x, p.y],
                  angle: p.angle,
                  group,
                });
              }
            }
            run = [];
            part++;
            return;
          }
          for (const [i, p] of repeatedPathSamples(
            run,
            label.repeatDistance ?? 100,
            512 - expanded.length,
          ).entries()) {
            const vw = frame.viewportPx.width / (frame.viewportPx.dpr || 1),
              vh = frame.viewportPx.height / (frame.viewportPx.dpr || 1);
            if (p.x < -128 || p.y < -128 || p.x > vw + 128 || p.y > vh + 128) continue;
            expanded.push({
              label: { ...label, key: `${label.key}/${part}/${i}` },
              anchor: [p.x, p.y],
              angle: p.angle,
            });
          }
          run = [];
          part++;
        };
        for (const [lon, lat] of label.path) {
          const p = projectLabel({ lon, lat }, frame, this.altitude, true);
          if (p) run.push(p);
          else flush();
        }
        flush();
      } else {
        const anchor = projectLabel(label, frame, this.altitude);
        if (anchor) {
          expanded.push({
            label,
            anchor,
            angle: ((label.rotation ?? 0) * Math.PI) / 180,
            group: label.collisionGroup,
          });
        }
      }
      // Point groups may span tile records; never truncate their members here.
      // Candidate/draw budgets are applied to complete groups below.
    }
    const current = new Set(expanded.map(({ label }) => label.key));
    for (const [key, r] of this.#resources) {
      if (!current.has(key)) {
        r.texture.destroy();
        r.uniform.destroy();
        this.#resources.delete(key);
      }
    }
    if (!labels.length) return;
    this.#init();
    const boxes: { box: Box; styleId?: string }[] = [];
    const dpr = frame.viewportPx.dpr || 1;
    const width = frame.viewportPx.width / dpr,
      height = frame.viewportPx.height / dpr;
    const used = new Set<string>();
    let candidates = 0;
    const groups = new Map<string, typeof expanded>();
    for (const item of expanded) {
      const key = item.group ?? item.label.key;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (used.size + group.length > 256 || candidates + group.length > 512) break;
      candidates += group.length;
      const draws = [];
      for (const { label, anchor, angle } of group) {
        if (label.icon && !this.#atlas?.entries[label.icon] && !label.text) continue;
        const r = this.#text(label, dpr),
          x = anchor[0] + label.offset[0],
          y = anchor[1] + label.offset[1];
        draws.push({ label, r, x, y, angle, box: rotatedBox(x, y, r.width, r.height, angle) });
      }
      if (
        draws.length !== group.length ||
        draws.some(
          (d) =>
            !d.label.allowOverlap &&
            boxes.some(
              (b) => !labelIgnoresCollision(d.label, b.styleId) && labelBoxesOverlap(d.box, b.box),
            ),
        )
      ) {
        continue;
      }
      for (const { label, r, x, y, angle, box } of draws) {
        boxes.push({ box, styleId: label.styleId });
        used.add(label.key);
        this.context.device.queue.writeBuffer(
          r.uniform,
          0,
          new Float32Array([
            (2 * x) / width - 1,
            1 - (2 * y) / height,
            0,
            0,
            (2 * r.width * Math.cos(angle)) / width,
            (-2 * r.width * Math.sin(angle)) / height,
            (-2 * r.height * Math.sin(angle)) / width,
            (-2 * r.height * Math.cos(angle)) / height,
          ]),
        );
        pass.setPipeline(this.#pipeline!);
        pass.setBindGroup(0, r.group);
        pass.setIndexBuffer(this.#indices!, 'uint16');
        pass.drawIndexed(6);
      }
    }
    // Keep a small warm cache while preventing unbounded GPU residency.
    for (const [key, r] of this.#resources) {
      if (this.#resources.size <= 512) break;
      if (!used.has(key)) {
        r.texture.destroy();
        r.uniform.destroy();
        this.#resources.delete(key);
      }
    }
  }
  destroy(): void {
    if (typeof document !== 'undefined') {
      document.fonts?.removeEventListener('loadingdone', this.#fontChanged);
    }
    this.#clear();
    this.#indices?.destroy();
    this.#indices = null;
    this.#pipeline = null;
    this.#sampler = null;
  }
}
