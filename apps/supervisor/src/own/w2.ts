/**
 * Own agents (docs/design/byo-agent.md section 13.4): what the second workstream hands the turn engine through the
 * registry. Two roles (`treasury`, `judge`) and three special tools (`answer_request`, `judge_entry`, `judge`). The
 * engine (own/turns.ts) finds them with `ownRole` and `ownTool`; nothing here imports it, runs a model or looks at the
 * flag: a role answers for the coin it is asked about, and the routes decide whether anyone may ask.
 */
import { judgeEntryTool, judgeRole, judgeTool } from './judge.js';
import { registerOwnRole, registerOwnTool } from './registry.js';
import { answerRequestTool } from './requests.js';
import { treasuryRole } from './treasury.js';

/** Called once per app (api.ts, directly before `return app;`); registering again replaces, so several apps in one process are fine. */
export function registerW2(): void {
  registerOwnRole(treasuryRole);
  registerOwnRole(judgeRole);
  registerOwnTool(answerRequestTool);
  registerOwnTool(judgeEntryTool);
  registerOwnTool(judgeTool);
}
