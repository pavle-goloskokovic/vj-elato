// Image overlay: one picture (PNG, JPEG, GIF, WebP, SVG; animated ones keep moving) laid over the
// whole output as a page element, above both decks and the canvas. It therefore works whichever way
// the decks are drawn, and it sits after the master chain: feedback, VHS, TV and CRT do not touch it.
//
// Master keys: ovOpacity, ovSize (the image is fitted into this fraction of the output; 1 fills it,
// as a frame would), ovX / ovY (-1..1, edge to edge), ovBlend, ovBounce (above zero the image
// travels and bounces off the edges like a DVD player's idle logo, and ovX / ovY are ignored).

export const OVERLAY_DEFAULTS = { ovOpacity: 1, ovSize: 0.3, ovX: 0, ovY: 0, ovBlend: 'normal', ovBounce: 0 };

const cssBlend = (b) => (b === 'add' ? 'plus-lighter' : b || 'normal');
const tri = (t) => { const f = t - Math.floor(t); return f < 0.5 ? f * 4 - 1 : 3 - f * 4; };   // -1..1..-1

// host: the element whose box is the output picture; the image is appended to it.
// before: an element of host the image must stay under (the player's blackout layer).
export function createOverlay(host, zIndex, before) {
  const img = document.createElement('img');
  img.className = 'overlay-image';
  img.alt = '';
  img.style.cssText = 'position:absolute;display:none;pointer-events:none;object-fit:contain;inset:auto;max-width:none;';
  if (zIndex != null) img.style.zIndex = zIndex;
  host.insertBefore(img, before || null);
  let objectUrl = null, name = null, natural = null;
  img.addEventListener('load', () => { natural = [img.naturalWidth || 1, img.naturalHeight || 1]; });
  img.addEventListener('error', () => { natural = null; });

  // source: { file, name } | { url, name } | null
  function set(source) {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    natural = null; name = null;
    if (!source || (!source.file && !source.url)) { img.removeAttribute('src'); img.style.display = 'none'; return; }
    name = source.name || (source.file && source.file.name) || 'image';
    if (source.file) { objectUrl = URL.createObjectURL(source.file); img.src = objectUrl; }
    else img.src = source.url;
  }

  // lit: false while the strobe is in its dark half
  function update(master, lit) {
    const op = master.ovOpacity ?? 1;
    if (!natural || op <= 0 || lit === false) { if (img.style.display !== 'none') img.style.display = 'none'; return; }
    const W = host.clientWidth, H = host.clientHeight;
    const size = Math.max(0.02, master.ovSize ?? 0.3);
    const k = Math.min(W * size / natural[0], H * size / natural[1]);
    const w = natural[0] * k, h = natural[1] * k;
    let x = master.ovX || 0, y = master.ovY || 0;
    const bounce = master.ovBounce || 0;
    if (bounce > 0) {          // the wall clock, so the player and the controller's preview agree
      const t = Date.now() / 1000 * bounce;
      x = tri(t * 0.13); y = tri(t * 0.171 + 0.3);
    }
    img.style.display = 'block';
    img.style.width = w.toFixed(1) + 'px';
    img.style.height = h.toFixed(1) + 'px';
    img.style.left = ((W - w) / 2 * (1 + x)).toFixed(1) + 'px';
    img.style.top = ((H - h) / 2 * (1 - y)).toFixed(1) + 'px';
    img.style.opacity = Math.min(1, op).toFixed(3);
    img.style.mixBlendMode = cssBlend(master.ovBlend);
  }

  return { set, update, get name() { return name; }, get size() { return natural; }, el: img };
}
