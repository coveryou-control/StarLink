'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import { employeeRoutes } from '@starlink/shared-contracts';

import { runtimeOrigins } from '../lib/runtime-origins';

/**
 * Somebody's picture, where their initials would otherwise be.
 *
 * ## Initials are the default, not the fallback
 *
 * Most people will never upload a picture, and a product where the ordinary case is a
 * broken-image glyph is a broken product. So this renders initials unless it KNOWS there
 * is a picture — the stamp map says which principals have one — and only then does it
 * point an `<img>` at the bytes. There is no request for an avatar that does not exist,
 * and therefore no 404 in the network panel for the majority of people on screen.
 *
 * ## Why a stamp map rather than each avatar asking
 *
 * Thirty rows each firing a request to discover a 404 is thirty round trips to draw
 * initials. The shell asks once for everybody on screen — the same shape as presence — and
 * hands the answer down.
 *
 * ## The version in the URL
 *
 * `?v=<updatedAt>` makes a changed picture a different URL, which is what lets the
 * response be cached `immutable` for a year. Without it either the picture never updates
 * or it is re-fetched on every render; with it, both are solved by the same string.
 */
const AvatarStampContext = createContext<ReadonlyMap<string, string>>(new Map());

export function AvatarStampProvider({
  stamps,
  children,
}: {
  readonly stamps: ReadonlyMap<string, string>;
  readonly children: ReactNode;
}): ReactNode {
  return <AvatarStampContext.Provider value={stamps}>{children}</AvatarStampContext.Provider>;
}

export function useAvatarStamp(principalId: string | undefined): string | undefined {
  const stamps = useContext(AvatarStampContext);
  return principalId === undefined ? undefined : stamps.get(principalId);
}

/**
 * The picture, or `null` when there is none.
 *
 * Returns null rather than the initials themselves so the caller keeps control of the
 * shape and size of what it draws — every avatar in this product is a different diameter
 * and some of them are square.
 */
export function AvatarImage({
  principalId,
  alt,
}: {
  readonly principalId: string | undefined;
  /** Empty when the name is already beside it, which is almost everywhere. */
  readonly alt: string;
}): ReactNode {
  const stamp = useAvatarStamp(principalId);
  if (principalId === undefined || stamp === undefined) return null;

  return (
    <img
      className="avatar-photo"
      src={`${runtimeOrigins().api}${employeeRoutes.avatar(principalId, stamp)}`}
      alt={alt}
      width={256}
      height={256}
      /* The bytes are on the API origin and the session cookie has to travel with the
         request, or the image 401s and renders as a broken glyph. */
      crossOrigin="use-credentials"
      loading="lazy"
      decoding="async"
    />
  );
}

/**
 * A group's picture, over its glyph.
 *
 * No stamp map for these: a group's picture is fetched by the conversation the row is
 * already about, and there are at most a screenful of rows. The image simply 404s when
 * there is none, and the glyph underneath is what shows — which is the same fallback the
 * person avatar uses, reached a different way.
 *
 * The 404 is the reason there is no version string here. Adding one would mean asking the
 * server which groups have pictures before drawing any of them, to save a request that
 * costs nothing and is cached negatively by the browser anyway.
 */
export function ConversationAvatarImage({
  conversationId,
  version,
}: {
  readonly conversationId: string;
  /** Set after an upload in this session, so the new picture appears without a poll. */
  readonly version?: string | undefined;
}): ReactNode {
  return (
    <img
      className="avatar-photo"
      src={`${runtimeOrigins().api}${employeeRoutes.conversations.avatar(conversationId, version)}`}
      alt=""
      crossOrigin="use-credentials"
      loading="lazy"
      decoding="async"
      /* A group with no picture 404s, and a broken-image glyph over the figures would be
         worse than nothing. Hidden on error so the glyph underneath is what remains. */
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}
