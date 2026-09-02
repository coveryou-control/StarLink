'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { useSession } from '../components/session-provider';

export default function IndexPage(): ReactNode {
  const { state } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'SIGNED_IN') router.replace('/conversations');
    if (state.status === 'SIGNED_OUT') router.replace('/sign-in');
  }, [state.status, router]);

  return <p style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</p>;
}
