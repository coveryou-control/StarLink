/**
 * Running inside another product's page.
 *
 * ## What embedding is, and what it deliberately is not
 *
 * A host application puts StarLink's workspace in an iframe on one of its own screens. The
 * chat a person sees there is THE chat: the same API, the same database, the same
 * conversations they would see at StarLink's own address. Nothing
 * about the product is duplicated or re-implemented for a host; what changes is the chrome,
 * because the host already has a brand and an account menu of its own and two of each on one
 * screen is worse than either.
 *
 * ## Why this is cosmetic only, and must stay that way
 *
 * Nothing here is a permission. The frame is admitted or refused by
 * `Content-Security-Policy: frame-ancestors`, which the middleware builds from
 * `SL_EMBED_ORIGINS` — a server-side setting a page cannot influence. Every request from
 * inside the frame is still a session-bearing request to the API, decided again per call.
 *
 * So a person who types `?embed=1` at StarLink's own address gets a workspace without a
 * brand row. That is the whole of what they get, and it is why this flag is allowed to live
 * in `sessionStorage` where script can reach it.
 *
 * ## Why `sessionStorage` and not the URL
 *
 * The host sets the mode once, in the `src` it frames. Opening a conversation is a
 * client-side navigation to `/conversations/<id>`, which does not carry the query string —
 * so a flag read from the URL would switch the chrome back on the first time somebody
 * clicked a row. `sessionStorage` is scoped to the tab AND the frame, so it survives every
 * navigation inside the embed and cannot leak into a normal StarLink tab.
 */
export const EMBED_PARAM = 'embed';
export const EMBED_KEY = 'starlink.embed';

/**
 * Stamped on `<html>` before the first paint, and read by both the stylesheet and React.
 *
 * Two readers for one fact, and both are needed. The stylesheet hides the chrome in the
 * first frame, before React has hydrated, so an embed never flashes a brand row it is about
 * to remove. React then does not RENDER it, which is what actually keeps it out of the tab
 * order — a keyboard inside an iframe must not be able to reach a control that is invisible.
 */
export const EMBED_ATTRIBUTE = 'data-embed';

/**
 * Runs before the first paint, from the document head — the same arrangement as the theme.
 *
 * Reads the query string first (the host's frame `src` is the only place the mode is ever
 * declared) and falls back to what this frame already decided. Writing it back on every load
 * is what makes a reload inside the frame keep the mode.
 */
export const embedBootScript = `(function(){try{
var p=new URLSearchParams(location.search).get('${EMBED_PARAM}');
var e=p==='1'||p==='true'?'1':(p===null?sessionStorage.getItem('${EMBED_KEY}'):'0');
if(e==='1'){sessionStorage.setItem('${EMBED_KEY}','1');document.documentElement.setAttribute('${EMBED_ATTRIBUTE}','true');}
else{sessionStorage.removeItem('${EMBED_KEY}');document.documentElement.removeAttribute('${EMBED_ATTRIBUTE}');}
}catch(_){}})();`;

/**
 * Is this document inside a host application?
 *
 * Reads the attribute the boot script stamped rather than `sessionStorage` directly, so
 * there is exactly one place that decides and the stylesheet and the components cannot
 * disagree about the answer.
 *
 * Safe on the server, where it is always false: the layout renders un-embedded and the
 * effect corrects it on mount. The stylesheet has already hidden the chrome by then, so the
 * correction is invisible.
 */
export function isEmbedded(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute(EMBED_ATTRIBUTE) === 'true';
}
