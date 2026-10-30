import { useQuery } from '@tanstack/react-query';
import { type JSX, useId } from 'react';
import { aboutQuery } from '../../api/about.ts';
import { chatProvidersQuery } from '../../api/chats.ts';
import { Problem } from '../../components/Problem.tsx';
import { EffortOptions, ModelOptions } from '../../settings/ModelOptions.tsx';
import { useModelChoice } from '../../settings/useModelChoice.ts';
import { useSettings, useUpdateSettings } from '../../settings/useSettings.ts';
import { Choices } from './Choices.tsx';
import { NumberField } from './NumberField.tsx';
import styles from './Settings.module.css';

const BILLING = [
  { value: 'plan', label: 'Claude plan' },
  { value: 'api_key', label: 'API key' },
] as const;

/** The model and effort, from the models the AI lists (the chat bar has the same two). */
function ModelPicker(): JSX.Element {
  const choice = useModelChoice();
  const modelId = useId();
  const effortId = useId();
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={modelId}>Model</label>
        <select
          id={modelId}
          value={choice.model}
          disabled={!choice.ready}
          onChange={(event) => choice.pickModel(event.target.value)}
        >
          <ModelOptions models={choice.models} />
        </select>
        {choice.listProblem && <p className={styles.hint}>{choice.listProblem}</p>}
      </div>
      {choice.showEffort && (
        <div className={styles.field}>
          <label htmlFor={effortId}>Effort</label>
          <select
            id={effortId}
            value={choice.effort}
            disabled={!choice.ready}
            onChange={(event) => choice.pickEffort(event.target.value)}
          >
            <EffortOptions efforts={choice.efforts} />
          </select>
        </div>
      )}
      {choice.saveError && <Problem>Couldn't save that change. {choice.saveError.message}</Problem>}
    </>
  );
}

/**
 * Which AI answers (any .env sets up; each other one says what it needs), its model and effort,
 * the most tool rounds per question, and, for Claude, how the chat is billed (the plan through
 * Claude Code, or the API key from .env) and, with an API key, a spending cap per question.
 */
export function Ai(): JSX.Element {
  const id = useId();
  const settings = useSettings();
  const update = useUpdateSettings();
  const about = useQuery(aboutQuery);
  const providers = useQuery(chatProvidersQuery);
  const s = settings.data;
  const chosen = providers.data?.find((provider) => provider.id === s?.provider);
  // Until the AIs are listed (or if they can't be), Claude is the one with billing.
  const choosesBilling = chosen ? chosen.choosesBilling : s?.provider === 'claude';
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>AI</h3>
      {s && (
        <>
          {providers.data && (
            <Choices
              legend="Provider"
              value={s.provider}
              options={providers.data.map((provider) => ({
                value: provider.id,
                label: provider.name,
                disabled: !provider.configured,
                hint: provider.setup ? `${provider.name}: ${provider.setup}` : undefined,
              }))}
              onChange={(provider) => update.mutate({ provider })}
            />
          )}
          {providers.isError && <Problem>Couldn't list the AIs. {providers.error.message}</Problem>}
          {choosesBilling && (
            <Choices
              legend="Billing"
              value={s.billing}
              options={BILLING}
              onChange={(billing) => update.mutate({ billing })}
            >
              <p className={styles.hint}>
                {s.billing === 'plan'
                  ? "Uses your Claude plan's usage, through Claude Code signed in on this computer (run claude, then /login)."
                  : 'Pays per token with ANTHROPIC_API_KEY from .env.'}
              </p>
              {s.billing === 'api_key' && about.data?.env.ANTHROPIC_API_KEY === 'not set' && (
                <Problem>
                  ANTHROPIC_API_KEY isn't set in .env. Add it and restart Wise Old Model.
                </Problem>
              )}
            </Choices>
          )}
          <ModelPicker />
          <NumberField
            label="Most tool rounds per question"
            value={s.maxTurns}
            min={1}
            max={100}
            whole
            invalid="Use 1 to 100."
            onSave={(value) => value !== null && update.mutate({ maxTurns: value })}
          />
          {choosesBilling && s.billing === 'api_key' && (
            <NumberField
              label="Spending cap per question (US$)"
              value={s.budgetUsd}
              min={0.01}
              optional
              invalid="Use an amount of at least $0.01, or leave it empty for no cap."
              onSave={(value) => update.mutate({ budgetUsd: value })}
            />
          )}
        </>
      )}
      {update.isError && <Problem>Couldn't save that change. {update.error.message}</Problem>}
    </section>
  );
}
