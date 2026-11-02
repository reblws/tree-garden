import type { BranchTopology } from '../core/branching'
import type { Segments2D } from '../core/geometry'
import type { Frame } from './frame'
import type { Palette } from './palette'
import {
  MAX_CHAIN_POSITION,
  PEN_WEIGHTS,
  type SlotPlan,
  type WidthLaw,
  coolness,
  RADIUS_ROW,
  chainPrevious,
  jointDirections,
  nextArrivals,
  packSegmentMeta,
  planSlots,
  slotClass,
  twigAlpha,
  widthClassOf,
} from './twigPlan'

/**
 * The twigs on the GPU (WebGL2): hundreds of thousands of polyline pieces,
 * 60–80% of a big tree, drawn as instanced capsules with analytic
 * (signed-distance) anti-aliasing, then laid on the Canvas2D ink layer
 * where the Canvas2D painter would have stroked them, under the brush.
 * The brush, its bark and its wet rim stay in Canvas2D (inkBrush.ts).
 *
 * WHAT IT REPRODUCES. The Canvas2D painter strokes one path per (tone
 * class, width class): within a class twigs form a union (overlaps don't
 * pool), and the classes go down one over the other, in order. Here each
 * class has a coverage channel (a "slot") in a set of RGBA8 targets:
 * capsules write their coverage into their slot with `MAX` blending (the
 * union), and a resolve pass composites the slots in the painter's order,
 * each in its tone and alpha (density dilution and aerial perspective
 * included). Where two classes cross, the ink pools, as on the canvas.
 *
 * JOINTS. `max` is an exact union only where shapes overlap whole; for
 * twigs a pixel or less wide, overlapping round caps at every joint would
 * still differ from one stroked polyline. So where a chain goes on in the
 * same class, the two pieces split the joint along the bisector of their
 * directions (where their union changes hands) and each pixel is painted
 * by one of them only; where the class changes, both keep round caps and
 * pool, exactly like the canvas, whose new path starts with a cap there.
 *
 * WHAT RUNS WHERE. The geometry, arrival distances and radii go up as they
 * are, plus static per-segment words built once per geometry (chain
 * position, chain start and tone; neighbours in the chain; their
 * directions). A transform-feedback pre-pass, one vertex per segment, does
 * the rest once a frame: the reveal (Grow by arrival, Trace by order), the
 * twig test (the same radius thresholds and budget cut-offs the Canvas2D
 * painter used, see twigPlan.ts), promotion of wide twigs to brush strokes
 * when zoomed in, the width class, the slot, the joints and the camera, so
 * a zoom or pan is a change of uniforms. The coverage passes (16 slots
 * each) only expand what it prepared into quads. During playback only the
 * radii (which grow) are uploaded each frame, through a staging buffer.
 *
 * The Line style's pens use the same machinery: four slots, one per pen.
 *
 * FALLBACK. `createGpuInk` returns undefined without WebGL2; a lost context
 * makes `isAvailable` false (the painters then draw on the canvas) and
 * calls `onChange`, as does its restoration, so the owner can repaint. The
 * print never uses this.
 */

export interface TwigRequest {
  readonly law: WidthLaw
  /** Radius from which a segment is a brush stroke (see twigPlan.radiusFor). */
  readonly brushRadius: number
  /** Radius from which a twig on screen is promoted to a brush stroke
   *  (infinite when nothing is promoted). */
  readonly promoteRadius: number
  /** Chain positions from which the brush and the promotion budgets are
   *  spent (infinite when they weren't). */
  readonly coarseCut: number
  readonly promoteCut: number
  /** Widest twig, plate px, that can be on screen. */
  readonly maxTwigWidth: number
  readonly dilution: number
}

export interface GpuInk {
  /** WebGL2 is up and its context isn't lost. */
  readonly isAvailable: () => boolean
  /** The twigs of `frame`, drawn on a canvas the size of `width` × `height`
   *  in screen pixels, ready to be laid on the ink layer with an identity
   *  transform; undefined if the GPU failed (draw them on the canvas). */
  readonly twigs: (frame: Frame, request: TwigRequest, width: number, height: number) => CanvasImageSource | undefined
  /** The Line style's pens, likewise. */
  readonly pens: (frame: Frame, width: number, height: number) => CanvasImageSource | undefined
  readonly dispose: () => void
}

/** Slots per tone class, at most: 8 hold every width class of a finished
 *  plate, 16 those of a playback draft. Past that, neighbouring classes
 *  share a slot. */
const PER_TONE = 16
/** Targets per pass (4 channels each). */
const MAX_TARGETS = 4
const NO_CUT = 0xffffffff
/** Texture unit of the radii (the resolve uses 0 .. MAX_TARGETS - 1). */
const RADIUS_UNIT = MAX_TARGETS + 1

