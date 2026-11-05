import type { Metadata } from 'next';
import { H1, Lead } from '@/components/docs/Prose';
import { CopyButton } from '@/components/ui/CopyButton';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Skill',
  description: 'A skill that lets an AI assistant launch a coin on Bootr for you. You check the details and sign with your own wallet.',
  alternates: { canonical: '/skill', types: { 'text/markdown': '/skill/skill.md' } },
};

function CopyRow({ label, copyLabel, value, mono }: { label: string; copyLabel: string; value: string; mono?: boolean }) {
  return (
    <div className="mt-6">
      <p className="text-caption text-mute">{label}</p>
      <div className="mt-1.5 flex items-center gap-2 rounded-md border border-hairline bg-canvas-soft py-1 pr-1 pl-3">
        <p className={`min-w-0 flex-1 py-1.5 text-sm text-ink [overflow-wrap:anywhere] ${mono ? 'font-mono' : ''}`}>{value}</p>
        <CopyButton value={value} label={copyLabel} className="size-9 shrink-0" />
      </div>
    </div>
  );
}

export default function SkillPage() {
  const url = `${env.siteUrl}/skill/skill.md`;
  return (
    <div className="mx-auto w-full max-w-2xl pb-16">
      <H1>Skill</H1>
      <Lead>Lets an AI assistant launch a coin on Bootr for you. It prepares everything; you check the details and sign with your own wallet.</Lead>
      <CopyRow label="Skill URL" copyLabel="Copy the skill URL" value={url} mono />
      <CopyRow label="Say this to your assistant" copyLabel="Copy the sentence" value={`Read ${url} and follow it to launch a coin on Bootr`} />
      {/* A plain link: the file is a route handler, not a page, so a client transition cannot show it. */}
      <p className="mt-6 text-sm">
        <a href="/skill/skill.md" className="text-link underline-offset-4 hover:underline">
          Open the raw file
        </a>
      </p>
    </div>
  );
}
