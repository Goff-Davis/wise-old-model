import { useQuery } from '@tanstack/react-query';
import { type ChatModel, HOUR_MS } from '@wom/shared';
import { useState } from 'react';
import { chatModelsQuery } from '../api/chats.ts';
import { useSettings, useUpdateSettings } from './useSettings.ts';

type Picked = { model?: string; effort?: string };

/** Each level once, in the order the models list them (least first). */
function levelsOf(models: ChatModel[]): string[] {
  return [...new Set(models.flatMap((model) => model.efforts))];
}

/**
 * The level of `levels` nearest `effort` in `order` (the lower of two as near), or `effort`
 * itself when it's one of them.
 */
export function nearestEffort(effort: string, levels: string[], order: string[]): string {
  if (levels.includes(effort)) return effort;
  const at = order.indexOf(effort);
  const distance = (level: string) => Math.abs(order.indexOf(level) - at);
  return levels.reduce((best, level) => (distance(level) < distance(best) ? level : best));
}

/**
 * The model and effort the chat answers with, as the chat bar and Settings → AI pick them: the
 * AI settings, picked from the models the provider lists (Claude Code's own, so they follow its
 * releases), each with the effort levels it takes. A pick is saved at once, shown meanwhile, and
 * back to what's saved if it isn't. The saved model is found by its id or by the model an alias
 * stands for; one the list hasn't (or every model, when it can't be listed) is kept as a choice
 * of its own. A model with no effort setting has no effort to pick (`showEffort`), and switching
 * to one without the effort set takes the nearest it has.
 */
export function useModelChoice() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const saved = settings.data;
  // Each billing has its own list, asked for once the settings say which.
  const listed = useQuery({
    ...chatModelsQuery(saved?.billing ?? 'plan'),
    enabled: saved !== undefined,
    staleTime: HOUR_MS,
  });
  // What was picked, until its save settles (a mutation is pending only a tick later).
  const [picked, setPicked] = useState<Picked | null>(null);
  const pick = (change: Picked) => {
    setPicked(change);
    update.mutate(change, { onSettled: () => setPicked(null) });
  };
  const modelId = picked?.model ?? saved?.model ?? '';
  const effort = picked?.effort ?? saved?.effort ?? '';
  const listedModels = listed.data?.models ?? [];
  const current =
    listedModels.find((model) => model.id === modelId) ??
    listedModels.find((model) => model.resolvedId === modelId);
  const models: ChatModel[] =
    current || !modelId
      ? listedModels
      : [
          ...listedModels,
          { id: modelId, resolvedId: null, label: modelId, description: '', efforts: [] },
        ];
  const order = levelsOf(listedModels);
  // A model not in the list could take any level the others do.
  const levels = current ? current.efforts : order;
  return {
    /** False until the settings have loaded. */
    ready: saved !== undefined,
    models,
    model: current?.id ?? modelId,
    pickModel(id: string) {
      const next = models.find((model) => model.id === id);
      const nearest =
        next && next.efforts.length > 0 ? nearestEffort(effort, next.efforts, order) : effort;
      pick(nearest === effort ? { model: id } : { model: id, effort: nearest });
    },
    showEffort: !current || current.efforts.length > 0,
    efforts: levels.includes(effort) || !effort ? levels : [...levels, effort],
    effort,
    pickEffort: (level: string) => pick({ effort: level }),
    /** Why the models couldn't be listed, when they couldn't. */
    listProblem: listed.data?.error ? `Couldn't list the models: ${listed.data.error}` : null,
    saveError: update.isError ? update.error : null,
  };
}
