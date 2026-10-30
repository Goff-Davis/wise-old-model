import { errorMessage } from '@wom/shared';
import { z } from 'zod';
import type { ToolArgs, ToolContext, ToolDef, TurnInput } from './provider.ts';

/** Why a call isn't run, as the model reads it. */
export const NOT_AVAILABLE = "That tool isn't available in this chat.";
export const DECLINED = 'The user declined this change.';

/** Why a turn ended at the settings' most tool rounds, for every provider to say the same. */
export const tooManyRounds = (maxTurns: number) =>
  `It used the most tool rounds allowed for one question (${maxTurns}). Ask it to go on, or raise the limit in Settings.`;

/** A tool's result as the model reads it: its JSON, or its failure's message as an error. */
export async function runTool(
  def: ToolDef,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: JSON.stringify(await def.run(args, ctx)), isError: false };
  } catch (error) {
    return { text: errorMessage(error), isError: true };
  }
}

/**
 * Whether a call the model made may run: a lookup always; a change only once the user approves
 * its summary (one that can't be made is refused with why, unasked); anything else never.
 */
export async function mayRun(
  def: ToolDef | undefined,
  args: ToolArgs,
  ctx: ToolContext,
  requestApproval: TurnInput['requestApproval'],
): Promise<{ allowed: true; def: ToolDef } | { allowed: false; message: string }> {
  if (def?.readOnly) return { allowed: true, def };
  if (!def?.summary) return { allowed: false, message: NOT_AVAILABLE };
  let summary: string;
  try {
    summary = await def.summary(args, ctx);
  } catch (error) {
    return { allowed: false, message: errorMessage(error) };
  }
  return (await requestApproval({ toolName: def.name, summary }))
    ? { allowed: true, def }
    : { allowed: false, message: DECLINED };
}

/** A tool as the model APIs declare one: its input as JSON Schema. */
export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * Each tool's input as JSON Schema of what the model may send (a field with a default can be
 * left out), without the `$schema` line some APIs refuse.
 */
export function toolSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((def) => {
    const { $schema: _dialect, ...parameters } = z.toJSONSchema(z.object(def.input), {
      io: 'input',
    });
    return { name: def.name, description: def.description, parameters };
  });
}
