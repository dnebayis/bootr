import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-4 py-24">
      <span className="font-mono text-caption text-mute">404</span>
      <h1 className="text-display-lg font-semibold text-ink">This page does not exist.</h1>
      <p className="text-sm text-mute">The address may be wrong, or the token has not been indexed yet.</p>
      <Link href="/" className="text-link underline-offset-4 hover:underline">
        Back to tokens
      </Link>
    </div>
  );
}
