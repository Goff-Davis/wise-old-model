import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { THEME_HINT_KEY, useApplySettings } from '../../settings/useSettings.ts';
import { browserZone, fakeSettingsApi, testQueryClient } from '../../test/fakeApi.ts';
import { Settings } from './Settings.tsx';

/** The settings page as the app mounts it, with the settings applied to the document. */
function Mounted() {
  useApplySettings();
  return <Settings />;
}

function renderSettings() {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <Mounted />
    </QueryClientProvider>,
  );
}

describe('Settings → Display', () => {
  it('switches the theme, applies it to the page and remembers it for the next load', async () => {
    const patches = fakeSettingsApi({ theme: 'dark' });
    renderSettings();
    const display = await screen.findByRole('region', { name: 'Display' });
    expect(within(display).getByRole('radio', { name: 'Dark' })).toHaveProperty('checked', true);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    fireEvent.click(within(display).getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(patches).toEqual([{ theme: 'light' }]);
    expect(within(display).getByRole('radio', { name: 'Light' })).toHaveProperty('checked', true);
    expect(localStorage.getItem(THEME_HINT_KEY)).toBe('light');
  });

  it('offers Automatic (showing the detected zone), UTC and every zone, and saves a pick', async () => {
    const patches = fakeSettingsApi({});
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options[0]).toBe('auto');
    expect(within(select).getByRole('option', { name: `Automatic (${browserZone})` })).toBeTruthy();
    expect(options).toContain('UTC');
    expect(options).toContain('Asia/Tokyo');
    expect(options.length).toBe(new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]).size + 1);

    fireEvent.change(select, { target: { value: 'Asia/Tokyo' } });
    await waitFor(() => expect(patches).toContainEqual({ timeZone: 'Asia/Tokyo' }));
  });

  it("reports the browser's time zone when it differs from the saved one, and only then", async () => {
    const otherZone = browserZone === 'Pacific/Auckland' ? 'Europe/London' : 'Pacific/Auckland';
    const patches = fakeSettingsApi({ detectedTimeZone: otherZone });
    renderSettings();
    await waitFor(() => expect(patches).toEqual([{ detectedTimeZone: browserZone }]));
    cleanup();

    const none = fakeSettingsApi({ detectedTimeZone: browserZone, theme: 'light' });
    renderSettings();
    await screen.findByRole('region', { name: 'Display' });
    // The theme effect ran, so the zone effect beside it ran too.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(none).toEqual([]);
  });

  it('lists UTC once, also in browsers whose own list of zones has it (Firefox, Safari)', async () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
      'America/Chicago',
      'UTC',
      'Europe/London',
    ]);
    const log = vi.spyOn(console, 'error');
    fakeSettingsApi({});
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).toEqual(['auto', 'UTC', 'America/Chicago', 'Europe/London']);
    expect(log).not.toHaveBeenCalled();
  });

  it("still works when the saved zone is one this browser doesn't know", async () => {
    fakeSettingsApi({ theme: 'light', timeZone: 'Mars/Olympus_Mons' });
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    expect(select).toHaveProperty('value', 'Mars/Olympus_Mons');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it("shows the server's reason when a change can't be saved", async () => {
    fakeSettingsApi({ theme: 'dark' }, { refuse: 'theme: Invalid option' });
    renderSettings();
    const display = await screen.findByRole('region', { name: 'Display' });
    fireEvent.click(within(display).getByRole('radio', { name: 'Light' }));
    expect((await within(display).findByRole('alert')).textContent).toContain(
      'theme: Invalid option',
    );
  });
});