const PREP_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aSeg;
layout(location = 1) in float aArrival;
layout(location = 2) in int aPrev;      // the previous piece of the chain, -1 at its start
layout(location = 3) in uint aMeta;
layout(location = 4) in int aNext;
layout(location = 5) in float aNextArrival;
layout(location = 6) in vec4 aDirs;   // directions of the previous and next piece of the chain
uniform vec3 uScreen;     // generator units to screen px: x * s + ox, oy - y * s
uniform vec3 uPlate;      // generator units to plate px: scale, offsetX, offsetY
uniform float uZoom;
uniform float uDpr;
uniform vec2 uReveal;     // threshold, 1 for Grow (by arrival) or 0 for Trace (by index)
uniform vec2 uLaw;        // tip, exponent
uniform int uMode;        // 0 twigs, 1 pens
uniform vec2 uRadiusCut;  // brush radius, promote radius
uniform uvec2 uChainCut;  // coarse cut, promote cut (chain positions)
uniform vec4 uViewport;   // plate px on screen
uniform vec3 uPlan;       // first width class, classes per slot, slots per tone
uniform float uPenLog;    // log(maxRadius), 0 when unbranched
uniform highp sampler2D uRadius;   // radii, 4096 a row
out vec4 tSeg;    // screen px, start and end
out vec4 tCut;    // the joints: normals of the bisectors at the start and the end, 0 for a round cap
out vec2 tInfo;   // half width on screen, slot (-1: not drawn)

const float PEN[4] = float[4](${PEN_WEIGHTS.map(w => w.toFixed(2)).join(', ')});

float radiusOf(int i) { return texelFetch(uRadius, ivec2(i & 4095, i >> 12), 0).r; }

// The class a piece is drawn in: its twig width class, or its pen.
float classOf(float r, float partial) {
  if (uMode != 0) return uPenLog <= 0.0 ? 1.0 : min(3.0, floor(log(max(r, 1.0)) / uPenLog * 4.0));
  float w = uLaw.x * (uLaw.y == 0.0 ? 1.0 : pow(r, uLaw.y)) * partial;
  return max(1.0, floor(w * uZoom / (0.2 * uDpr) + 0.5));
}

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  tSeg = vec4(0.0);
  tCut = vec4(0.0);
  tInfo = vec2(0.0, -1.0);
  int self = gl_VertexID;
  float v = uReveal.y > 0.5 ? uReveal.x - aArrival : uReveal.x - float(self);
  if (v <= 0.0) return;
  float f = min(v, 1.0);
  vec2 a = aSeg.xy;
  vec2 b = a + (aSeg.zw - a) * f;
  float r = radiusOf(self);
  float cls = classOf(r, v < 1.0 ? 0.7 : 1.0);
  float half_;
  int slot;
  if (uMode == 0) {
    uint pos = aMeta >> 3u;
    int tone = int(aMeta & 3u);
    if (r >= uRadiusCut.x && pos < uChainCut.x) return;   // a brush stroke
    float w0 = uLaw.x * (uLaw.y == 0.0 ? 1.0 : pow(r, uLaw.y));
    if (r >= uRadiusCut.y && pos < uChainCut.y) {
      // Promoted to a brush stroke if it is on screen with room for it.
      vec2 pa = vec2(uPlate.y + a.x * uPlate.x, uPlate.z - a.y * uPlate.x);
      vec2 pb = vec2(uPlate.y + b.x * uPlate.x, uPlate.z - b.y * uPlate.x);
      float pad = w0 * 2.0 + 4.0 * uDpr;
      bool off = max(pa.x, pb.x) < uViewport.x - pad || min(pa.x, pb.x) > uViewport.z + pad ||
                 max(pa.y, pb.y) < uViewport.y - pad || min(pa.y, pb.y) > uViewport.w + pad;
      if (!off) return;
    }
    float wc = cls;
    float bin = clamp(floor((wc - uPlan.x) / uPlan.y), 0.0, uPlan.z - 1.0);
    slot = tone * int(uPlan.z) + int(bin);
    half_ = wc * 0.1 * uDpr;
  } else {
    int weight = int(cls);
    slot = weight;
    half_ = PEN[weight] * uDpr * uZoom * 0.5;
  }
  vec2 sa = vec2(a.x * uScreen.x + uScreen.y, uScreen.z - a.y * uScreen.x);
  vec2 sb = vec2(b.x * uScreen.x + uScreen.y, uScreen.z - b.y * uScreen.x);
  vec2 d = sb - sa;
  float len = length(d);
  vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  tSeg = vec4(sa, sb);
  tInfo = vec2(half_, float(slot));
  // Where a chain goes on in the same class, the joint is split along the
  // bisector of the two pieces, where their union changes hands, so
  // nothing is painted twice (on the canvas they are one polyline). Where
  // the class changes, both keep their round ends and the ink pools, as
  // it does where the canvas starts a new path. A chain also gets round
  // ends where it starts and where it ends on screen.
  float vNext = aNext < 0 ? -1.0 : (uReveal.y > 0.5 ? uReveal.x - aNextArrival : uReveal.x - float(aNext));
  vec2 prev = vec2(aDirs.x, -aDirs.y);
  vec2 next = vec2(aDirs.z, -aDirs.w);
  bool startCap = (aMeta & 4u) != 0u || aPrev < 0 || dot(prev, prev) < 0.25 || classOf(radiusOf(aPrev), 1.0) != cls;
  bool endCap = v < 1.0 || vNext <= 0.0 || dot(next, next) < 0.25 || classOf(radiusOf(aNext), vNext < 1.0 ? 0.7 : 1.0) != cls;
  vec2 ns = prev + t;
  vec2 ne = t + next;
  tCut.xy = startCap || dot(ns, ns) < 1e-6 ? vec2(0.0) : normalize(ns);
  tCut.zw = endCap || dot(ne, ne) < 1e-6 ? vec2(0.0) : normalize(ne);
}`

const DRAW_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aSeg;
layout(location = 1) in vec4 aCut;
layout(location = 2) in vec2 aInfo;
uniform vec2 uSize;
uniform vec2 uPass;       // first slot, slots in this pass
flat out vec4 vSeg;
flat out float vHalf;
flat out int vLocal;
flat out vec4 vCut;
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vSeg = aSeg;
  vCut = aCut;
  vHalf = aInfo.x;
  vLocal = -1;
  int local = int(aInfo.y) - int(uPass.x);
  if (aInfo.y < 0.0 || local < 0 || local >= int(uPass.y)) return;
  vLocal = local;
  vec2 sa = aSeg.xy;
  vec2 sb = aSeg.zw;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float e = aInfo.x + 1.0;
  float cx = float(gl_VertexID & 1);
  float cy = float(gl_VertexID >> 1) * 2.0 - 1.0;
  vec2 pos = mix(sa - t * e, sb + t * e, cx) + n * (cy * e);
  gl_Position = vec4(pos.x / uSize.x * 2.0 - 1.0, 1.0 - pos.y / uSize.y * 2.0, 0.0, 1.0);
}`

