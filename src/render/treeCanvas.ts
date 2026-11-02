import { Schema } from 'effect'
import { CustomElement } from 'foldkit'

import type { Segments2D } from '../core/geometry'
import { GeometryStore } from '../engine/geometryStore'
import {
  Camera,
  type CameraView,
  type Rect,
  SHEET,
  cameraEquals,
  cameraView,
  clampCamera,
  fitCamera,
  interpolateCamera,
  isFit,
  panBy,
  relativeView,
  textureScale,
  visibleRect,
  zoomAbout,
} from './camera'
import type { Frame } from './frame'
import { type GpuInk, createGpuInk } from './gpuInk'
import { type Palette, readPalette } from './palette'
import { paintPaper } from './paper'
import { type Composition, type Placement, type PlateJob, beginPlate, buildFrame, composePlate, placePlant } from './plate'
import { RenderStyle } from './renderStyle'
import { plateMargins } from './sheet'
import { RevealMode } from './revealMode'
import { Season } from './season'

/**
 * `<tree-canvas>`: an imperative Canvas2D renderer packaged as a custom
 * element, which is how it plugs into Foldkit's virtual DOM. Foldkit sets
 * four small properties on each render; the element looks the geometry up
 * in the GeometryStore and redraws at most once per animation frame.
 *
 * A frame is built from layers: the paper (painted once per size and
 * theme), an optional colour wash of leaves or blossom (foliage.ts), and the
 * ink (inkBrush.ts or linePen.ts). Wash and ink are each laid down twice,
 * once blurred, so they seem to have soaked a little into the paper. The
 * finished painting is cached, so resting on the last frame costs one
 * drawImage; playback frames of very large trees are drafts (see Frame).
 *
 * ZOOM AND PAN. The camera (camera.ts) lives in the Model and arrives as a
 * property; gestures change it here first and are reported upward:
 *
 * - Wheel and trackpad pinch zoom towards the cursor; a drag pans (pointer
 *   capture); two fingers pinch. The element applies each step to the
 *   camera it shows at once, and reports it as `camera-move` at most once
 *   per animation frame, then `camera-settle` when the gesture ends. Its
 *   own reports coming back as the property are recognised and ignored
 *   (`#sent`), so a late echo never pulls the view back. Any other new
 *   camera (buttons, keys, reset, time travel) is eased to.
 * - While the camera moves, the finished plate is previewed by stretching
 *   cached pictures (one drawImage each); ~130 ms after it stops, the
 *   visible part of the plate is painted again at the new zoom, culled to
 *   the screen, so strokes, leaves and paper stay crisp. Playback frames
 *   are painted at the camera directly.
 * - The ink and wash are clipped to the plate mark, which, like the pencil
 *   inscriptions and the zoom cartouche, is a fixed DOM overlay: a window
 *   onto the magnified print. The paper fills the whole sheet. The clip
 *   comes from the same CSS variables that place the mark.
 */

const TAG = 'tree-canvas'
/** Above this many segments, playback frames are drafts (see Frame). */
const DRAFT_SEGMENTS = 60_000
/** The seal's side, as a share of the canvas's shorter side. */
const SEAL = 0.03
/** Quiet time after the last gesture input before the crisp repaint. */
const SETTLE_MS = 130
/** Work per task for a repaint spread over tasks (see `#startJob`). */
const SLICE_MS = 12
/** A wheel gesture ends after this much quiet. */
const WHEEL_END_MS = 180
/** Easing to a camera set from outside (buttons, keys, reset). */
const EASE_MS = 240
/** Zoom per pixel of wheel travel, for wheels and for pinches. */
const WHEEL_ZOOM = 0.0018
const PINCH_ZOOM = 0.011
/** A press must travel this far (CSS px) before it pans, so clicks and
 *  double-clicks don't nudge the view. */
const DRAG_SLOP = 3

const layer = () => document.createElement('canvas')

/** The plate mark's inset from the canvas edges, and the notch under the
 *  zoom cartouche in its top edge, CSS pixels. */
interface Inset {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
  readonly gapRight: number
  readonly gapWidth: number
  readonly gapDepth: number
}

