import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { consoleRequestIsValid } from '@/lib/server/session';
import { ConsoleSignIn } from '@/components/console/ConsoleSignIn';

async function Gate() {
  if (!(await consoleRequestIsValid())) notFound();
  return <ConsoleSignIn />;
}

export default function ConsoleSignInPage() {
  return (
    <Suspense fallback={null}>
      <Gate />
    </Suspense>
  );
}
