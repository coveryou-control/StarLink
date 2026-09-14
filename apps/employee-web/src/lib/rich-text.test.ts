import { describe, expect, it } from 'vitest';

import { BOLD_MARKER, ITALIC_MARKER, formatRuns, toggleMarker } from './rich-text';

/**
 * The formatter, and — more importantly — everything it must leave alone.
 *
 * The cases that matter here are not the ones where emphasis works. They are the ones where
 * somebody pastes `SELECT * FROM claims` or types `claim_id` into a chat window and gets
 * back exactly what they typed. A formatter that is enthusiastic is worse than no formatter:
 * it corrupts messages people are using to do their jobs, and it does it silently.
 */
const plain = (text: string): void => {
  expect(formatRuns(text)).toEqual([{ text }]);
};

describe('emphasis that was asked for', () => {
  it('renders **bold**', () => {
    expect(formatRuns('a **big** claim')).toEqual([
      { text: 'a ' },
      { text: 'big', bold: true },
      { text: ' claim' },
    ]);
  });

  it('renders _italic_', () => {
    expect(formatRuns('the _assessor_ said')).toEqual([
      { text: 'the ' },
      { text: 'assessor', italic: true },
      { text: ' said' },
    ]);
  });

  it('nests one inside the other', () => {
    expect(formatRuns('**_urgent_**')).toEqual([{ text: 'urgent', bold: true, italic: true }]);
  });

  it('handles two emphasised runs in one message', () => {
    expect(formatRuns('**one** and **two**')).toEqual([
      { text: 'one', bold: true },
      { text: ' and ' },
      { text: 'two', bold: true },
    ]);
  });

  it('emphasises a whole message', () => {
    expect(formatRuns('**everything**')).toEqual([{ text: 'everything', bold: true }]);
  });
});

describe('text that must survive untouched', () => {
  it('leaves SQL alone', () => {
    // The reason bold is `**` and not `*`. This is a real thing people paste into a claims
    // conversation, and turning half of it into emphasis would corrupt it.
    plain('SELECT * FROM claims WHERE id = 4');
  });

  it('leaves arithmetic and globs alone', () => {
    plain('3 * 4 * 5');
    plain('run *.pdf through the scanner');
  });

  it('leaves snake_case identifiers alone', () => {
    // The reason an underscore only opens at a word boundary.
    plain('the claim_id column');
    plain('snake_case_name_here');
    plain('__init__');
  });

  it('leaves an unmatched marker alone', () => {
    plain('**not closed');
    plain('closed** only');
    plain('a _ b');
  });

  it('does not treat empty markers as emphasis', () => {
    plain('****');
    plain('** **');
  });

  it('leaves a bare underscore between words alone', () => {
    plain('page _ 4');
  });

  it('does not emphasise across a trailing space', () => {
    // `_a ` never closes: a closing underscore with whitespace before it is punctuation.
    plain('_start and _end');
  });

  it('keeps markup as text, because runs are data and never HTML', () => {
    /**
     * The security property in one assertion. Nothing on this path produces markup — the
     * caller renders these as React children, which escapes them. If somebody ever reaches
     * for `dangerouslySetInnerHTML` to render emphasis, this is the test that should have
     * stopped them.
     */
    plain('<script>alert(1)</script>');
    expect(formatRuns('**<img onerror=x>**')).toEqual([
      { text: '<img onerror=x>', bold: true },
    ]);
  });

  it('returns nothing for an empty body', () => {
    expect(formatRuns('')).toEqual([]);
  });
});

describe('what the shortcut does', () => {
  it('wraps a selection', () => {
    const result = toggleMarker('make this bold', 5, 9, BOLD_MARKER);
    expect(result.value).toBe('make **this** bold');
    // The selection still covers the same word, so typing replaces what was selected.
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe('this');
  });

  it('unwraps a selection that already carries the markers', () => {
    // Pressing it twice has to leave the message as it was found.
    const wrapped = toggleMarker('make this bold', 5, 9, BOLD_MARKER);
    const back = toggleMarker(wrapped.value, wrapped.selectionStart - 2, wrapped.selectionEnd + 2, BOLD_MARKER);
    expect(back.value).toBe('make this bold');
  });

  it('unwraps when the markers sit just OUTSIDE the selection', () => {
    /**
     * Double-clicking a word inside `**this**` selects `this`, not the markers. Only
     * handling the other case would make the toggle work or not depending on how the
     * selection was made, which is the kind of inconsistency people read as a bug in
     * themselves.
     */
    const result = toggleMarker('make **this** bold', 7, 11, BOLD_MARKER);
    expect(result.value).toBe('make this bold');
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe('this');
  });

  it('drops an empty pair and puts the caret inside when nothing is selected', () => {
    // The commonest use by far: press Ctrl+B, then type.
    const result = toggleMarker('say ', 4, 4, BOLD_MARKER);
    expect(result.value).toBe('say ****');
    expect(result.selectionStart).toBe(6);
    expect(result.selectionEnd).toBe(6);
  });

  it('works for italic with its single-character marker', () => {
    const result = toggleMarker('make this italic', 5, 9, ITALIC_MARKER);
    expect(result.value).toBe('make _this_ italic');
    expect(toggleMarker(result.value, 6, 10, ITALIC_MARKER).value).toBe('make this italic');
  });

  it('round-trips through the formatter', () => {
    // The shortcut and the renderer have to agree, or Ctrl+B produces visible asterisks.
    const typed = toggleMarker('an urgent claim', 3, 9, BOLD_MARKER);
    expect(formatRuns(typed.value)).toEqual([
      { text: 'an ' },
      { text: 'urgent', bold: true },
      { text: ' claim' },
    ]);
  });
});