interface Paper {
  readonly image: HTMLCanvasElement
  /** Where to draw it: the identity, or the camera for the fitted paper. */
  readonly view: CameraView
}

const IDENTITY: CameraView = { zoom: 1, e: 0, f: 0 }

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

class TreeCanvasElement extends HTMLElement {
  #buildId = -1
  #progress = 1
  #mode: RevealMode = 'Grow'
  #style: RenderStyle = 'Leaf'
  #season: Season = 'Summer'
  #canvas = layer()
  #ink = layer()
  #wash = layer()
  /** Paper at the camera, and at the fitted view. */
  #paper = layer()
  #paperKey = ''
  #fitPaper = layer()
  #fitPaperKey = ''
  /** The finished plate at the fitted view, and at `#finalCamera`. */
  #fitFinal = layer()
  #fitFinalKey = ''
  #final = layer()
  #finalKey = ''
  #finalBase = ''
  #finalCamera: Camera = fitCamera
  #radius: Float32Array = new Float32Array(0)
  /** The GPU twig painter: undefined until first needed, null without
   *  WebGL2 (or when switched off). */
  #gpu: GpuInk | null | undefined
  #gpuEnabled = true
  #watchesLayers = false
  #palette: Palette | undefined
  #inset: Inset | undefined
  #frame = 0
  #resizeObserver: ResizeObserver | undefined
  #colorScheme: MediaQueryList | undefined

  // Camera state. `#camera` is the Model's; `#shown` is on screen, and
  // runs ahead of the Model during a gesture or an ease.
  #camera: Camera = fitCamera
  #shown: Camera = fitCamera
  #sent: Array<Camera> = []
  #ease: { readonly from: Camera; readonly to: Camera; readonly startedAt: number } | undefined
  /** The plant's box on the plate, plate-normalised: the camera's centre
   *  is kept over it. */
  #focus: Rect = SHEET
  #movingUntil = 0
  #crispTimer = 0
  #moveFrame = 0
  #wheelTimer = 0
  #hasMoved = false
  #pointers = new Map<number, { x: number; y: number }>()
  #isDragging = false
  #gestureScale = 1
  #hasPainted = false
  /** A plate being painted over several tasks (the crisp repaint after a
   *  gesture, or the fitted plate refilled), and the port that runs it. */
  #job: { readonly id: string; readonly step: (deadline: number) => boolean; readonly done: () => void } | undefined
  #pump: MessageChannel | undefined

  /** Milliseconds the last redraw took, and what it was, for profiling
   *  from the console. */
  lastDrawMs = 0
  lastDrawKind: 'empty' | 'cached' | 'final' | 'preview' | 'playback' = 'empty'

  set buildId(value: number) {
    this.#buildId = value
    this.#schedule()
  }
  get buildId(): number {
    return this.#buildId
  }
  set progress(value: number) {
    this.#progress = value
    this.#schedule()
  }
  get progress(): number {
    return this.#progress
  }
  set mode(value: RevealMode) {
    this.#mode = value
    this.#schedule()
  }
  get mode(): RevealMode {
    return this.#mode
  }
  set renderStyle(value: RenderStyle) {
    this.#style = value
    this.#schedule()
  }
  get renderStyle(): RenderStyle {
    return this.#style
  }
  set season(value: Season) {
    this.#season = value
    this.#schedule()
  }
  get season(): Season {
    return this.#season
  }

