/**
 * Own agents (docs/design/byo-agent.md sections 2.6 and 5.1): what a creator needs to connect their AI client to
 * Bootr and to keep their coin's agent running, as data. The launch page's connect step and the console's Agent card
 * render it; nothing here runs anything. An own agent works only while something on the creator's machine starts a
 * turn, so each recipe is a ready way to do that. They are help and nothing more: Bootr never steps in.
 *
 * The connect lines are the ones the MCP package's README carries (packages/mcp/README.md). Public copy: no internal
 * names; "Bootr agent" and "My own agent" are the two words for who runs the agent.
 */

export type AiClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'other';

export interface CopyBlock {
  /** What the block is, shown above it and read by the copy button. */
  label: string;
  text: string;
}

export interface AiClientSetup {
  id: AiClientId;
  /** The tab's label. */
  label: string;
  /** One line on where the block goes. */
  intro: string;
  /** The one command or config block that adds the Bootr server to this client. */
  install: CopyBlock;
  /** A short note under the block, when the client needs one. */
  note?: string;
}

const MCP_COMMAND = 'npx -y @bootrfun/mcp';
const MCP_CONFIG = `{
  "mcpServers": {
    "bootr": {
      "command": "npx",
      "args": ["-y", "@bootrfun/mcp"]
    }
  }
}`;

/** The clients the connect step names, in tab order. Every one needs Node 20 or later on the machine. */
export const AI_CLIENTS: readonly AiClientSetup[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    intro: 'Run this once in a terminal.',
    install: { label: 'Claude Code command', text: `claude mcp add bootr -- ${MCP_COMMAND}` },
    note: 'Add -s user after "add" to have it in every folder.',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    intro: 'Open Settings, then Developer, then Edit Config, add this and restart the app.',
    install: { label: 'Claude Desktop config', text: MCP_CONFIG },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    intro: 'Open Cursor Settings, then MCP, add a new server and paste this.',
    install: { label: 'Cursor config', text: MCP_CONFIG },
  },
  {
    id: 'codex',
    label: 'Codex',
    intro: 'Run this once in a terminal.',
    install: { label: 'Codex command', text: `codex mcp add bootr -- ${MCP_COMMAND}` },
  },
  {
    id: 'other',
    label: 'Other',
    intro: 'Any client that can run a local MCP server works. Add this to its MCP config.',
    install: { label: 'MCP config', text: MCP_CONFIG },
  },
];

export function aiClient(id: AiClientId): AiClientSetup {
  return AI_CLIENTS.find((c) => c.id === id) ?? AI_CLIENTS[0]!;
}

/** What the creator says to the client once the server is added. The client answers with a link and a short code. */
export const ASK_TO_CONNECT = 'Connect to Bootr and show me the link.';

/** `$QENG` for a symbol, or "my coin" while the creator has not typed one yet. */
function coinName(symbol: string | null | undefined): string {
  const s = (symbol ?? '').trim().replace(/^\$/, '').toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(s) ? `$${s}` : 'my coin';
}

/**
 * The sentence that starts one round of work: ask what is due, do it, finish. A fresh run each time and Bootr's tools
 * only, which is what keeps text written by strangers away from the rest of the machine.
 */
export function turnPrompt(symbol: string | null | undefined): string {
  return `Use only the Bootr tools. For ${coinName(symbol)}: ask Bootr what is due, do each due role in its own turn, then finish.`;
}

export interface KeepRunningRecipe {
  client: AiClientId;
  /** The client's name, as the tab says it. */
  title: string;
  /** What the recipe does, in one line. */
  summary: string;
  /** Plain sentences, in order. */
  steps: string[];
  /** The text to copy, with the coin's symbol filled in; null when the recipe has nothing to paste. */
  copy: CopyBlock | null;
}

/** How often the scheduled recipes look. Bootr answers "nothing is due" for free, so a short interval costs nothing. */
export const KEEP_RUNNING_MINUTES = 15;

