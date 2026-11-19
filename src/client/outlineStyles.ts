/**
 * Styles for the v0.2 outline features (find bar, tag filter chips, row
 * selection, notes). Scoped by .mm-* classes; the lead concatenates this into
 * styles.ts.
 * @module dsh-mindmap/client/outlineStyles
 */
export const OUTLINE_CSS = [
  '.mm-body{flex:1;min-width:0;display:flex;flex-direction:column}',
  '.mm-body>.mm-text,.mm-body>.mm-input{flex:none}',
  '.mm-done>.mm-body>.mm-text,.mm-done>.mm-body>.mm-input{color:var(--mm-sub);text-decoration:line-through}',
  '.mm-node:focus{outline:0}',
  '.mm-node:focus-visible{box-shadow:inset 0 0 0 2px var(--mm-accent)}',
  '.mm-node.mm-selected{background:rgba(57,100,254,.12);background:color-mix(in srgb,var(--mm-accent) 14%,transparent)}',
  '.mm-node.mm-selected:focus-visible{box-shadow:inset 0 0 0 1px var(--mm-accent)}',
  '.mm-note{font-size:12.5px;line-height:20px;color:var(--mm-sub);padding:0 2px 4px;white-space:pre-wrap;word-break:break-word;cursor:text;border-left:2px solid transparent;padding-left:6px}',
  '.mm-note-input{display:block;width:100%;box-sizing:border-box;min-height:24px;margin:0;border:0;outline:0;resize:none;overflow:hidden;background:transparent;font-family:inherit;color:var(--mm-text);border-left:2px solid var(--mm-border-strong);padding:0 2px 4px 6px}',
  '.mm-done>.mm-body>.mm-note{text-decoration:none}',
  '.mm-find{background:rgba(255,200,0,.35);color:inherit;border-radius:2px;padding:0}',
  '.mm-find.mm-find-cur{background:rgba(255,150,0,.75);box-shadow:0 0 0 1px rgba(230,120,0,.9)}',
  '.mm-findbar{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;margin:0 0 6px;background:var(--mm-panel);border:1px solid var(--mm-border);border-radius:6px}',
  '.mm-findbar-input{flex:1 1 120px;min-width:80px;height:26px;padding:0 8px;border:1px solid var(--mm-border-strong);border-radius:4px;background:var(--mm-bg);color:var(--mm-text);font:inherit;font-size:13px;outline:0;box-sizing:border-box}',
  '.mm-findbar-input:focus{border-color:var(--mm-accent)}',
  '.mm-findbar-btn{height:26px;min-width:26px;padding:0 8px;border:1px solid var(--mm-border);border-radius:4px;background:var(--mm-bg);color:var(--mm-text);font:inherit;font-size:12px;cursor:pointer}',
  '.mm-findbar-btn:hover:not(:disabled){background:var(--mm-hover)}',
  '.mm-findbar-btn:disabled{opacity:.45;cursor:default}',
  '.mm-findbar-btn.mm-on{border-color:var(--mm-accent);color:var(--mm-accent)}',
  '.mm-findbar-count{min-width:44px;text-align:center;font-size:12px;color:var(--mm-sub);font-variant-numeric:tabular-nums}',
  '.mm-findbar-count.mm-none{color:var(--mm-danger)}',
  '.mm-tagbar{display:flex;align-items:center;gap:6px;padding:4px 8px 8px;font-size:12px;color:var(--mm-sub)}',
  '.mm-tagchip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--mm-accent);border-radius:11px;background:transparent;color:var(--mm-accent);font:inherit;cursor:pointer}',
  '.mm-tagchip:hover{background:var(--mm-hover)}',
  '.mm-tag-click{cursor:pointer}',
  '.mm-tag-click:hover{text-decoration:underline}',
  '@media (hover:none){.mm-fold{opacity:1}}',
].join('\n')
