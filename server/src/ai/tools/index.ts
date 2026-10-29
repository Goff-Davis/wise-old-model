import type { AccountDeps } from '../../services/accounts.ts';
import type { ToolDef } from '../provider.ts';
import { accountTools } from './account.ts';
import { calculationTools } from './calculations.ts';
import { goalTools } from './goals.ts';
import { knowledgeTools } from './knowledge.ts';

/**
 * The chat's tools, in a fixed order: the account's data, calculations, game knowledge, then
 * goals. Only add_goal and update_goal change anything, and each needs the user's Approve.
 */
export function buildTools(deps: AccountDeps): ToolDef[] {
  return [
    ...accountTools(deps),
    ...calculationTools(deps),
    ...knowledgeTools(deps),
    ...goalTools(deps),
  ];
}
