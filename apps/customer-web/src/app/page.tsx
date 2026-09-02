import type { ReactNode } from 'react';

import { Chat } from '../components/chat';

/**
 * The host page.
 *
 * Deliberately thin: the chat is the product here, and everything it needs is fetched
 * client-side. Doc §19.3 is the reason it is not server-rendered — data fetched on the
 * server is serialised into the HTML, so anything loaded for a customer page is IN that
 * customer's page source. For a surface whose entire job is to be careful about what a
 * customer can see, that is the wrong default.
 */
export default function Page(): ReactNode {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>CoverYou</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Questions about a policy, a claim or a renewal? Start a chat and we will pick it up.
        </p>
      </div>
      <Chat />
    </main>
  );
}
