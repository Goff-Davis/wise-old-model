import { type ChatModel, effortLabel } from '@wom/shared';
import type { JSX } from 'react';

/** A model select's options, each model's description as its tooltip. */
export function ModelOptions(props: { models: ChatModel[] }): JSX.Element {
  return (
    <>
      {props.models.map((model) => (
        <option key={model.id} value={model.id} title={model.description || undefined}>
          {model.label}
        </option>
      ))}
    </>
  );
}

/** An effort select's options. */
export function EffortOptions(props: { efforts: string[] }): JSX.Element {
  return (
    <>
      {props.efforts.map((level) => (
        <option key={level} value={level}>
          {effortLabel(level)}
        </option>
      ))}
    </>
  );
}
