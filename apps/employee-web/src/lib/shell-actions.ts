'use client';

/**
 * Two actions the shell owns, callable from a route page.
 *
 * ## Why an event and not a prop
 *
 * The empty pane is a route (`/conversations`), and the things its buttons must do belong
 * to the layout above it: opening the compose dialog is `StartConversation`'s own state,
 * and switching to People is the rail's. Next renders the page as `children`, so neither is
 * reachable by passing a callback down — the layout would have to hoist both into a context
 * that exists solely to be read by one screen.
 *
 * A window event is smaller and has the property that matters here: the page announces an
 * intention and does not need to know who acts on it. If nobody is listening — which is the
 * case for a moment during navigation — nothing happens, which is the correct outcome.
 *
 * ## Why not a URL
 *
 * `?compose=1` would survive a reload and re-open the dialog every time somebody returned
 * to the empty pane, which is exactly the behaviour a modal must not have.
 */

const NEW_CONVERSATION = 'starlink:new-conversation';
const BROWSE_DIRECTORY = 'starlink:browse-directory';
/**
 * "Open this destination" — the general case the other two are instances of.
 *
 * Added for the empty pane's "# Announcements" chip. Kept as a separate event with a
 * payload rather than one more bare event per destination, because the rail has five and
 * five events named after them would be five things to remember to add the next time it
 * grows one.
 */
const OPEN_SECTION = 'starlink:open-section';

/**
 * Opens the new-conversation dialog, optionally straight into one of its modes.
 *
 * The empty pane's button says "New chat", and after the dialog grew a mode fork it opened
 * on a screen whose first option also said "New chat" — the same words twice, one press
 * apart. Passing the mode makes the button do what it says instead of renaming it to
 * something the design does not use.
 */
export function requestNewConversation(mode?: 'chat' | 'group'): void {
  window.dispatchEvent(new CustomEvent(NEW_CONVERSATION, { detail: mode }));
}

export function requestBrowseDirectory(): void {
  window.dispatchEvent(new Event(BROWSE_DIRECTORY));
}

/** Switches the shell's panel. The string is a `RailSection`; see the shell's listener. */
export function requestSection(section: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SECTION, { detail: section }));
}

/** Both listeners in one call, returning a single unsubscribe. */
export function onShellAction(handlers: {
  readonly onNewConversation?: (mode?: 'chat' | 'group') => void;
  readonly onBrowseDirectory?: () => void;
  readonly onOpenSection?: (section: string) => void;
}): () => void {
  const compose = (event: Event): void => {
    const mode = (event as CustomEvent<'chat' | 'group' | undefined>).detail;
    handlers.onNewConversation?.(mode === 'chat' || mode === 'group' ? mode : undefined);
  };
  const browse = (): void => handlers.onBrowseDirectory?.();
  const open = (event: Event): void => {
    const section = (event as CustomEvent<string>).detail;
    if (typeof section === 'string') handlers.onOpenSection?.(section);
  };
  window.addEventListener(NEW_CONVERSATION, compose);
  window.addEventListener(BROWSE_DIRECTORY, browse);
  window.addEventListener(OPEN_SECTION, open);
  return () => {
    window.removeEventListener(NEW_CONVERSATION, compose);
    window.removeEventListener(BROWSE_DIRECTORY, browse);
    window.removeEventListener(OPEN_SECTION, open);
  };
}
