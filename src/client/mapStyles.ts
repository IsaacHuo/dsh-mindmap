/**
 * Mind-map specific CSS (branch palette, tapered edges, overlays, hint,
 * toolbar). Appended after the base CSS by installStyles; rules here override
 * the older .mm-map-* rules in styles.ts with equal specificity.
 * @module dsh-mindmap/client/mapStyles
 */
import { BRANCH_DARK, BRANCH_LIGHT, rgba, TINT_DARK, TINT_LIGHT } from './mapLayout.ts'

const DARK = 'body[data-ds-dark-theme]:not([data-ds-dark-theme="false"])'

const palette = (dark: boolean): string => (dark ? BRANCH_DARK : BRANCH_LIGHT)
  .map((c, i) => (dark ? DARK + ' ' : '') + '.mm-map .mm-b' + i + '{--mm-bc:' + c + ';--mm-bt:' + rgba(c, dark ? TINT_DARK : TINT_LIGHT) + '}')
  .join('\n')

export const MAP_CSS = [
  // Dragging the canvas or a node must never start a text selection.
  '.mm-map{user-select:none;-webkit-user-select:none}',
  '.mm-map .mm-map-edit{user-select:text;-webkit-user-select:text}',
  palette(false),
  palette(true),
  '.mm-map-edge{fill:none;stroke:var(--mm-bc,var(--mm-border-strong));stroke-width:1.5}',
  '.mm-map-edge.mm-taper{fill:var(--mm-bc,var(--mm-border-strong));stroke:none}',
  '.mm-map-node rect.mm-box{fill:var(--mm-elev);stroke:var(--mm-bc,var(--mm-border-strong));stroke-opacity:.55;stroke-width:1}',
  '.mm-map-node.mm-d1 rect.mm-under{fill:var(--mm-elev);stroke:none}',
  '.mm-map-node.mm-d1 rect.mm-box{fill:var(--mm-bt,var(--mm-panel));stroke-opacity:1;stroke-width:1.5}',
  '.mm-map-node.mm-root rect.mm-box{fill:var(--mm-accent);stroke:var(--mm-accent);stroke-opacity:1}',
  '.mm-map-node.mm-root text{fill:#fff;font-weight:600;font-size:17px}',
  '.mm-map-node:hover rect.mm-box{stroke-opacity:1}',
  '.mm-map-node rect.mm-map-check-on{stroke:none;fill:var(--mm-bc,var(--mm-accent))}',
  '.mm-map-node rect.mm-map-check-off{fill:none;stroke:var(--mm-sub)}',
  '.mm-map-tick{fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}',
  '.mm-map-toggle circle{fill:var(--mm-elev);stroke:var(--mm-bc,var(--mm-border-strong))}',
  '.mm-map-node .mm-map-toggle text{fill:var(--mm-sub);font-size:10px;font-weight:400;text-decoration:none;text-anchor:middle;dominant-baseline:central}',
  '.mm-map-toggle.mm-open{opacity:0;transition:opacity .12s}',
  '.mm-map-node:hover .mm-map-toggle.mm-open,.mm-map-selection .mm-map-toggle.mm-open{opacity:1}',
  '.mm-map-selring{fill:none;stroke:var(--mm-accent);stroke-width:2;pointer-events:none}',
  '.mm-map-drop-inside{fill:none;stroke:var(--mm-accent);stroke-width:2;stroke-dasharray:5 3;pointer-events:none}',
  '.mm-map-drop-line{stroke:var(--mm-accent);stroke-width:3;stroke-linecap:round;pointer-events:none}',
  '.mm-map-drop-bad{stroke:var(--mm-danger)}',
  '.mm-map-ghost{opacity:.55;pointer-events:none}',
  '.mm-map-ghost rect{fill:var(--mm-elev);stroke:var(--mm-accent);stroke-width:1.5}',
  '.mm-map-ghost text{fill:var(--mm-text);font-size:14px;dominant-baseline:central}',
  '.mm-map.mm-dragging,.mm-map.mm-dragging *{cursor:grabbing}',
  // In-place editor: transparent and frameless, laid over the node's own box (EditBackdrop).
  '.mm-map-edit{position:absolute;z-index:5;box-sizing:border-box;margin:0;border:0;border-radius:6px;background:transparent;color:var(--mm-text);font:inherit;font-size:14px;line-height:20px;resize:none;outline:0;box-shadow:none;overflow:hidden;transform-origin:0 0;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.mm-map-edit.mm-root-edit{font-size:17px;line-height:24px;font-weight:600;color:#fff;caret-color:#fff}',
  '.mm-map-edit.mm-root-edit::selection{background:rgba(255,255,255,.35)}',
  '@media (max-width:950px){.mm-map-hint{display:none}}',
  '.mm-map-hint{background:var(--mm-elev);border:1px solid var(--mm-border);border-radius:6px;padding:4px 10px;box-shadow:0 2px 8px rgba(0,0,0,.06)}',
  '.mm-map-zoom{font-size:12px;color:var(--mm-sub);min-width:44px;height:26px;text-align:center;background:none;border:0;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums}',
  '.mm-map-zoom:hover{background:var(--mm-hover);color:var(--mm-text)}',
  '.mm-map-seg{display:flex;gap:1px;margin-right:4px;padding-right:4px;border-right:1px solid var(--mm-border)}',
  '.mm-map-seg button{height:26px;padding:0 8px;font-size:12px;border:0;border-radius:6px;background:none;color:var(--mm-sub);cursor:pointer}',
  '.mm-map-seg button:hover{background:var(--mm-hover);color:var(--mm-text)}',
  ".mm-map-seg button[aria-pressed='true']{color:var(--mm-accent);background:var(--mm-hover);font-weight:600}",
].join('\n')