const PREP_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`

const drawFs = (targets: number) => `#version 300 es
precision highp float;
precision highp int;
flat in vec4 vSeg;
flat in float vHalf;
flat in int vLocal;
flat in vec4 vCut;
uniform float uHeight;
${Array.from({ length: targets }, (_, j) => `layout(location = ${j}) out vec4 o${j};`).join('\n')}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y);
  vec2 a = vSeg.xy;
  vec2 ba = vSeg.zw - a;
  vec2 pa = p - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float d = length(pa - ba * h);
  // A pixel-wide box filter across the capsule's edge: exact for a straight
  // band, and it gives hairlines their true (fractional) weight.
  float cover = clamp(min(vHalf, d + 0.5) - max(-vHalf, d - 0.5), 0.0, 1.0);
  // Past a joint the neighbouring piece takes over: every pixel belongs to
  // exactly one piece of a chain.
  if (dot(p - a, vCut.xy) < 0.0 || dot(p - vSeg.zw, vCut.zw) > 0.0) cover = 0.0;
  vec4 c = vec4(0.0);
  int k = vLocal & 3;
  c.x = k == 0 ? cover : 0.0;
  c.y = k == 1 ? cover : 0.0;
  c.z = k == 2 ? cover : 0.0;
  c.w = k == 3 ? cover : 0.0;
  int j = vLocal >> 2;
