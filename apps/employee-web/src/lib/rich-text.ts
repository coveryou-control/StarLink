/**
 * `**bold**` and `_italic_`, in a message body.
 *
 * ## Why a formatter exists at all
 *
 * People type emphasis into chat whether or not the product renders it — the markers are
 * already in the messages, being read as punctuation. A shortcut that inserted them without
 * a renderer would be worse than nothing: Ctrl+B would produce visible asterisks, which is
 * a control that appears to work and does not.
 *
 * ## Two markers, chosen for their false positives rather than their looks
 *
 * Single `*` is the prettier bold and the wrong choice: `SELECT * FROM claims` and `3 * 4`
 * are things people send each other here, and either would turn into emphasis. Doubling the
 * marker makes an accident implausible.
 *
 * `_italic_` carries the opposite risk — `claim_id`, `snake_case_name`, `__init__` — so an
 * underscore is a marker only at a word boundary AND only when no second underscore is
 * beside it. `claim_id_here` stays literal because the opening underscore has a word
 * character to its left; `__init__` needs the second rule, which the first does not catch.
 *
 * ## What it deliberately does not do
 *
 * No links, no lists, no headings, no code fences, no images. This is emphasis inside a
 * sentence, not a document format, and each of those brings a parser and a security
 * question with it. A URL is already recognised elsewhere; a heading in a chat message is
 * not a thing anybody has asked for.
 *
 * ## The customer widget does not render this, and shows the markers
 *
 * `customer-web` is a separate surface and may not import this one, so a reply an employee
 * emphasises reaches a customer as `**urgent**`. That is a real gap and it is recorded
 * rather than papered over: the markers are plain text, which people already type into chat
 * windows and customers already see, so the failure is mild — but it IS a failure, and the
 * fix is to render emphasis in the widget when Stage 2 opens that surface, not to make the
 * shortcut behave differently depending on which mode the composer is in.
 *
 * ## Safety
 *
 * The output is data, never markup. Nothing here produces HTML, and the caller renders runs
 * as React children, which escapes them — so a body containing `<script>` is text on the
 * screen, exactly as it was before this module existed. There is no `dangerouslySetInnerHTML`
 * anywhere on this path and adding one would be how this feature becomes a vulnerability.
 */

export interface TextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/** The markers, as the composer's shortcuts insert them. */
export const BOLD_MARKER = '**';
export const ITALIC_MARKER = '_';

/**
 * How deep emphasis may nest before the scanner stops looking.
 *
 * `**_both_**` is two levels and is worth supporting. Beyond that is nobody's message and
 * is a way to make a scanner do quadratic work on a string somebody typed on purpose.
 */
const MAX_DEPTH = 4;

/** Word characters, for deciding whether an underscore is a marker or part of a name. */
const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

/**
 * Splits one run of text into emphasised and plain pieces.
 *
 * Adjacent runs with identical marks are NOT merged. They cannot occur — the scanner only
 * emits a plain run when it reaches a marker or the end — and merging them would be work
 * done for a case that does not arise.
 */
export function formatRuns(text: string): readonly TextRun[] {
  return scan(text, {}, 0);
}

function scan(text: string, marks: Omit<TextRun, 'text'>, depth: number): readonly TextRun[] {
  if (text === '') return [];
  if (depth >= MAX_DEPTH) return [{ text, ...marks }];

  const runs: TextRun[] = [];
  /* Where the current plain stretch began. Emitted when a marker is matched, or at the end
     — so a string with no markers produces exactly one run and no intermediate garbage. */
  let plainFrom = 0;
  let i = 0;

  const flushPlain = (until: number): void => {
    if (until > plainFrom) runs.push({ text: text.slice(plainFrom, until), ...marks });
  };

  while (i < text.length) {
    const bold = matchBold(text, i, marks);
    if (bold !== undefined) {
      flushPlain(i);
      runs.push(...scan(bold.content, { ...marks, bold: true }, depth + 1));
      i = bold.end;
      plainFrom = i;
      continue;
    }

    const italic = matchItalic(text, i, marks);
    if (italic !== undefined) {
      flushPlain(i);
      runs.push(...scan(italic.content, { ...marks, italic: true }, depth + 1));
      i = italic.end;
      plainFrom = i;
      continue;
    }

    i += 1;
  }

  flushPlain(text.length);
  return runs;
}

interface Match {
  readonly content: string;
  /** Index just past the closing marker. */
  readonly end: number;
}

