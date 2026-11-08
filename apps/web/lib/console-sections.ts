/**
 * The creator console's sections (components/token/CreatorConsole.tsx): one tab each, in this order. Pure helpers so
 * the mapping from a config change to the tab that holds it is testable.
 */
import type { AgentConfigChanges } from '@/lib/types';

export type ConsoleSection = 'mind' | 'posting' | 'powers' | 'look' | 'inbox' | 'fuel';

export const CONSOLE_SECTIONS: readonly { id: ConsoleSection; label: string }[] = [
  { id: 'mind', label: 'Mind' },
  { id: 'posting', label: 'Posting' },
  { id: 'powers', label: 'Powers' },
  { id: 'look', label: 'Look' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'fuel', label: 'Fuel' },
];

/** The sections whose fields the agent's settings form covers; the save bar is always shown on these. */
export const SETTINGS_SECTIONS: readonly ConsoleSection[] = ['mind', 'posting', 'powers', 'look'];

export function sectionLabel(id: ConsoleSection): string {
  return CONSOLE_SECTIONS.find((s) => s.id === id)!.label;
}

/** Which sections hold unsaved edits (the dot on the tab and the save bar's note), in tab order. */
export function changedSections(changes: AgentConfigChanges | null): ConsoleSection[] {
  if (!changes) return [];
  const out = new Set<ConsoleSection>();
  if (changes.instructions !== undefined || changes.model !== undefined || changes.routing !== undefined) out.add('mind');
  if (changes.postsPerDay !== undefined || changes.requireApproval !== undefined || changes.worker?.jobLines !== undefined) out.add('posting');
  if (changes.worker?.capabilities !== undefined || changes.services !== undefined) out.add('powers');
  if (changes.imageModel !== undefined || changes.imageStyle !== undefined) out.add('look');
  return CONSOLE_SECTIONS.map((s) => s.id).filter((id) => out.has(id));
}