${Array.from({ length: targets }, (_, j) => `  o${j} = j == ${j} ? c : vec4(0.0);`).join('\n')}
}`

const RESOLVE_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const resolveFs = (targets: number) => `#version 300 es
precision highp float;
precision highp int;
${Array.from({ length: targets }, (_, j) => `uniform sampler2D uT${j};`).join('\n')}
uniform vec4 uSlot[${targets * 4}];   // tone (rgb, 0..1) and alpha per slot
uniform int uCount;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  float a;
${Array.from({ length: targets }, (_, j) => {
  const lines = [`  vec4 c${j} = texelFetch(uT${j}, q, 0);`]
  for (let k = 0; k < 4; k++) {
    const s = j * 4 + k
    lines.push(`  if (${s} < uCount) { a = uSlot[${s}].a * c${j}[${k}]; acc = vec4(uSlot[${s}].rgb * a, a) + acc * (1.0 - a); }`)
  }
  return lines.join('\n')
}).join('\n')}
  o = acc;
}`

interface Programs {
  readonly prep: WebGLProgram
  readonly draw: WebGLProgram
  readonly resolve: WebGLProgram
  readonly prepU: Record<string, WebGLUniformLocation | null>
  readonly drawU: Record<string, WebGLUniformLocation | null>
  readonly resolveU: Record<string, WebGLUniformLocation | null>
}

/** What the pre-pass leaves per segment: screen ends (4), joint normals
 *  (4), half width and slot (2). */
const PREPARED_FLOATS = 10

interface GeometryBuffers {
  readonly geometry: Segments2D
  readonly topology: BranchTopology
  /** The pre-pass reads the geometry; the coverage passes read what it
   *  prepared. */
  readonly prepVao: WebGLVertexArrayObject
  readonly drawVao: WebGLVertexArrayObject
  readonly prepared: WebGLBuffer
  readonly buffers: ReadonlyArray<WebGLBuffer>
  readonly radius: WebGLTexture
  readonly rows: number
  /** What the radius texture holds: the finished radii, or a frame's. */
  radiusSource: Float32Array | undefined
  /** Staging for the radii: uploaded as a buffer, copied to the texture
   *  on the GPU (a direct texture upload stalls on the frame before). */
  readonly staging: WebGLBuffer
}

const metaCache = new WeakMap<BranchTopology, Uint32Array>()

const metaOf = (geometry: Segments2D, topology: BranchTopology): Uint32Array => {
  let meta = metaCache.get(topology)
  if (meta === undefined) {
    meta = packSegmentMeta(geometry.count, topology.chainSegments, topology.chainStart, topology.chainCount, topology.chainRecession)
    metaCache.set(topology, meta)
  }
  return meta
}

const rgb01 = (color: string): [number, number, number] => {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (m !== null) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (hex === undefined) return [0, 0, 0]
  const n = Number.parseInt(hex, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const cut = (position: number): number => (Number.isFinite(position) ? Math.max(0, Math.min(MAX_CHAIN_POSITION, Math.floor(position))) : NO_CUT)

export const createGpuInk = (onChange: () => void): GpuInk | undefined => {
  if (typeof document === 'undefined') return undefined
  const attributes: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    // Not on a software rasteriser (SwiftShader, a blocklisted GPU): there
    // a few hundred thousand capsules can take seconds, long enough for the
    // GPU watchdog to reset every canvas on the page. Canvas2D is faster.
    failIfMajorPerformanceCaveat: true,
  }
  // Prefer an OffscreenCanvas: each frame is handed over with
  // transferToImageBitmap(), which ends the GL frame and moves its buffer
  // into a bitmap the 2D layer owns, rather than having the 2D canvas
  // sample the live drawing buffer of a canvas that is never presented.
  const surface = makeSurface(attributes)
  if (surface === undefined) return undefined
  const { canvas } = surface
  let gl: WebGL2RenderingContext | null = surface.gl
  // An explicitly chosen software renderer (or Chrome's own fallback after
  // GPU crashes) passes the caveat test: refuse it by name.
  if (isSoftwareRenderer(gl)) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return undefined
  }

  let isLost = false
  let targets = 0
  let programs: Programs | undefined
  let fbo: WebGLFramebuffer | null = null
  let textures: Array<WebGLTexture> = []
  let size = { width: 0, height: 0 }
  let current: GeometryBuffers | undefined
  let failed = false

  let feedback: WebGLTransformFeedback | null = null

  const compile = (context: WebGL2RenderingContext, vs: string, fs: string, varyings?: ReadonlyArray<string>): WebGLProgram => {
    const program = context.createProgram()
    for (const [type, source] of [
      [context.VERTEX_SHADER, vs],
      [context.FRAGMENT_SHADER, fs],
    ] as const) {
      const shader = context.createShader(type)
      if (shader === null) throw new Error('createShader')
      context.shaderSource(shader, source)
      context.compileShader(shader)
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS) && !context.isContextLost()) {
        throw new Error(context.getShaderInfoLog(shader) ?? 'shader')
      }
      context.attachShader(program, shader)
    }
    if (varyings !== undefined) context.transformFeedbackVaryings(program, [...varyings], context.INTERLEAVED_ATTRIBS)
    context.linkProgram(program)
    if (!context.getProgramParameter(program, context.LINK_STATUS) && !context.isContextLost()) {
      throw new Error(context.getProgramInfoLog(program) ?? 'link')
    }
    return program
  }

  const locations = (context: WebGL2RenderingContext, program: WebGLProgram, names: ReadonlyArray<string>) =>
    Object.fromEntries(names.map(name => [name, context.getUniformLocation(program, name)]))

  /** (Re)build everything that lives in the context. */
  const setUp = (context: WebGL2RenderingContext) => {
    targets = Math.max(1, Math.min(MAX_TARGETS, context.getParameter(context.MAX_DRAW_BUFFERS) as number))
    const prep = compile(context, PREP_VS, PREP_FS, ['tSeg', 'tCut', 'tInfo'])
    const draw = compile(context, DRAW_VS, drawFs(targets))
    const resolve = compile(context, RESOLVE_VS, resolveFs(targets))
    programs = {
      prep,
      draw,
      resolve,
      prepU: locations(context, prep, [
        'uScreen', 'uPlate', 'uZoom', 'uDpr', 'uReveal', 'uLaw', 'uMode', 'uRadiusCut', 'uChainCut',
        'uViewport', 'uPlan', 'uPenLog', 'uRadius',
      ]),
      drawU: locations(context, draw, ['uSize', 'uPass', 'uHeight']),
      resolveU: locations(context, resolve, ['uSlot', 'uCount', ...Array.from({ length: targets }, (_, j) => `uT${j}`)]),
    }
    context.useProgram(prep)
    context.uniform1i(programs.prepU.uRadius ?? null, RADIUS_UNIT)
    feedback = context.createTransformFeedback()
    context.useProgram(resolve)
    for (let j = 0; j < targets; j++) context.uniform1i(programs.resolveU[`uT${j}`] ?? null, j)
    fbo = context.createFramebuffer()
    textures = []
    size = { width: 0, height: 0 }
    current = undefined
  }

  try {
    setUp(gl)
  } catch {
    return undefined
  }

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    isLost = true
    programs = undefined
    current = undefined
    onChange()
  })
  canvas.addEventListener('webglcontextrestored', () => {
    if (gl === null) return
    try {
      setUp(gl)
      isLost = false
      failed = false
    } catch {
      failed = true
    }
    onChange()
  })

  const ensureSize = (context: WebGL2RenderingContext, width: number, height: number) => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    if (size.width === width && size.height === height) return
    for (const texture of textures) context.deleteTexture(texture)
    textures = []
    context.bindFramebuffer(context.FRAMEBUFFER, fbo)
    for (let j = 0; j < targets; j++) {
      const texture = context.createTexture()
      context.bindTexture(context.TEXTURE_2D, texture)
      context.texStorage2D(context.TEXTURE_2D, 1, context.RGBA8, width, height)
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
      context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0 + j, context.TEXTURE_2D, texture, 0)
      textures.push(texture)
    }
    context.drawBuffers(Array.from({ length: targets }, (_, j) => context.COLOR_ATTACHMENT0 + j))
    const status = context.checkFramebufferStatus(context.FRAMEBUFFER)
    context.bindFramebuffer(context.FRAMEBUFFER, null)
    if (status !== context.FRAMEBUFFER_COMPLETE) throw new Error(`coverage targets incomplete (${status})`)
    checkErrors(context, 'coverage targets')
    size = { width, height }
  }

  /** GL reports a failed allocation (out of memory) as an error, not an
   *  exception: look after each one (rare), so it falls back to Canvas2D. */
  const checkErrors = (context: WebGL2RenderingContext, what: string) => {
    const error = context.getError()
    if (error !== context.NO_ERROR && !context.isContextLost()) throw new Error(`${what}: GL error ${error}`)
  }

  const buffersFor = (context: WebGL2RenderingContext, frame: Frame): GeometryBuffers => {
    const { geometry, topology } = frame
    if (current !== undefined && current.geometry === geometry && current.topology === topology) return current
    if (current !== undefined) {
      context.deleteVertexArray(current.prepVao)
      context.deleteVertexArray(current.drawVao)
      for (const buffer of current.buffers) context.deleteBuffer(buffer)
      context.deleteTexture(current.radius)
    }
    const count = geometry.count
    const prepVao = context.createVertexArray()
    context.bindVertexArray(prepVao)
    const upload = (data: ArrayBufferView, usage: number) => {
      const buffer = context.createBuffer()
      context.bindBuffer(context.ARRAY_BUFFER, buffer)
      context.bufferData(context.ARRAY_BUFFER, data, usage)
      return buffer
    }
    const seg = upload(geometry.coords.subarray(0, count * 4), context.STATIC_DRAW)
    context.enableVertexAttribArray(0)
    context.vertexAttribPointer(0, 4, context.FLOAT, false, 0, 0)
    const arrival = upload(geometry.arrival.subarray(0, count), context.STATIC_DRAW)
    context.enableVertexAttribArray(1)
    context.vertexAttribPointer(1, 1, context.FLOAT, false, 0, 0)
    const previous = upload(chainPrevious(geometry.parent, topology.mainChild, count), context.STATIC_DRAW)
    context.enableVertexAttribArray(2)
    context.vertexAttribIPointer(2, 1, context.INT, 0, 0)
    const meta = upload(metaOf(geometry, topology), context.STATIC_DRAW)
    context.enableVertexAttribArray(3)
    context.vertexAttribIPointer(3, 1, context.UNSIGNED_INT, 0, 0)
    const next = upload(topology.mainChild.subarray(0, count), context.STATIC_DRAW)
    context.enableVertexAttribArray(4)
    context.vertexAttribIPointer(4, 1, context.INT, 0, 0)
    const nextArrival = upload(nextArrivals(geometry.arrival, topology.mainChild, count), context.STATIC_DRAW)
    context.enableVertexAttribArray(5)
    context.vertexAttribPointer(5, 1, context.FLOAT, false, 0, 0)
    const dirs = upload(jointDirections(geometry.coords, geometry.parent, topology.mainChild, count), context.STATIC_DRAW)
    context.enableVertexAttribArray(6)
    context.vertexAttribPointer(6, 4, context.FLOAT, false, 0, 0)
    context.bindVertexArray(null)
    const prepared = upload(new Float32Array(count * PREPARED_FLOATS), context.DYNAMIC_COPY)
    const drawVao = context.createVertexArray()
    context.bindVertexArray(drawVao)
    context.bindBuffer(context.ARRAY_BUFFER, prepared)
    const stride = PREPARED_FLOATS * 4
    for (const [location, size, offset] of [
      [0, 4, 0],
      [1, 4, 16],
      [2, 2, 32],
    ] as const) {
      context.enableVertexAttribArray(location)
      context.vertexAttribPointer(location, size, context.FLOAT, false, stride, offset)
      context.vertexAttribDivisor(location, 1)
    }
    context.bindVertexArray(null)
    context.bindBuffer(context.ARRAY_BUFFER, null)
    const staging = context.createBuffer()
    context.bindBuffer(context.PIXEL_UNPACK_BUFFER, staging)
    context.bufferData(context.PIXEL_UNPACK_BUFFER, count * 4, context.STREAM_DRAW)
    context.bindBuffer(context.PIXEL_UNPACK_BUFFER, null)
    // Radii in a texture, so a piece can read its neighbours'.
    const rows = Math.max(1, Math.ceil(count / RADIUS_ROW))
    const radius = context.createTexture()
    context.activeTexture(context.TEXTURE0 + RADIUS_UNIT)
    context.bindTexture(context.TEXTURE_2D, radius)
    context.texStorage2D(context.TEXTURE_2D, 1, context.R32F, RADIUS_ROW, rows)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
    current = { geometry, topology, prepVao, drawVao, prepared, buffers: [seg, arrival, previous, meta, next, nextArrival, dirs, prepared, staging], radius, rows, radiusSource: undefined, staging }
    checkErrors(context, 'geometry buffers')
    return current
  }

  /** Common uniforms: camera, reveal, the width law. */
  const setFrameUniforms = (context: WebGL2RenderingContext, frame: Frame, law: WidthLaw, width: number, height: number) => {
    const u = (programs as Programs).prepU
    const { view, scale, offsetX, offsetY } = frame
    void width
    void height
    context.uniform3f(u.uScreen ?? null, scale * view.zoom, offsetX * view.zoom + view.e, offsetY * view.zoom + view.f)
    context.uniform3f(u.uPlate ?? null, scale, offsetX, offsetY)
    context.uniform1f(u.uZoom ?? null, view.zoom)
    context.uniform1f(u.uDpr ?? null, frame.dpr)
    context.uniform2f(u.uReveal ?? null, revealThreshold(frame), frame.isGrow ? 1 : 0)
    context.uniform2f(u.uLaw ?? null, law.tip, law.exponent)
    const { minX, minY, maxX, maxY } = view.viewport
    context.uniform4f(u.uViewport ?? null, minX, minY, maxX, maxY)
  }

  /** The screen box the plant can paint in, padded, as a scissor. */
  const scissorFor = (frame: Frame, pad: number, width: number, height: number) => {
    const { bounds } = frame.geometry
    const { view, scale, offsetX, offsetY } = frame
    const x0 = (offsetX + bounds.minX * scale) * view.zoom + view.e - pad
    const x1 = (offsetX + bounds.maxX * scale) * view.zoom + view.e + pad
    const y0 = (offsetY - bounds.maxY * scale) * view.zoom + view.f - pad
    const y1 = (offsetY - bounds.minY * scale) * view.zoom + view.f + pad
    const left = Math.max(0, Math.floor(x0))
    const right = Math.min(width, Math.ceil(x1))
    const top = Math.max(0, Math.floor(y0))
    const bottom = Math.min(height, Math.ceil(y1))
    if (right <= left || bottom <= top) return undefined
    // GL's scissor counts from the bottom.
    return { x: left, y: height - bottom, width: right - left, height: bottom - top }
  }

  /**
   * Draw `slots` slots: per pass, coverage into the targets (MAX), then the
   * resolve over the canvas (source-over). `colors[s]` is slot s's tone and
   * alpha.
   */
  const render = (
    context: WebGL2RenderingContext,
    frame: Frame,
    buffers: GeometryBuffers,
    width: number,
    height: number,
    slots: number,
    colors: Float32Array,
    pad: number,
    setDrawUniforms: () => void,
    law: WidthLaw,
  ): CanvasImageSource => {
    const p = programs as Programs
    ensureSize(context, width, height)
    // The growing radii go up each playback frame; the finished ones once.
    const radius = frame.radius
    context.activeTexture(context.TEXTURE0 + RADIUS_UNIT)
    context.bindTexture(context.TEXTURE_2D, buffers.radius)
    if (buffers.radiusSource !== radius || radius !== frame.topology.radius) {
      const count = frame.geometry.count
      const full = Math.floor(count / RADIUS_ROW)
      context.bindBuffer(context.PIXEL_UNPACK_BUFFER, buffers.staging)
      context.bufferSubData(context.PIXEL_UNPACK_BUFFER, 0, radius, 0, count)
      if (full > 0) context.texSubImage2D(context.TEXTURE_2D, 0, 0, 0, RADIUS_ROW, full, context.RED, context.FLOAT, 0)
      const rest = count - full * RADIUS_ROW
      if (rest > 0) context.texSubImage2D(context.TEXTURE_2D, 0, 0, full, rest, 1, context.RED, context.FLOAT, full * RADIUS_ROW * 4)
      context.bindBuffer(context.PIXEL_UNPACK_BUFFER, null)
      buffers.radiusSource = radius
    }
    context.disable(context.DEPTH_TEST)
    context.disable(context.SCISSOR_TEST)
    context.bindFramebuffer(context.FRAMEBUFFER, null)
    context.viewport(0, 0, width, height)
    context.clearColor(0, 0, 0, 0)
    context.clear(context.COLOR_BUFFER_BIT)
    const box = scissorFor(frame, pad, width, height)
    if (box === undefined) return present()
    context.enable(context.SCISSOR_TEST)
    context.scissor(box.x, box.y, box.width, box.height)
    // Once per frame, one vertex per segment: reveal, twig test, class,
    // slot, camera and joints, captured for the passes.
    const count = frame.geometry.count
    context.useProgram(p.prep)
    setFrameUniforms(context, frame, law, width, height)
    setDrawUniforms()
    context.enable(context.RASTERIZER_DISCARD)
    context.bindVertexArray(buffers.prepVao)
    context.bindTransformFeedback(context.TRANSFORM_FEEDBACK, feedback)
    context.bindBufferBase(context.TRANSFORM_FEEDBACK_BUFFER, 0, buffers.prepared)
    context.beginTransformFeedback(context.POINTS)
    context.drawArrays(context.POINTS, 0, count)
    context.endTransformFeedback()
    context.bindBufferBase(context.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    context.bindTransformFeedback(context.TRANSFORM_FEEDBACK, null)
    context.bindVertexArray(null)
    context.disable(context.RASTERIZER_DISCARD)
    const perPass = targets * 4
    const zero = new Float32Array(4)
    for (let first = 0; first < slots; first += perPass) {
      const inPass = Math.min(perPass, slots - first)
      // Coverage.
      context.bindFramebuffer(context.FRAMEBUFFER, fbo)
      for (let j = 0; j < targets; j++) context.clearBufferfv(context.COLOR, j, zero)
      context.useProgram(p.draw)
      context.uniform2f(p.drawU.uSize ?? null, width, height)
      context.uniform1f(p.drawU.uHeight ?? null, height)
      context.uniform2f(p.drawU.uPass ?? null, first, inPass)
      context.enable(context.BLEND)
      context.blendEquation(context.MAX)
      context.blendFunc(context.ONE, context.ONE)
      context.bindVertexArray(buffers.drawVao)
      context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, count)
      context.bindVertexArray(null)
      // Resolve, in the painter's order.
      context.bindFramebuffer(context.FRAMEBUFFER, null)
      context.useProgram(p.resolve)
      context.uniform4fv(p.resolveU.uSlot ?? null, padded(colors, first, perPass))
      context.uniform1i(p.resolveU.uCount ?? null, inPass)
      for (let j = 0; j < targets; j++) {
        context.activeTexture(context.TEXTURE0 + j)
        context.bindTexture(context.TEXTURE_2D, textures[j] ?? null)
      }
      context.blendEquation(context.FUNC_ADD)
      context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA)
      context.drawArrays(context.TRIANGLES, 0, 3)
    }
    context.disable(context.BLEND)
    context.disable(context.SCISSOR_TEST)
    return present()
  }

  const ready = (): WebGL2RenderingContext | undefined =>
    gl !== null && !isLost && !failed && programs !== undefined && !gl.isContextLost() ? gl : undefined

  /** The frame just drawn, as an image for a 2D layer: a transferred
   *  bitmap from an OffscreenCanvas, else the canvas itself. */
  const present = (): CanvasImageSource => (canvas instanceof HTMLCanvasElement ? canvas : canvas.transferToImageBitmap())

  const guarded = (run: (context: WebGL2RenderingContext) => CanvasImageSource | undefined) => {
    const context = ready()
    if (context === undefined) return undefined
    try {
      return run(context)
    } catch (error) {
      failed = true
      console.warn('GPU twigs failed; drawing them on the canvas', error)
      onChange()
      return undefined
    }
  }

  return {
    isAvailable: () => ready() !== undefined,
    twigs: (frame, request, width, height) =>
      guarded(context => {
        const buffers = buffersFor(context, frame)
        const { view, dpr } = frame
        const zoom = view.zoom
        const law = request.law
        const classMin = widthClassOf(law.tip * (frame.isAnimating ? 0.7 : 1), zoom, dpr)
        const classMax = widthClassOf(request.maxTwigWidth, zoom, dpr)
        // A playback frame is gone in 16 ms: fewer slots, fewer passes.
        const plan = planSlots(classMin, classMax, frame.isAnimating ? PER_TONE / 2 : PER_TONE)
        const colors = twigColors(plan, frame.palette, zoom, dpr, request.dilution)
        const p = programs as Programs
        return render(context, frame, buffers, width, height, plan.slots, colors, request.maxTwigWidth * zoom + 4, () => {
          const u = p.prepU
          context.uniform1i(u.uMode ?? null, 0)
          context.uniform2f(u.uRadiusCut ?? null, finite(request.brushRadius), finite(request.promoteRadius))
          context.uniform2ui(u.uChainCut ?? null, cut(request.coarseCut), cut(request.promoteCut))
          context.uniform3f(u.uPlan ?? null, plan.classMin, plan.binWidth, plan.perTone)
          context.uniform1f(u.uPenLog ?? null, 0)
        }, law)
      }),
    pens: (frame, width, height) =>
      guarded(context => {
        const buffers = buffersFor(context, frame)
        const maxRadius = Math.max(frame.topology.maxRadius, 1)
        const colors = penColors(frame.palette)
        const p = programs as Programs
        const pad = (PEN_WEIGHTS[PEN_WEIGHTS.length - 1] ?? 2.2) * frame.dpr * frame.view.zoom + 4
        return render(context, frame, buffers, width, height, PEN_WEIGHTS.length, colors, pad, () => {
          const u = p.prepU
          context.uniform1i(u.uMode ?? null, 1)
          context.uniform2f(u.uRadiusCut ?? null, 3.0e38, 3.0e38)
          context.uniform2ui(u.uChainCut ?? null, 0, 0)
          context.uniform3f(u.uPlan ?? null, 1, 1, 1)
          context.uniform1f(u.uPenLog ?? null, maxRadius <= 1.0001 ? 0 : Math.log(maxRadius + 1e-9))
        }, { tip: 1, exponent: 0 })
      }),
    dispose: () => {
      const context = gl
      if (context !== null && !context.isContextLost()) {
        if (current !== undefined) {
          context.deleteVertexArray(current.prepVao)
          context.deleteVertexArray(current.drawVao)
          context.deleteTexture(current.radius)
          for (const buffer of current.buffers) context.deleteBuffer(buffer)
        }
        for (const texture of textures) context.deleteTexture(texture)
        context.getExtension('WEBGL_lose_context')?.loseContext()
      }
      current = undefined
      textures = []
      gl = null
    },
  }
}

const finite = (x: number): number => (Number.isFinite(x) ? x : 3.0e38)

type Surface = { readonly canvas: OffscreenCanvas | HTMLCanvasElement; readonly gl: WebGL2RenderingContext }

/** A WebGL2 context on an OffscreenCanvas where there is one, else on a
 *  detached canvas element. */
const makeSurface = (attributes: WebGLContextAttributes): Surface | undefined => {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const gl = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null
      if (gl !== null && typeof canvas.transferToImageBitmap === 'function') return { canvas, gl }
    } catch {
      // Fall through to an element.
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const gl = canvas.getContext('webgl2', attributes)
  return gl === null ? undefined : { canvas, gl }
}

/** Lay a GPU frame on a 2D layer at the origin, in screen pixels, and let
 *  go of it. */
export const layGpuFrame = (context: CanvasRenderingContext2D, image: CanvasImageSource): void => {
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.drawImage(image, 0, 0)
  context.restore()
  if (typeof ImageBitmap === 'function' && image instanceof ImageBitmap) image.close()
}

/** Names of software rasterisers, on which Canvas2D beats this painter. */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i

const isSoftwareRenderer = (context: WebGL2RenderingContext): boolean => {
  const names = [String(context.getParameter(context.RENDERER) ?? '')]
  const info = context.getExtension('WEBGL_debug_renderer_info')
  if (info !== null) names.push(String(context.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? ''))
  return names.some(name => SOFTWARE_RENDERER.test(name))
}

const padded = (colors: Float32Array, first: number, perPass: number): Float32Array => {
  const out = new Float32Array(perPass * 4)
  out.set(colors.subarray(first * 4, Math.min(colors.length, (first + perPass) * 4)))
  return out
}

/** The reveal threshold the frame's `visible` uses: `visible(i) = t - key(i)`. */
const revealThreshold = (frame: Frame): number => {
  // visible(0) = t - key(0); key(0) is 0 for Trace and arrival[0] for Grow.
  const key0 = frame.isGrow ? frame.geometry.arrival[0] ?? 0 : 0
  return frame.visible(0) + key0
}

/** Tone and alpha of every twig slot, in the Canvas2D painter's terms. */
export const twigColors = (plan: SlotPlan, palette: Palette, zoom: number, dpr: number, dilution: number): Float32Array => {
  const out = new Float32Array(plan.slots * 4)
  for (let slot = 0; slot < plan.slots; slot++) {
    const tone = Math.floor(slot / plan.perTone)
    const recession = tone / 3
    const [r, g, b] = rgb01(palette.inkTint(coolness(2, recession), 1))
    out[slot * 4] = r
    out[slot * 4 + 1] = g
    out[slot * 4 + 2] = b
    out[slot * 4 + 3] = twigAlpha(slotClass(plan, slot), tone, zoom, dpr, dilution)
  }
  return out
}

const penColors = (palette: Palette): Float32Array => {
  const [r, g, b] = rgb01(palette.ink)
  const out = new Float32Array(PEN_WEIGHTS.length * 4)
  for (let k = 0; k < PEN_WEIGHTS.length; k++) out.set([r, g, b, 0.92], k * 4)
  return out
}
