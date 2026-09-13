/**
 * The mark a group conversation wears where a person wears their initials.
 *
 * ## Why not the hash it replaces
 *
 * `#` was chosen as "the marker for a room", and it is — in Slack, where a hash means a
 * CHANNEL: open, topic-shaped, joinable. StarLink has no channels. What it has is a
 * conversation between several named colleagues, and the hash told people otherwise every
 * time they scanned the list. It also collided with the mention pill's own typography, so
 * a column of groups read as a column of tags.
 *
 * Two overlapping figures say the one thing that is actually true of a group and not of a
 * direct message: there is more than one person in here. It survives greyscale, which the
 * tint alone does not (NFR-ACC-3), and it is legible at the 30px the list draws it at,
 * which a third figure would not be.
 *
 * `aria-hidden`, always. Every place this appears, the conversation's name is already in
 * text beside it — a screen reader announcing "group icon" before that name adds a word
 * and no information.
 */
export function GroupGlyph(): React.JSX.Element {
  return (
    <svg
      className="group-glyph"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* The back figure first, so the front one paints over it and the overlap reads as
          depth rather than as a single wide shape. */}
      <path
        opacity="0.55"
        d="M16.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.5c-.9 0-1.72.16-2.44.44A5.2 5.2 0 0 1 15.8 17v1.5h5.7V17c0-2.2-2.6-4.5-5-4.5Z"
      />
      <path d="M9 11a3.25 3.25 0 1 0 0-6.5A3.25 3.25 0 0 0 9 11Zm0 1.6c-2.6 0-6.5 1.35-6.5 4.05v1.85h13V16.65c0-2.7-3.9-4.05-6.5-4.05Z" />
    </svg>
  );
}
