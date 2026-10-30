import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { testDb } from '../../test/helpers.ts';
import { createFreshnessMemory } from '../services/freshness.ts';
import type { ToolContext, ToolDef } from './provider.ts';
import { DECLINED, mayRun, NOT_AVAILABLE, runTool, toolSchemas } from './toolCalls.ts';
import { buildTools } from './tools/index.ts';

const ctx: ToolContext = { accountId: 7, timeZone: 'UTC', now: new Date(), addSource: () => {} };

const readTool: ToolDef = {
  name: 'get_quests',
  description: "The account's quests.",
  input: { status: z.enum(['finished', 'not_started']).optional() },
  readOnly: true,
  label: () => 'Checking your quests…',
  run: async (args, { accountId }) => ({ asked: args.status ?? null, accountId }),
};

const writeTool: ToolDef = {
  name: 'add_goal',
  description: 'Adds a goal.',
  input: { title: z.string(), position: z.number().default(0) },
  readOnly: false,
  label: () => 'Adding goal…',
  summary: async (args, { accountId }) => {
    if (args.title === '') throw new Error('A goal needs a title.');
    return `Add goal: ${String(args.title)} (custom, account ${accountId})`;
  },
  run: async () => ({ added: true }),
};

describe('runTool', () => {
  it("gives a tool's result as JSON, and its failure's message as an error", async () => {
    expect(await runTool(readTool, { status: 'finished' }, ctx)).toEqual({
      text: '{"asked":"finished","accountId":7}',
      isError: false,
    });
    const failing = {
      ...readTool,
      run: async () => {
        throw new Error('Wise Old Man: server error (500)');
      },
    };
    expect(await runTool(failing, {}, ctx)).toEqual({
      text: 'Wise Old Man: server error (500)',
      isError: true,
    });
  });
});

describe('mayRun', () => {
  it('runs a lookup unasked, asks about a change by its summary, and refuses the rest', async () => {
    const answers = [false, true];
    const requestApproval = vi.fn(async () => answers.shift() ?? false);
    expect(await mayRun(readTool, {}, ctx, requestApproval)).toEqual({
      allowed: true,
      def: readTool,
    });
    const input = { title: 'Clean the bank' };
    expect(await mayRun(writeTool, input, ctx, requestApproval)).toEqual({
      allowed: false,
      message: DECLINED,
    });
    expect(await mayRun(writeTool, input, ctx, requestApproval)).toEqual({
      allowed: true,
      def: writeTool,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'add_goal',
      summary: 'Add goal: Clean the bank (custom, account 7)',
    });
    // A change that can't be made is refused with why, without asking.
    expect(await mayRun(writeTool, { title: '' }, ctx, requestApproval)).toEqual({
      allowed: false,
      message: 'A goal needs a title.',
    });
    // A tool that isn't ours, or a change with no summary to ask by, isn't run.
    const { summary: _none, ...unsummarized } = writeTool;
    for (const def of [undefined, unsummarized]) {
      expect(await mayRun(def, {}, ctx, requestApproval)).toEqual({
        allowed: false,
        message: NOT_AVAILABLE,
      });
    }
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });
});

describe('toolSchemas', () => {
  it("gives each tool's input as JSON Schema of what the model sends, without $schema", () => {
    expect(toolSchemas([readTool, writeTool])).toEqual([
      {
        name: 'get_quests',
        description: "The account's quests.",
        parameters: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['finished', 'not_started'] } },
        },
      },
      {
        name: 'add_goal',
        description: 'Adds a goal.',
        // A field with a default may be left out.
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' }, position: { type: 'number', default: 0 } },
          required: ['title'],
        },
      },
    ]);
  });

  it("gives every one of the chat's tools as plain JSON Schema", async () => {
    const deps = {
      db: await testDb(),
      req: {} as never,
      memory: createFreshnessMemory(),
      runeliteDir: '',
    };
    const schemas = toolSchemas(buildTools(deps));
    expect(schemas).toHaveLength(20);
    for (const schema of schemas) expect(schema.parameters).toMatchObject({ type: 'object' });
    // Nothing that points elsewhere, which not every API follows.
    expect(JSON.stringify(schemas)).not.toMatch(/"\$(?:schema|ref|defs)"/);
  });
});