/** The sentence as one shell word: single quotes, so `$SYM` is not read as a variable by the shell that runs the schedule. */
function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * One recipe per client, with the coin's symbol in the text to copy. The same order as `AI_CLIENTS`. What each
 * client can do on a schedule differs; where a client has no scheduler the recipe says so and names the way around.
 */
export function keepRunningRecipes(symbol: string | null | undefined): KeepRunningRecipe[] {
  const prompt = turnPrompt(symbol);
  const every = KEEP_RUNNING_MINUTES;
  return [
    {
      client: 'claude-code',
      title: 'Claude Code',
      summary: `A fresh run every ${every} minutes, with only Bootr’s tools allowed.`,
      steps: [
        'Open your schedule with crontab -e (macOS and Linux) and add the line above.',
        'Each run starts clean and may use Bootr’s tools only, so nothing a stranger writes on X can reach your files or your shell.',
        `Inside an open session you can use /loop ${every}m followed by the same sentence instead.`,
        'If the schedule cannot find claude, write its full path (which claude shows it). Add the Bootr server with -s user so it is there in every folder.',
      ],
      copy: { label: 'Schedule line for Claude Code', text: `*/${every} * * * * claude -p ${shellQuoted(prompt)} --allowedTools "mcp__bootr__*"` },
    },
    {
      client: 'claude-desktop',
      title: 'Claude Desktop',
      summary: 'A scheduled task that checks Bootr every hour.',
      steps: [
        'If your Claude Desktop has scheduled tasks, add one that runs every hour with the sentence above.',
        'Without scheduled tasks, open a chat and paste the sentence whenever you want the agent to work.',
        'Keep that chat for Bootr only: do not ask it to read files or browse in the same conversation.',
      ],
      copy: { label: 'Sentence for Claude Desktop', text: prompt },
    },
    {
      client: 'cursor',
      title: 'Cursor',
      summary: 'Cursor has no schedule of its own: run it by hand, or let the Bootr command line wait for you.',
      steps: [
        'By hand: open a new chat and paste the sentence above whenever you want the agent to work.',
        'Hands off: the Bootr command line waits until something is due and then runs a command you name. Install it with npm i -g @bootrfun/cli and run bootr own watch --exec "<your command>".',
      ],
      copy: { label: 'Sentence for Cursor', text: prompt },
    },
    {
      client: 'codex',
      title: 'Codex',
      summary: `A fresh run every ${every} minutes.`,
      steps: [
        'Open your schedule with crontab -e (macOS and Linux) and add the line above.',
        'Run it from an empty folder, so the agent has nothing but Bootr’s tools to work with.',
        'If the schedule cannot find codex, write its full path (which codex shows it).',
      ],
      copy: { label: 'Schedule line for Codex', text: `*/${every} * * * * codex exec ${shellQuoted(prompt)}` },
    },
    {
      client: 'other',
      title: 'Other',
      summary: 'Any client you can start from a terminal can be driven by the Bootr command line.',
      steps: [
        'Install the Bootr command line with npm i -g @bootrfun/cli.',
        'Run the line above with the command that starts your client. It waits until something is due, runs your command, and waits again.',
        'Give your client the sentence: ' + prompt,
      ],
      copy: { label: 'Bootr command line', text: 'bootr own watch --exec "<the command that starts your client>"' },
    },
  ];
}

export function keepRunningRecipe(client: AiClientId, symbol: string | null | undefined): KeepRunningRecipe {
  const all = keepRunningRecipes(symbol);
  return all.find((r) => r.client === client) ?? all[0]!;
}

/** What is true of every own agent, said once under the recipes. */
export const KEEP_RUNNING_FACTS: readonly string[] = [
  'Your machine on, the agent works. Off, it is silent: Bootr never takes over.',
  'Scheduled posts it missed are not made up later, and mentions older than a day are closed unanswered when it comes back.',
  'Fee claims, gas and posts you already approved keep working without your machine.',
];

/** Where an own agent's pictures come from: a folder on the creator's machine, nothing else. */
export const PICTURES_NOTE = 'Pictures: the agent can post only PNG, JPEG or WebP files from the bootr-pictures folder in your home folder. Nothing else on your machine can be uploaded.';
