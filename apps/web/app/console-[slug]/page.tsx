import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { consoleRequestIsValid, getAdminSession } from '@/lib/server/session';
import { readConfig } from '@/lib/server/admin-config';
import { ConsoleView } from '@/components/console/ConsoleView';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Hidden admin console. Reached only through proxy.ts (`/console-<ADMIN_CONSOLE_SLUG>`),
 * which forwards the slug in a header. The slug and the SIWE session are re-checked here.
 */
async function Gate() {
  if (!(await consoleRequestIsValid())) notFound();
  const session = await getAdminSession();
  if (!session) notFound();
  const config = await readConfig();
  return <ConsoleView admin={session.a} initialConfig={config} />;
}

export default function ConsolePage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <Gate />
    </Suspense>
  );
}