  set camera(value: Camera) {
    // One of our own reports coming back: the view is already there (or
    // ahead of it).
    const echo = this.#sent.findIndex(sent => cameraEquals(sent, value))
    this.#camera = value
    if (echo >= 0) {
      this.#sent.splice(0, echo + 1)
      return
    }
    this.#sent = []
    if (this.#ease === undefined && cameraEquals(value, this.#shown)) return
    if (!this.#hasPainted || prefersReducedMotion()) {
      this.#ease = undefined
      this.#shown = value
      this.#afterCameraChange()
    } else {
      this.#ease = { from: this.#shown, to: value, startedAt: performance.now() }
    }
    this.#schedule()
  }
  get camera(): Camera {
    return this.#camera
  }
  /** The camera on screen now (ahead of `camera` during a gesture). */
  get shownCamera(): Camera {
    return this.#shown
  }

  /** Draw the twigs on the GPU when WebGL2 is there (on by default; off
   *  draws them on the canvas, as the print does). For comparisons from the
   *  console. */
  set gpuEnabled(value: boolean) {
    if (value === this.#gpuEnabled) return
    this.#gpuEnabled = value
    this.#invalidate()
  }
  get gpuEnabled(): boolean {
    return this.#gpuEnabled
  }
  /** Whether the last paint could use the GPU. */
  get gpuActive(): boolean {
    return this.#gpuEnabled && this.#gpu != null && this.#gpu.isAvailable()
  }

  /** Forget every cached picture and paint again (the GPU came or went). */
  #invalidate() {
    this.#fitFinalKey = ''
    this.#finalKey = ''
    this.#finalBase = ''
    this.#schedule()
  }

  #gpuInk(): GpuInk | undefined {
    if (!this.#gpuEnabled) return undefined
    if (this.#gpu === undefined) this.#gpu = createGpuInk(() => this.#invalidate()) ?? null
    return this.#gpu ?? undefined
  }

  connectedCallback() {
    this.#canvas.style.display = 'block'
    this.#canvas.style.width = '100%'
    this.#canvas.style.height = '100%'
    if (!this.#canvas.isConnected) this.append(this.#canvas)
    if (!this.#watchesLayers) {
      // A GPU reset (a driver hiccup, memory pressure, the watchdog) wipes
      // every accelerated canvas, and Chrome hands them back blank: paint
      // everything again, the paper too, rather than show a bare sheet.
      for (const canvas of [this.#canvas, this.#ink, this.#wash, this.#paper, this.#fitPaper, this.#fitFinal, this.#final]) {
        canvas.addEventListener('contextlost', this.#onLayerLost)
        canvas.addEventListener('contextrestored', this.#onLayerLost)
      }
      this.#watchesLayers = true
    }
    this.#resizeObserver ??= new ResizeObserver(() => this.#resize())
    this.#resizeObserver.observe(this)
    this.#colorScheme ??= matchMedia('(prefers-color-scheme: dark)')
    this.#colorScheme.addEventListener('change', this.#onColorScheme)
    this.addEventListener('wheel', this.#onWheel, { passive: false })
    this.addEventListener('pointerdown', this.#onPointerDown)
    this.addEventListener('pointermove', this.#onPointerMove)
    this.addEventListener('pointerup', this.#onPointerUp)
    this.addEventListener('pointercancel', this.#onPointerUp)
    this.addEventListener('lostpointercapture', this.#onPointerUp)
    // Safari reports trackpad pinches as gesture events, not ctrl-wheel.
    this.addEventListener('gesturestart', this.#onGestureStart)
    this.addEventListener('gesturechange', this.#onGestureChange)
    this.addEventListener('gestureend', this.#onGestureEnd)
    this.#afterCameraChange()
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect()
    this.#colorScheme?.removeEventListener('change', this.#onColorScheme)
    this.removeEventListener('wheel', this.#onWheel)
    this.removeEventListener('pointerdown', this.#onPointerDown)
    this.removeEventListener('pointermove', this.#onPointerMove)
    this.removeEventListener('pointerup', this.#onPointerUp)
    this.removeEventListener('pointercancel', this.#onPointerUp)
    this.removeEventListener('lostpointercapture', this.#onPointerUp)
    this.removeEventListener('gesturestart', this.#onGestureStart)
    this.removeEventListener('gesturechange', this.#onGestureChange)
    this.removeEventListener('gestureend', this.#onGestureEnd)
    this.#cancelJob()
    this.#gpu?.dispose()
    this.#gpu = undefined
    cancelAnimationFrame(this.#frame)
    cancelAnimationFrame(this.#moveFrame)
    clearTimeout(this.#crispTimer)
    clearTimeout(this.#wheelTimer)
    this.#frame = 0
    this.#moveFrame = 0
  }

  #onLayerLost = () => {
    this.#cancelJob()
    this.#paperKey = ''
    this.#fitPaperKey = ''
    this.#invalidate()
  }

  #onColorScheme = () => {
    this.#palette = undefined
    this.#schedule()
  }

  // GESTURES

  #onWheel = (event: WheelEvent) => {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.clientHeight : 1
    const delta = event.deltaY * unit
    if (delta === 0) return
    const isPinch = event.ctrlKey
    // At the fitted view, scrolling down belongs to the page, unless it is
    // the tail of a zoom-out that just got here.
    if (!isPinch && delta > 0 && isFit(this.#shown) && this.#wheelTimer === 0) return
    event.preventDefault()
    const factor = Math.exp(-delta * (isPinch ? PINCH_ZOOM : WHEEL_ZOOM))
    const [u, v] = this.#viewPoint(event.clientX, event.clientY)
    this.#gesture(zoomAbout(this.#shown, factor, u, v))
    clearTimeout(this.#wheelTimer)
    this.#wheelTimer = window.setTimeout(() => {
      this.#wheelTimer = 0
      this.#settle()
    }, WHEEL_END_MS)
  }

  #onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    try {
      this.setPointerCapture(event.pointerId)
    } catch {
      // The pointer may already be gone.
    }
  }

  #onPointerMove = (event: PointerEvent) => {
    const pointer = this.#pointers.get(event.pointerId)
    if (pointer === undefined) return
    const width = this.clientWidth || 1
    const height = this.clientHeight || 1
    if (this.#pointers.size === 1) {
      const dx = event.clientX - pointer.x
      const dy = event.clientY - pointer.y
      if (!this.#isDragging && (Math.hypot(dx, dy) < DRAG_SLOP || isFit(this.#shown))) return
      pointer.x = event.clientX
      pointer.y = event.clientY
      this.#isDragging = true
      this.#gesture(panBy(this.#shown, dx / width, dy / height))
      return
    }
    // Two fingers: pan with their midpoint, zoom with their spread.
    const [a, b] = [...this.#pointers.values()]
    if (a === undefined || b === undefined || (pointer !== a && pointer !== b)) {
      pointer.x = event.clientX
      pointer.y = event.clientY
      return
    }
    const before = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
    pointer.x = event.clientX
    pointer.y = event.clientY
    const after = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
    this.#isDragging = true
    const [u, v] = this.#viewPoint(after.cx, after.cy)
    const panned = panBy(this.#shown, (after.cx - before.cx) / width, (after.cy - before.cy) / height)
    this.#gesture(zoomAbout(panned, before.d > 0 ? after.d / before.d : 1, u, v))
  }

  #onPointerUp = (event: PointerEvent) => {
    if (!this.#pointers.delete(event.pointerId)) return
    if (this.#pointers.size > 0) return
    this.#isDragging = false
    this.#afterCameraChange()
    this.#settle()
  }

  #onGestureStart = (event: Event) => {
    if (this.#pointers.size > 0) return
    event.preventDefault()
    this.#gestureScale = 1
  }

  #onGestureChange = (event: Event) => {
    if (this.#pointers.size > 0) return
    event.preventDefault()
    const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number }
    const scale = gesture.scale ?? 1
    const [u, v] = this.#viewPoint(gesture.clientX ?? 0, gesture.clientY ?? 0)
    this.#gesture(zoomAbout(this.#shown, scale / this.#gestureScale, u, v))
    this.#gestureScale = scale
  }

  #onGestureEnd = (event: Event) => {
    if (this.#pointers.size > 0) return
    event.preventDefault()
    this.#settle()
  }

  /** A point on screen as a share of the view, 0..1 across and down. */
  #viewPoint(clientX: number, clientY: number): [number, number] {
    const rect = this.getBoundingClientRect()
    return [(clientX - rect.left) / (rect.width || 1), (clientY - rect.top) / (rect.height || 1)]
  }

  /** Show `next` now (clamped), and report it at the next frame. */
  #gesture(next: Camera) {
    this.#cancelJob()
    this.#ease = undefined
    this.#movingUntil = performance.now() + SETTLE_MS
    clearTimeout(this.#crispTimer)
    this.#crispTimer = window.setTimeout(() => this.#schedule(), SETTLE_MS + 4)
    const camera = clampCamera(next, this.#focus)
    if (cameraEquals(camera, this.#shown)) return
    this.#shown = camera
    this.#hasMoved = true
    this.#afterCameraChange()
    this.#schedule()
    if (this.#moveFrame === 0) {
      this.#moveFrame = requestAnimationFrame(() => {
        this.#moveFrame = 0
        this.#report('camera-move')
      })
    }
  }

  /** The gesture is over: report where it ended. */
  #settle() {
    cancelAnimationFrame(this.#moveFrame)
    this.#moveFrame = 0
    if (!this.#hasMoved) return
    this.#hasMoved = false
    this.#report('camera-settle')
  }

  #report(name: 'camera-move' | 'camera-settle') {
    const camera = this.#shown
    this.#sent.push(camera)
    if (this.#sent.length > 64) this.#sent.shift()
    this.dispatchEvent(new CustomEvent(name, { detail: { camera } }))
  }

  /** Cursor and touch handling follow the zoom: at the fitted view a
   *  one-finger swipe scrolls the page; zoomed in, it pans. */
  #afterCameraChange() {
    const fit = isFit(this.#shown)
    this.style.cursor = this.#isDragging ? 'grabbing' : fit ? '' : 'grab'
    this.style.touchAction = fit ? 'pan-y' : 'none'
  }

  #isMoving(now: number): boolean {
    return this.#ease !== undefined || now < this.#movingUntil
  }

  // PAINTING

  #resize() {
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(this.clientWidth * dpr))
    const height = Math.max(1, Math.round(this.clientHeight * dpr))
    this.#inset = undefined
    if (width === this.#canvas.width && height === this.#canvas.height) return
    this.#cancelJob()
    for (const canvas of [this.#canvas, this.#ink, this.#wash, this.#final, this.#fitFinal]) {
      canvas.width = width
      canvas.height = height
    }
    this.#draw()
  }

  #schedule() {
    if (this.#frame !== 0) return
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      this.#draw()
    })
  }

  #draw() {
    const startedAt = performance.now()
    const context = this.#canvas.getContext('2d')
    if (context === null) return
    const { width, height } = this.#canvas
    const dpr = window.devicePixelRatio || 1
    this.#palette ??= readPalette(this)
    this.#inset ??= readInset(this)
    const palette = this.#palette
    this.#stepEase(startedAt)
    const camera = this.#shown
    const isMoving = this.#isMoving(startedAt)
    const fitPaper = this.#fitPaperFor(width, height, dpr, palette)
    // The paper at the camera is painted only when it is needed: the crisp
    // repaint paints it in a task of its own.
    const paperOf = (): Paper =>
      isFit(camera)
        ? { image: fitPaper, view: IDENTITY }
        : isMoving
          ? { image: fitPaper, view: cameraView(camera, width, height) }
          : { image: this.#paperFor(width, height, dpr, palette, camera), view: IDENTITY }
    if (isMoving) this.#cancelJob()

    context.setTransform(1, 0, 0, 1, 0, 0)
    const geometry = GeometryStore.get(this.#buildId)
    if (geometry === undefined || geometry.count === 0) {
      drawPaper(context, paperOf())
      this.lastDrawKind = 'empty'
      return
    }

    const placement = this.#place(geometry)
    const base = `${this.#buildId}|${width}x${height}|${this.#style}|${this.#season}|${palette.key}`
    let kind: typeof this.lastDrawKind = 'cached'
    if (this.#progress >= 1 && isFit(camera)) {
      if (base !== this.#fitFinalKey) {
        this.#compose(this.#fitFinal, paperOf(), this.#frameFor(geometry, palette, dpr, placement, camera), placement)
        this.#fitFinalKey = base
        kind = 'final'
      }
      context.drawImage(this.#fitFinal, 0, 0)
    } else if (this.#progress >= 1 && isMoving) {
      this.#preview(context, camera, fitPaper, base)
      kind = 'preview'
    } else if (this.#progress >= 1) {
      const key = `${base}|${camera.zoom}|${camera.x}|${camera.y}`
      if (key === this.#finalKey) {
        context.drawImage(this.#final, 0, 0)
      } else {
        // The crisp repaint is spread over tasks (it can take a few hundred
        // ms deep in a big crown); the preview stays up until it lands.
        this.#startCrisp(key, base, camera, geometry, palette, dpr, placement)
        this.#preview(context, camera, fitPaper, base)
        kind = 'preview'
      }
    } else {
      this.#compose(this.#canvas, paperOf(), this.#frameFor(geometry, palette, dpr, placement, camera), placement)
      kind = 'playback'
    }
    this.#hasPainted = true
    this.lastDrawKind = kind
    this.lastDrawMs = performance.now() - startedAt
  }

  /**
   * The crisp picture at `camera`, painted into `#final` over several
   * tasks: the paper first, then the plate (beginPlate), at most SLICE_MS
   * of work at a time, so the page never stalls on it. A gesture, a resize
   * or any other paint cancels it; the next draw starts it again. The
   * picture is the same as painting it at once.
   */
  #startCrisp(key: string, base: string, camera: Camera, geometry: Segments2D, palette: Palette, dpr: number, placement: Placement) {
    const id = `crisp|${key}`
    if (this.#job?.id === id) return
    const { width, height } = this.#canvas
    let plate: PlateJob | undefined
    let paper: Paper | undefined
    const startedAt = performance.now()
    this.#startJob(
      id,
      deadline => {
        if (paper === undefined) {
          paper = { image: this.#paperFor(width, height, dpr, palette, camera), view: IDENTITY }
          if (performance.now() > deadline) return false
        }
        const image = paper
        plate ??= beginPlate(this.#final, { ink: this.#ink, wash: this.#wash }, this.#frameFor(geometry, palette, dpr, placement, camera), this.#composition(this.#final, image, placement))
        return plate.step(deadline)
      },
      () => {
        this.#finalKey = key
        this.#finalBase = base
        this.#finalCamera = camera
        this.lastDrawKind = 'final'
        this.lastDrawMs = performance.now() - startedAt
        this.#schedule()
        if (this.#fitFinalKey !== base) this.#refillFitFinal(base)
      },
    )
  }

  /**
   * The preview's backdrop is the finished plate at the fitted view. After
   * a rebuild while zoomed in it is stale, and a zoom out would show bare
   * paper around the crisp part; paint it again, in slices, once the page
   * is idle.
   */
  #refillFitFinal(base: string) {
    const run = () => {
      const geometry = GeometryStore.get(this.#buildId)
      const palette = this.#palette
      const { width, height } = this.#canvas
      const dpr = window.devicePixelRatio || 1
      const current = `${this.#buildId}|${width}x${height}|${this.#style}|${this.#season}|${palette?.key}`
      if (geometry === undefined || palette === undefined || current !== base || this.#fitFinalKey === base) return
      if (this.#progress < 1 || this.#isMoving(performance.now())) return
      // The crisp repaint goes first; this waits for it.
      if (this.#job !== undefined) {
        this.#refillFitFinal(base)
        return
      }
      const paper: Paper = { image: this.#fitPaperFor(width, height, dpr, palette), view: IDENTITY }
      const placement = this.#place(geometry)
      let plate: PlateJob | undefined
      this.#startJob(
        `fit|${base}`,
        deadline => {
          plate ??= beginPlate(this.#fitFinal, { ink: this.#ink, wash: this.#wash }, this.#frameFor(geometry, palette, dpr, placement, fitCamera), this.#composition(this.#fitFinal, paper, placement))
          return plate.step(deadline)
        },
        () => {
          this.#fitFinalKey = base
        },
      )
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 })
    else window.setTimeout(run, 300)
  }

  /** Run `step` in slices of SLICE_MS, one task each, until it says it is
   *  done; then `done`. Replaces any job under way. */
  #startJob(id: string, step: (deadline: number) => boolean, done: () => void) {
    this.#job = { id, step, done }
    if (this.#pump === undefined) {
      this.#pump = new MessageChannel()
      this.#pump.port1.onmessage = () => this.#runJob()
    }
    this.#pump.port2.postMessage(0)
  }

  #runJob() {
    const job = this.#job
    if (job === undefined) return
    const deadline = performance.now() + SLICE_MS
    let isDone = false
    while (!isDone && performance.now() <= deadline) isDone = job.step(deadline)
    if (this.#job !== job) return
    if (isDone) {
      this.#job = undefined
      job.done()
    } else {
      this.#pump?.port2.postMessage(0)
    }
  }

  #cancelJob() {
    this.#job = undefined
  }

  /** Advance an ease towards a camera set from outside. */
  #stepEase(now: number) {
    const ease = this.#ease
    if (ease === undefined) return
    const t = Math.min(1, (now - ease.startedAt) / EASE_MS)
    if (t >= 1) {
      this.#shown = ease.to
      this.#ease = undefined
    } else {
      const eased = 1 - (1 - t) ** 3
      this.#shown = clampCamera(interpolateCamera(ease.from, ease.to, eased))
      this.#schedule()
    }
    this.#afterCameraChange()
  }

  /**
   * A cheap picture for a camera in motion: the paper and the finished
   * plate at the fitted view, stretched to the camera, and over them the
   * last crisp picture at its own camera. Both are cut to the plate mark,
   * so their margins don't slide into view.
   */
  #preview(context: CanvasRenderingContext2D, camera: Camera, fitPaper: HTMLCanvasElement, base: string) {
    const { width, height } = this.#canvas
    drawPaper(context, { image: fitPaper, view: cameraView(camera, width, height) })
    const plate = this.#plateRect(width, height)
    const layers: Array<[HTMLCanvasElement, Camera]> = []
    if (this.#fitFinalKey === base) layers.push([this.#fitFinal, fitCamera])
    if (this.#finalBase === base && !isFit(this.#finalCamera)) layers.push([this.#final, this.#finalCamera])
    context.save()
    this.#clipToPlate(context, width, height)
    for (const [image, from] of layers) {
      const view = relativeView(from, camera, width, height)
      context.setTransform(view.zoom, 0, 0, view.zoom, view.e, view.f)
      context.drawImage(image, plate.x, plate.y, plate.width, plate.height, plate.x, plate.y, plate.width, plate.height)
    }
    context.restore()
    context.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** The plate mark's rectangle in device pixels. */
  #plateRect(width: number, height: number) {
    const dpr = window.devicePixelRatio || 1
    const inset = this.#inset ?? readInset(this)
    const x = Math.round(inset.left * dpr)
    const y = Math.round(inset.top * dpr)
    return {
      x,
      y,
      width: Math.max(1, width - x - Math.round(inset.right * dpr)),
      height: Math.max(1, height - y - Math.round(inset.bottom * dpr)),
    }
  }

  /** Clip `context` (identity transform) to the plate mark, less the notch
   *  under the zoom cartouche, so a zoomed picture never runs under the
   *  margins, the inscriptions or the controls. */
  #clipToPlate(context: CanvasRenderingContext2D, width: number, height: number) {
    const dpr = window.devicePixelRatio || 1
    const inset = this.#inset ?? readInset(this)
    const plate = this.#plateRect(width, height)
    const notchRight = plate.x + plate.width - Math.round(inset.gapRight * dpr)
    const notchWidth = Math.round(inset.gapWidth * dpr)
    context.beginPath()
    context.rect(plate.x, plate.y, plate.width, plate.height)
    context.rect(notchRight - notchWidth, plate.y, notchWidth, Math.round(inset.gapDepth * dpr))
    context.clip('evenodd')
  }

  #fitPaperFor(width: number, height: number, dpr: number, palette: Palette): HTMLCanvasElement {
    const key = `${width}x${height}|${dpr}|${palette.key}`
    if (key !== this.#fitPaperKey) {
      this.#fitPaper.width = width
      this.#fitPaper.height = height
      paintPaper(this.#fitPaper, palette, dpr)
      this.#fitPaperKey = key
    }
    return this.#fitPaper
  }

  #paperFor(width: number, height: number, dpr: number, palette: Palette, camera: Camera): HTMLCanvasElement {
    const key = `${width}x${height}|${dpr}|${palette.key}|${camera.zoom}|${camera.x}|${camera.y}`
    if (key !== this.#paperKey) {
      this.#paper.width = width
      this.#paper.height = height
      paintPaper(this.#paper, palette, dpr, cameraView(camera, width, height))
      this.#paperKey = key
    }
    return this.#paper
  }

  /** Paint the wash and ink layers for `frame` and lay them on the paper in
   *  `target`, inside the plate mark. */
  #compose(target: HTMLCanvasElement, paper: Paper, frame: Frame, placement: Placement) {
    // The layers are shared: a repaint in slices has to start over.
    if (this.#job !== undefined) {
      this.#job = undefined
      this.#schedule()
    }
    composePlate(target, { ink: this.#ink, wash: this.#wash }, frame, this.#composition(target, paper, placement))
  }

  #composition(target: HTMLCanvasElement, paper: Paper, placement: Placement): Composition {
    return {
      style: this.#style,
      season: this.#season,
      placement,
      drawPaper: context => drawPaper(context, paper),
      clip: context => this.#clipToPlate(context, target.width, target.height),
      gpu: this.#gpuInk(),
    }
  }

  /** Fit the plant inside the plate mark with the print's margins
   *  (sheet.ts), resting low on the sheet (see placePlant). Also keeps the
   *  plant's box for the camera's clamp. */
  #place(geometry: Segments2D): Placement {
    const { width, height } = this.#canvas
    const placement = placePlant(
      geometry,
      width,
      height,
      plateMargins(this.#plateRect(width, height), width, height),
      Math.min(width, height) * SEAL,
    )
    this.#focus = placement.focus
    return placement
  }

  #frameFor(geometry: Segments2D, palette: Palette, dpr: number, placement: Placement, camera: Camera): Frame {
    const { width, height } = this.#canvas
    const { frame, scratch } = buildFrame({
      geometry,
      palette,
      dpr,
      placement,
      view: {
        ...cameraView(camera, width, height),
        texture: textureScale(camera.zoom),
        detail: (camera.zoom * dpr) / 2,
        viewport: visibleRect(camera, width, height),
      },
      minDimension: Math.min(width, height),
      progress: this.#progress,
      mode: this.#mode,
      draftSegments: DRAFT_SEGMENTS,
      scratch: this.#radius,
    })
    this.#radius = scratch
    return frame
  }
}

const drawPaper = (context: CanvasRenderingContext2D, paper: Paper) => {
  const { zoom, e, f } = paper.view
  context.setTransform(zoom, 0, 0, zoom, e, f)
  context.drawImage(paper.image, 0, 0)
  context.setTransform(1, 0, 0, 1, 0, 0)
}

/** The plate mark's inset, from the CSS that draws it (`--plate-mark-*`
 *  in styles.css), so the clip and the line always agree. */
const readInset = (element: Element): Inset => {
  const style = getComputedStyle(element)
  const read = (name: string, fallback: number) => {
    const value = Number.parseFloat(style.getPropertyValue(name))
    return Number.isFinite(value) ? value : fallback
  }
  const side = read('--plate-mark-side', 14)
  return {
    top: read('--plate-mark-top', 14),
    right: side,
    bottom: read('--plate-mark-bottom', 38),
    left: side,
    gapRight: read('--plate-gap-right', 16),
    gapWidth: read('--plate-gap-width', 150),
    gapDepth: read('--plate-gap-depth', 12),
  }
}

if (customElements.get(TAG) === undefined) {
  customElements.define(TAG, TreeCanvasElement)
}

/** Typed Foldkit binding for `<tree-canvas>`. */
export const treeCanvas = CustomElement.define({
  tag: TAG,
  properties: {
    buildId: Schema.Number,
    progress: Schema.Number,
    mode: RevealMode,
    renderStyle: RenderStyle,
    season: Season,
    camera: Camera,
  },
  events: {
    /** The camera during a gesture, at most once per animation frame. */
    'camera-move': Schema.Struct({ camera: Camera }),
    /** Where a gesture left the camera. */
    'camera-settle': Schema.Struct({ camera: Camera }),
  },
})
