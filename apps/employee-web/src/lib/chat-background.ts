'use client';

/**
 * The ground the conversation is drawn on.
 *
 * ## Separate from light/dark, deliberately
 *
 * `theme.ts` decides whether the whole product is light or dark, and that is a property of
 * the room somebody is sitting in. This is a smaller question about one surface: what the
 * thread's own background looks like. Each of these works in both themes — the tokens are
 * redefined under `[data-theme="dark"]` in the stylesheet — so the two choices compose
 * rather than multiplying into eight combinations somebody has to pick from.
 *
 * ## What may change and what may not
 *
 * The brand accent does not. CY Orange is the product's one loud colour and it identifies
 * the send button, the unread count and the active tab; a background that changed it would
 * be a different product wearing the same name. What each option may set is the thread's
 * ground, the pattern on it, and the two bubble colours — which is enough to feel different
 * and not enough to become unrecognisable.
 *
 * ## Why four, and why these
 *
 * Constellation is the default and the one the product is named for. Plain exists because
 * a texture behind text is a preference and a sizeable share of people simply do not want
 * one — offering the pattern with no way off it is the complaint every messenger with a
 * wallpaper eventually gets. Graph is for the working day: a faint square grid reads as
 * paper rather than decoration, and it is the one that survives a screen share into a
 * meeting. Dusk keeps the constellation and drops the ground several steps, for the people
 * who run the whole machine light but want the thread quieter than the panels around it.
 *
 * ## Stored per device
 *
 * Like the theme, and for the same reason: it is about the screen in front of you, not
 * about your account. A laptop and a phone can reasonably disagree, and syncing it would
 * mean a preference round trip before the first paint.
 */

const BACKGROUND_KEY = 'starlink.chatBackground';

export const CHAT_BACKGROUNDS = ['constellation', 'plain', 'graph', 'dusk'] as const;

export type ChatBackground = (typeof CHAT_BACKGROUNDS)[number];

export const CHAT_BACKGROUND_LABELS: Readonly<Record<ChatBackground, string>> = {
  constellation: 'Constellation',
  plain: 'Plain',
  graph: 'Graph',
  dusk: 'Dusk',
};

function isBackground(value: unknown): value is ChatBackground {
  return (CHAT_BACKGROUNDS as readonly unknown[]).includes(value);
}

/** Writes the attribute the stylesheet reads. */
export function applyChatBackground(choice: ChatBackground): void {
  document.documentElement.setAttribute('data-chat-bg', choice);
  try {
    window.localStorage.setItem(BACKGROUND_KEY, choice);
  } catch {
    /* Site data blocked. The choice applies for this session and is simply not
       remembered — which is better than refusing to apply it. */
  }
}

export function readChatBackground(): ChatBackground {
  try {
    const stored = window.localStorage.getItem(BACKGROUND_KEY);
    if (isBackground(stored)) return stored;
  } catch {
    /* Same as above; the default is correct. */
  }
  return 'constellation';
}

/**
 * Inlined into `<head>`, for the same reason the theme's boot script is.
 *
 * Read from a component effect, the first paint would be the default ground and the second
 * the chosen one — a visible flash of the wrong background on every load, on the largest
 * surface on the screen.
 *
 * Fails to the default: no attribute means the stylesheet's bare `:root` values apply,
 * which are the constellation. There is no state in which the thread has no ground.
 */
export const chatBackgroundBootScript = `(function(){try{
var v = window.localStorage.getItem('${BACKGROUND_KEY}');
if (${JSON.stringify(CHAT_BACKGROUNDS)}.indexOf(v) !== -1) {
  document.documentElement.setAttribute('data-chat-bg', v);
}
}catch(e){}})();`;
