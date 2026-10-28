import { afterEach } from 'vitest';

// Only jsdom tests have a page; node-environment tests don't load Testing Library at all.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');

  // jsdom has no matchMedia. This one matches no media query, so the window counts as wide;
  // tests that need another answer stub their own.
  window.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });

  // jsdom has <dialog> and its open attribute (closed dialogs are hidden), but not showModal()
  // or close(); these do what a browser does with them, minus the focus trap.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };

  // Without Vitest globals, Testing Library can't register its own cleanup. The app also
  // leaves its theme on <html> and its theme hint in localStorage.
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });
}
