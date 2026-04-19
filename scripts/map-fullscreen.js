/**
 * map-fullscreen.js
 *
 * Paste into browser console (or run via CDP/Playwright evaluate) while on
 * https://game.gradient-bang.com/ to get a clean full-screen map view.
 *
 * What it does
 * ────────────
 * 1. Hides all DOM chrome (header, footer, right aside, separator, chat overlay, starfield art)
 * 2. Suppresses hex-grid strokes on both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D
 * 3. Suppresses ship-count badge and corp-member label drawing on the canvas
 *
 * Lessons learned
 * ───────────────
 * • Colors must match EXACTLY as the browser serialises them — rgba values have spaces:
 *     hex grid    → "rgba(255, 255, 255, 0.3)"   lw=1
 *     ship badge  → "#53eafd"  (fillRect background)
 *     corp label  → bg "rgba(88, 28, 135, 0.92)", border "rgba(216, 180, 254, 1)", text "#f5f3ff"
 *
 * • The hex grid is rendered to an OffscreenCanvas cache (renderHexGridCached).
 *   Patching only CanvasRenderingContext2D.prototype is NOT enough — you must also patch
 *   OffscreenCanvasRenderingContext2D.prototype (shared prototype across all instances).
 *
 * • Never patch fill() or black fillText — they are used heavily for sector node rendering.
 *   Only patch fillRect/strokeRect/stroke for the specific label colors above.
 *
 * • To reset patches mid-session without a page reload, use an iframe to get native methods:
 *     const iframe = document.createElement('iframe')
 *     document.body.appendChild(iframe)
 *     const native = iframe.contentWindow.CanvasRenderingContext2D.prototype
 *     CanvasRenderingContext2D.prototype.stroke = native.stroke  // etc.
 *     document.body.removeChild(iframe)
 *
 * • updateProps() on the SectorMapController does:
 *     Object.assign(currentProps, newProps)          // replaces config entirely!
 *     Object.assign(currentProps.config, newProps.config)  // then merges
 *   Passing a PARTIAL config ({ show_grid: false }) destroys all other config keys → black screen.
 *   Always read the full config from the React fiber first, then spread + override.
 *
 * • To find the controller via React fiber, walk canvas[__reactFiberXXX] upward via fiber.return,
 *   checking each fiber's memoizedState hook chain for a ref whose .current has updateProps().
 *
 * • To call updateProps safely:
 *     const fullConfig = fiber.memoizedProps.config  // BigMapPanel's partial config (14 keys)
 *   This is still partial (missing grid_spacing, hex_size, etc.) → still breaks render.
 *   The SAFE approach is canvas prototype patching (no controller call needed for hex grid).
 */

(function mapFullscreen() {
  // ── 1. Hide DOM chrome ────────────────────────────────────────────────
  document.querySelectorAll('header, footer').forEach(el => (el.style.display = 'none'))
  ;['#_r_crp_', '#_r_cro_', '.absolute.left-0.bottom-0.h-60'].forEach(sel => {
    const el = document.querySelector(sel)
    if (el) el.style.display = 'none'
  })
  // Starfield / splash art background
  const starfield = Array.from(document.querySelectorAll('div')).find(
    el => el.className?.includes?.('z-') && el.querySelector?.('img[src*="splash"]'),
  )
  if (starfield) starfield.style.display = 'none'

  // ── 2. Canvas prototype patches ───────────────────────────────────────
  const HEX_GRID      = 'rgba(255, 255, 255, 0.3)' // hex grid stroke (with spaces!)
  const SHIP_BADGE_BG = '#53eafd'                   // ship-count badge background
  const CORP_BG       = 'rgba(88, 28, 135, 0.92)'  // corp-member label background
  const CORP_BORDER   = 'rgba(216, 180, 254, 1)'   // corp-member label border
  const CORP_TEXT     = '#f5f3ff'                   // corp-member label text

  function patchProto(proto) {
    const os = proto.stroke
    proto.stroke = function (...a) {
      if (this.strokeStyle === HEX_GRID || this.strokeStyle === CORP_BORDER) return
      return os.apply(this, a)
    }
    const ofr = proto.fillRect
    proto.fillRect = function (...a) {
      if (this.fillStyle === SHIP_BADGE_BG || this.fillStyle === CORP_BG) return
      return ofr.apply(this, a)
    }
    const osr = proto.strokeRect
    proto.strokeRect = function (...a) {
      if (this.strokeStyle === CORP_BORDER) return
      return osr.apply(this, a)
    }
    const oft = proto.fillText
    proto.fillText = function (...a) {
      if (this.fillStyle === CORP_TEXT) return
      return oft.apply(this, a)
    }
    // NOTE: do NOT patch fill() — it is used for sector-node hexagon fills
    // NOTE: do NOT patch fillText for '#000000' — ship badge text is invisible on dark bg anyway
  }

  patchProto(CanvasRenderingContext2D.prototype)
  // OffscreenCanvas has a SEPARATE prototype — must patch independently
  if (typeof OffscreenCanvas !== 'undefined') {
    patchProto(Object.getPrototypeOf(new OffscreenCanvas(1, 1).getContext('2d')))
  }

  // ── 3. Bust OffscreenCanvas hex-grid cache via wheel zoom nudge ───────
  // renderHexGridCached() caches to an OffscreenCanvas keyed on camera state.
  // A tiny zoom-in + zoom-out invalidates the cache and forces a re-render
  // that goes through the patched prototype (no hex strokes drawn).
  const canvas = document.querySelector('canvas')
  if (canvas) {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, bubbles: true }))
    setTimeout(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, bubbles: true }))
    }, 150)
  }

  console.log('[map-fullscreen] done — move the mouse over the map to trigger first render')
})()
