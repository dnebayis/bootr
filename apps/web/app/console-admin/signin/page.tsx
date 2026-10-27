import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { consoleRequestIsValid, type SearchParams } from '@/lib/server/session';
import { ConsoleSignIn } from '@/components/console/ConsoleSignIn';

async function Gate({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!(await consoleRequestIsValid(await searchParams))) notFound();
  return <ConsoleSignIn />;
}

export default function ConsoleSignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <Suspense fallback={null}>
      <Gate searchParams={searchParams} />
    </Suspense>
  );
}
