import { cn } from './cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-xs bg-canvas-sub', className)} />;
}
