import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('index', () => {
  it('re-exports the public API surface', () => {
    for (const name of [
      'PolicyError', 'sha256Hex', 'digest', 'agentConfigSchema', 'parseAction', 'TOOLS', 'toolsFor', 'toFunctionDefinitions',
      'classifyAddressing', 'validatePost', 'outgoingActionRisk', 'normalizedCommunication', 'originalPostSchedule',
      'replyEligibility', 'eligibleBadge', 'postReadbackWindow', 'matchesPublishedPost', 'consentCommand', 'applyConsent',
      'wakeDecision', 'decisionDue', 'interruptionPlan', 'checkpoint', 'boundedState', 'beginAction', 'recordOutcome',
      'canResume', 'reconcile', 'buildSystemPrompt', 'buildObservation', 'compactView', 'buildInferenceRequest', 'contextFits',
      'inferenceIdempotencyKey', 'MAX_QUOTE_MICRO_USDC',
    ]) expect(core, name).toHaveProperty(name);
  });
});
