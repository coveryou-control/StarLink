/**
 * The only URL schemes a media element may be pointed at.
 *
 * ## Why this exists
 *
 * `attachment-media.tsx` renders `<img src>` and `<video src>` from one of two places: a
 * `blob:` URL the browser minted over a file the person just chose, or a download grant
 * issued by StarLink's own API. Neither is attacker-controlled today, and neither element
 * executes a `javascript:` URL in any current browser — so this is not closing an open
 * hole.
 *
 * It is closing a FUTURE one, and answering a scanner honestly. CodeQL reports
 * `js/xss-through-dom` at both sinks because it cannot see where the URL came from; the
 * choice was to dismiss two high-severity findings on my own reading of the data flow, or
 * to make the property true by construction so there is nothing left to reason about. The
 * second is cheaper and survives somebody later changing where the grant comes from.
 *
 * ## What it refuses
 *
 * Everything that is not `blob:`, `data:`, `http:` or `https:`. A refused URL renders
 * nothing rather than rendering something unexpected: a missing picture is a visible,
 * reportable fault, and a silently substituted one is not.
 *
 * `data:` is admitted because a generated placeholder is a legitimate source and is
 * already used elsewhere in the product for avatars.
 */

const ALLOWED = new Set(['blob:', 'data:', 'http:', 'https:']);

/** Space and DEL; everything below space is a C0 control. */
const SPACE = 0x20;
const DELETE = 0x7f;

/**
 * What a browser throws away before it parses a URL.
 *
 * Tab, newline, carriage return and NUL among them — so a check that skips this step is
 * checking a different string from the one that actually loads.
 *
 * Written as a code-point filter rather than a regex with `u0000`-style escapes, for a
 * reason worth stating: those escapes have twice been turned into RAW control characters
 * on the way into this repository, and a raw NUL in a source file compiles, runs, and
 * makes ripgrep classify the file as binary — at which point it is invisible to every
 * content search anyone runs (CLAUDE.md, platform notes). This form cannot do that.
 */
const stripAsBrowsersDo = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > SPACE && code !== DELETE;
    })
    .join('');

export function safeMediaSrc(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate === '') return undefined;

  /* `java<TAB>script:` and a leading newline both reach the network stack as
     `javascript:`, and both sail past a naive prefix test. */
  const cleaned = stripAsBrowsersDo(candidate);
  if (cleaned === '') return undefined;

  try {
    /*
       ABSOLUTE only, and no base — which is the bug the tests caught in the first
       version of this.

       Parsing with `new URL(value, base)` makes anything that is not a valid absolute
       URL resolve as a RELATIVE path and inherit the page's own `http:` scheme, so it
       passes the allow-list without ever having been an allowed URL. Both real sources
       are absolute — a `blob:` the browser minted, or an `http(s):` grant — so requiring
       it costs nothing and removes the whole class.
    */
    return ALLOWED.has(new URL(cleaned).protocol) ? candidate : undefined;
  } catch {
    /* Unparseable is refused. "I could not tell what this is" must not become "render it
       anyway" on the one path that puts a remote resource on the page. */
    return undefined;
  }
}
