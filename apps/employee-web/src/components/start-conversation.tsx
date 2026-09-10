'use client';

/**
 * The control that opens the new-chat panel, and nothing else.
 *
 * This component used to be the whole feature — trigger, modal, directory search, group
 * assembly and the create call. The panel moved to `new-chat-panel.tsx` when it stopped
 * being a dialog over the page and became a panel over the list, and the SHELL owns
 * whether it is open: the rail's "New chat" and this button are two doors onto one place,
 * and a place with two doors cannot have its lock inside one of them.
 *
 * That also removed a class of bug outright. While this component held the open state,
 * opening it from the rail meant switching to the chats panel and signalling in the same
 * render — and this component mounted holding the new signal, saw no change against it,
 * and did nothing. First press from Channels, Announcements or Connect opened nothing at
 * all. State in the shell has no mount to race.
 */
export function StartConversation({
  onOpen,
}: {
  readonly onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="fab-new"
      onClick={onOpen}
      /*
        The accessible name is still exactly "New conversation". Only the visible label is
        a glyph. A test that finds this button by name — and `responsive.spec.ts` does, at
        every width down to 320px — finds the same button it always did.
      */
      aria-label="New conversation"
    >
      {/*
        A speech bubble with a plus in it, not a bare plus.

        A plus on its own is the universal "add", and in a column of conversations it read
        as a box with a cross in it — it says something will be created and not what. The
        bubble says the noun and the plus says the verb, which is the icon every messenger
        uses for this and the one people recognise without reading a tooltip.
      */}
      <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">
        <path
          d="M20.5 11.3c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.7-.36L4.6 20l1.25-3.4A6.8 6.8 0 0 1 3.5 11.3c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M12 8.6v5.2M9.4 11.2h5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