function matchBold(text: string, at: number, marks: Omit<TextRun, 'text'>): Match | undefined {
  /* Already inside bold: a nested `**` is literal. Without this, `**a**b**` would pair the
     wrong markers and the middle would come out emphasised in a way nobody typed. */
  if (marks.bold === true) return undefined;
  if (!text.startsWith(BOLD_MARKER, at)) return undefined;

  const from = at + BOLD_MARKER.length;
  const close = text.indexOf(BOLD_MARKER, from);
  if (close === -1) return undefined;

  const content = text.slice(from, close);
  /* Empty, or only spaces: `****` and `** **` are not emphasis, they are asterisks. The
     check also stops `** **` from swallowing the separator in `a ** b ** c`. */
  if (content.trim() === '') return undefined;

  return { content, end: close + BOLD_MARKER.length };
}

/**
 * An underscore touching another underscore is never a marker.
 *
 * `__init__` is the case this exists for, and the word-boundary rule alone does not catch
 * it: the leading `__` has nothing to its left, so the first underscore opens, and the run
 * pairs up somewhere in the middle of a Python dunder. Doubled underscores appear in
 * identifiers and in nothing anybody means as emphasis, so a neighbour is disqualifying.
 */
const isDoubled = (text: string, at: number): boolean =>
  text[at - 1] === ITALIC_MARKER || text[at + 1] === ITALIC_MARKER;

function matchItalic(text: string, at: number, marks: Omit<TextRun, 'text'>): Match | undefined {
  if (marks.italic === true) return undefined;
  if (text[at] !== ITALIC_MARKER) return undefined;
  if (isDoubled(text, at)) return undefined;

  /* The opening underscore must not have a word character to its left. This single line is
     what keeps `claim_id` and `snake_case` out of the formatter. */
  if (isWordCharacter(text[at - 1])) return undefined;

  /* And it must not be followed by whitespace: `a _ b` is a lone underscore, not an
     opening marker looking for a partner halfway down the message. */
  const next = text[at + 1];
  if (next === undefined || /\s/.test(next)) return undefined;

  for (let close = at + 1; close < text.length; close += 1) {
    if (text[close] !== ITALIC_MARKER) continue;
    if (isDoubled(text, close)) continue;
    /* The closing underscore must not have a word character to its RIGHT, by the same
       argument, and must not have whitespace to its left — `_a ` never closes. */
    if (isWordCharacter(text[close + 1])) continue;
    const content = text.slice(at + 1, close);
    if (content === '' || /\s$/.test(content)) continue;
    return { content, end: close + 1 };
  }
  return undefined;
}

/**
 * What Ctrl+B and Ctrl+I do to a selection.
 *
 * Returns the whole new value and where the selection should land, because both are needed
 * together: setting the text without restoring the selection drops the caret at the end of
 * the message, which is the reason people stop using a shortcut after trying it twice.
 *
 * Toggling, not just wrapping. A selection already wrapped in the marker is UNwrapped —
 * pressing Ctrl+B twice has to leave the message as it was found, or the shortcut becomes
 * something people are afraid to press.
 */
export function toggleMarker(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: string,
): { readonly value: string; readonly selectionStart: number; readonly selectionEnd: number } {
  const before = value.slice(0, selectionStart);
  const selected = value.slice(selectionStart, selectionEnd);
  const after = value.slice(selectionEnd);

  /* Wrapped INSIDE the selection: `**bold**` was selected, markers and all. */
  if (
    selected.length > 2 * marker.length &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const stripped = selected.slice(marker.length, selected.length - marker.length);
    return {
      value: `${before}${stripped}${after}`,
      selectionStart,
      selectionEnd: selectionStart + stripped.length,
    };
  }

  /* Wrapped AROUND the selection: the word was selected by double-click and the markers sit
     just outside it. Both cases occur constantly and only handling one of them makes the
     toggle feel arbitrary. */
  if (before.endsWith(marker) && after.startsWith(marker)) {
    const value_ =
      before.slice(0, before.length - marker.length) + selected + after.slice(marker.length);
    return {
      value: value_,
      selectionStart: selectionStart - marker.length,
      selectionEnd: selectionEnd - marker.length,
    };
  }

  /* Nothing selected: drop an empty pair and put the caret between them, so the next
     keystroke is already emphasised. This is what the shortcut does most often — people
     press Ctrl+B and then type. */
  if (selected === '') {
    return {
      value: `${before}${marker}${marker}${after}`,
      selectionStart: selectionStart + marker.length,
      selectionEnd: selectionStart + marker.length,
    };
  }

  return {
    value: `${before}${marker}${selected}${marker}${after}`,
    selectionStart: selectionStart + marker.length,
    selectionEnd: selectionEnd + marker.length,
  };
}
