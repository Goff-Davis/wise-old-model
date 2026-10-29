import { act, waitFor, within } from '@testing-library/react';
import type { FileCheck, Settings } from '@wom/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LUMBY_PETE,
  testBankView,
  testGains,
  testGoalsView,
  testOverview,
} from '../test/fakeApi.ts';
import { renderApp } from '../test/renderApp.tsx';

const nothing: FileCheck = { changed: [], missing: [], errors: [], goalsCompleted: 0 };

/**
 * Lumby Pete's overview with these settings, on a fake clock; the file check answers
 * `answers` in turn (the last one again after that). `checks` and `overviews` count requests.
 */
function open(settings: Partial<Settings>, answers: FileCheck[] = [nothing]) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let checks = 0;
  let overviews = 0;
  const { page } = renderApp('/1/overview', {
    settings,
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/overview': () => {
        overviews += 1;
        return testOverview();
      },
      'POST /api/accounts/1/files/check': () => answers[Math.min(checks++, answers.length - 1)],
    },
  });
  return { page, checks: () => checks, overviews: () => overviews };
}

const seconds = (count: number) => act(() => vi.advanceTimersByTimeAsync(count * 1000));

describe('useFileCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the account's files at once, then every pollSeconds, in Automatic mode", async () => {
    const { page, checks } = open({ runeliteMode: 'automatic', pollSeconds: 3 });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    await waitFor(() => expect(checks()).toBe(1));
    await seconds(3);
    expect(checks()).toBe(2);
    await seconds(3);
    expect(checks()).toBe(3);
  });

  it("reloads the account's data when a file changed, and only then", async () => {
    const { page, checks, overviews } = open({ runeliteMode: 'automatic', pollSeconds: 3 }, [
      nothing,
      { changed: ['ce_quests'], missing: [], errors: [], goalsCompleted: 0 },
      nothing,
    ]);
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    await waitFor(() => expect(checks()).toBe(1));
    expect(overviews()).toBe(1);
    await seconds(3);
    await waitFor(() => expect(overviews()).toBe(2));
    await seconds(3);
    expect(checks()).toBe(3);
    expect(overviews()).toBe(2);
  });

  it('reloads only the pages that read a changed file', async () => {
    const { page, checks, overviews } = open({ runeliteMode: 'automatic', pollSeconds: 3 }, [
      nothing,
      // The Overview reads neither character.json nor the inventory.
      { changed: ['ce_character'], missing: [], errors: [], goalsCompleted: 0 },
      { changed: ['ce_inventory'], missing: [], errors: [], goalsCompleted: 0 },
      { changed: ['ce_equipment'], missing: [], errors: [], goalsCompleted: 0 },
    ]);
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    await waitFor(() => expect(checks()).toBe(1));
    await seconds(3);
    await seconds(3);
    expect(checks()).toBe(3);
    expect(overviews()).toBe(1);
    await seconds(3);
    await waitFor(() => expect(overviews()).toBe(2));
  });

  it('reloads the Bank and gear page when the inventory changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let banks = 0;
    let checks = 0;
    const answers: FileCheck[] = [
      nothing,
      { changed: ['ce_inventory'], missing: [], errors: [], goalsCompleted: 0 },
    ];
    const { page } = renderApp('/1/bank', {
      settings: { runeliteMode: 'automatic', pollSeconds: 3 },
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/bank': () => {
          banks += 1;
          return testBankView();
        },
        'POST /api/accounts/1/files/check': () => answers[Math.min(checks++, answers.length - 1)],
      },
    });
    await within(page).findByRole('heading', { name: 'Bank and gear' });
    await waitFor(() => expect(checks).toBe(1));
    expect(banks).toBe(1);
    await seconds(3);
    await waitFor(() => expect(banks).toBe(2));
  });

  it('reloads the Goals page when the character file or a bank file changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let goals = 0;
    let checks = 0;
    const answers: FileCheck[] = [
      nothing,
      { changed: ['ce_character'], missing: [], errors: [], goalsCompleted: 0 },
      { changed: ['ce_bank'], missing: [], errors: [], goalsCompleted: 0 },
    ];
    const { page } = renderApp('/1/goals', {
      settings: { runeliteMode: 'automatic', pollSeconds: 3 },
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/goals': () => {
          goals += 1;
          return testGoalsView();
        },
        'POST /api/accounts/1/files/check': () => answers[Math.min(checks++, answers.length - 1)],
      },
    });
    await within(page).findByRole('heading', { name: 'Goals' });
    await waitFor(() => expect(checks).toBe(1));
    expect(goals).toBe(1);
    await seconds(3);
    await waitFor(() => expect(goals).toBe(2));
    // And when what's owned changed.
    await seconds(3);
    await waitFor(() => expect(goals).toBe(3));
  });

  it('reloads This week when the files it read completed a goal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let weeks = 0;
    let checks = 0;
    const answers: FileCheck[] = [
      nothing,
      // The character file isn't one This week reads, but a goal it completed shows there.
      { changed: ['ce_character'], missing: [], errors: [], goalsCompleted: 0 },
      { changed: ['ce_character'], missing: [], errors: [], goalsCompleted: 1 },
    ];
    const { page } = renderApp('/1/this-week', {
      settings: { runeliteMode: 'automatic', pollSeconds: 3 },
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/gains': () => {
          weeks += 1;
          return testGains();
        },
        'POST /api/accounts/1/files/check': () => answers[Math.min(checks++, answers.length - 1)],
      },
    });
    await within(page).findByRole('heading', { name: 'This week' });
    await waitFor(() => expect(checks).toBe(1));
    await seconds(3);
    await waitFor(() => expect(checks).toBe(2));
    expect(weeks).toBe(1);
    await seconds(3);
    await waitFor(() => expect(weeks).toBe(2));
  });

  it("doesn't check while the page is hidden, and checks as soon as it's shown again", async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    const { page, checks } = open({ runeliteMode: 'automatic', pollSeconds: 3 });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    await waitFor(() => expect(checks()).toBe(1));
    visibility.mockReturnValue('hidden');
    await seconds(9);
    expect(checks()).toBe(1);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(checks()).toBe(2));
  });

  it('never checks by itself in Manual mode, where Refresh reads the files', async () => {
    const { page, checks } = open({ runeliteMode: 'manual', pollSeconds: 3 });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    await seconds(10);
    expect(checks()).toBe(0);
  });
});
