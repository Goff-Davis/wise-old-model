import type { ChatProvider, ProviderEvent, ProviderMeta, ToolArgs, TurnInput } from './provider.ts';

/**
 * A step of a fake turn: an event to give, a tool to run (as a provider's tool loop would, with
 * the turn's context), a change to ask the user about, an error to throw, or a wait that never
 * ends (a request that doesn't heed Stop).
 */
export type FakeStep =
  | ProviderEvent
  | { type: 'run_tool'; id: string; name: string; args?: ToolArgs }
  | { type: 'ask'; toolName: string; summary: string }
  | { type: 'throw'; message: string }
  | { type: 'hang' };

/** Claude's info, as a fake provider has it unless a test says otherwise. */
export const CLAUDE_INFO: ProviderMeta = {
  id: 'claude',
  name: 'Claude',
  choosesBilling: true,
  defaultModel: null,
};

/**
 * A provider that plays a script, for tests: the same steps each turn, or the steps
 * `script(turn)` gives for the turn (0 first). It stops at the next step once the turn is
 * stopped. `turns` keeps what each turn was given, and `answers` each approval's answer. It's
 * Claude unless `info` says otherwise.
 */
export function createFakeProvider(
  script: FakeStep[] | ((turn: number) => FakeStep[]),
  info: Partial<ProviderMeta> = {},
) {
  const turns: TurnInput[] = [];
  const answers: boolean[] = [];
  const provider: ChatProvider = {
    info: { ...CLAUDE_INFO, ...info },
    async *runTurn(input) {
      turns.push(input);
      const steps = typeof script === 'function' ? script(turns.length - 1) : script;
      for (const step of steps) {
        if (input.signal.aborted) return;
        if (step.type === 'run_tool') {
          yield { type: 'tool_started', id: step.id, name: step.name, input: step.args ?? {} };
          const tool = input.tools.find((one) => one.name === step.name);
          let isError = !tool;
          try {
            await tool?.run(step.args ?? {}, input.toolContext);
          } catch {
            isError = true;
          }
          yield { type: 'tool_finished', id: step.id, isError };
        } else if (step.type === 'ask') {
          answers.push(await input.requestApproval(step));
        } else if (step.type === 'throw') {
          throw new Error(step.message);
        } else if (step.type === 'hang') {
          await new Promise(() => {});
        } else {
          yield step;
        }
      }
    },
  };
  return { provider, turns, answers };
}
