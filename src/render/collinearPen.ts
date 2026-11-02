/**
 * Polylines with straight runs merged: consecutive pieces of a twig that
 * continue in the same direction (a turtle's `F F F`) become one `lineTo`
 * instead of several. Fewer points means less JS (`Path2D.lineTo` was a
 * fifth of the ink brush's time) and less to rasterise, and a straight run
 * looks the same drawn either way: the dropped points were joins on a
 * straight line. Used for the Canvas2D twigs (the GPU fallback and the
 * print).
 *
 * The pen holds one pending piece and only emits it once the next one
 * turns, changes path, or the run ends (`flush`). Pieces count as straight
 * on when the angle between them is under ~0.001° (`TOLERANCE`, measured
 * against the run's first piece, so a gentle curve can't drift off). Pure;
 * unit-tested in collinearPen.test.ts.
 */

export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
}

/** Sine of the largest angle still counted as straight on. */
export const TOLERANCE = 2e-5

export class CollinearPen {
  #path: PathSink | undefined = undefined
  #x = 0
  #y = 0
  #dx = 0
  #dy = 0
  #length2 = 0
  /** Points emitted, for tests and profiling. */
  lines = 0

  /** Start a new subpath in `path` at (x, y). */
  moveTo(path: PathSink, x: number, y: number): void {
    this.flush()
    path.moveTo(x, y)
    this.#path = path
  }

  /** Continue the current subpath from (x0, y0), its current point, to
   *  (x1, y1). */
  lineTo(x0: number, y0: number, x1: number, y1: number): void {
    const path = this.#path
    if (path === undefined) return
    const dx = x1 - x0
    const dy = y1 - y0
    const length2 = dx * dx + dy * dy
    if (this.#length2 > 0 && length2 > 0) {
      const cross = this.#dx * dy - this.#dy * dx
      const dot = this.#dx * dx + this.#dy * dy
      if (dot > 0 && cross * cross <= TOLERANCE * TOLERANCE * this.#length2 * length2) {
        this.#x = x1
        this.#y = y1
        return
      }
    }
    if (this.#length2 > 0) {
      path.lineTo(this.#x, this.#y)
      this.lines++
    }
    if (length2 > 0) {
      this.#x = x1
      this.#y = y1
      this.#dx = dx
      this.#dy = dy
      this.#length2 = length2
    } else {
      // A zero-length piece: emit it as is (it still gets a round cap).
      path.lineTo(x1, y1)
      this.lines++
      this.#length2 = 0
    }
  }

  /** Emit the pending piece; the subpath stays open. */
  flush(): void {
    if (this.#path !== undefined && this.#length2 > 0) {
      this.#path.lineTo(this.#x, this.#y)
      this.lines++
    }
    this.#length2 = 0
  }

  /** End the subpath: the next piece must start with `moveTo`. */
  end(): void {
    this.flush()
    this.#path = undefined
  }
}
