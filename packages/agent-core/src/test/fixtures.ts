import type { AgentConfigInput } from '../types.js';

export const baseConfig: AgentConfigInput = {
  agentId: 'agent-1',
  token: { address: '0x' + '1'.repeat(40), symbol: 'BOOTR', name: 'Bootr Coin', chainId: 8453 },
  kernel: { address: '0x' + '2'.repeat(40) },
  creator: { address: '0x' + '3'.repeat(40), xHandle: 'creator' },
  xHandle: 'bootragent',
  xUserId: '1234567890',
  model: 'gpt-5-mini',
  identityText: 'I am Bootr.',
  capabilities: { xRead: true, xReply: true, xPublish: true, memory: true, research: true },
};
