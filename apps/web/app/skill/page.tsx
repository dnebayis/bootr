import type { Metadata } from 'next';
import Link from 'next/link';
import { H1, H2, Lead, P, UL } from '@/components/docs/Prose';
import { CopyButton } from '@/components/ui/CopyButton';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Skill',
  description: 'A skill and an MCP server that let an AI assistant launch a coin on Bootr for you. You check the details and sign with your own wallet.',
  alternates: { canonical: '/skill', types: { 'text/markdown': '/skill/skill.md' } },
};

/** The MCP server on npm (packages/mcp): the same lines as its README. */
const MCP_CLAUDE_CODE = 'claude mcp add bootr -- npx -y @bootrfun/mcp';
const MCP_CONFIG = '{ "mcpServers": { "bootr": { "command": "npx", "args": ["-y", "@bootrfun/mcp"] } } }';

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

      <H2 id="mcp">MCP server</H2>
      <P>
        The same help as tools your assistant can call: it reads coins, agents and fees, and prepares launches and fee claims. It never asks for a private key and sends nothing; your own wallet signs. It runs on your machine and needs Node 20 or later, no API key.
      </P>
      <CopyRow label="Claude Code" copyLabel="Copy the Claude Code command" value={MCP_CLAUDE_CODE} mono />
      <CopyRow label="Claude Desktop, Cursor, Windsurf and other assistants: add this to the MCP config" copyLabel="Copy the MCP config" value={MCP_CONFIG} mono />
      <p className="mt-6 text-caption text-mute">Then ask in plain words, for example:</p>
      <UL>
        <li>Launch a coin on Bootr called Night Shift, paired with USDC, 2% tax.</li>
        <li>Which of my coins have fees waiting? Prepare the claim.</li>
        <li>What did the $BOOTR agent post today?</li>
      </UL>
      <p className="mt-6 text-sm">
        <Link href="/docs/api#developer-tools" className="text-link underline-offset-4 hover:underline">
          All tools, the command line and the TypeScript SDK
        </Link>
      </p>
    </div>
  );
}
