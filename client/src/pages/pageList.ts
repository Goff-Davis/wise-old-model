/** The pages beside the chat, in menu order. The id is the URL segment: /<accountId>/<id>. */
export const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'this-week', label: 'This week' },
  { id: 'goals', label: 'Goals' },
  { id: 'bank', label: 'Bank and gear' },
  { id: 'collection-log', label: 'Collection log' },
  { id: 'settings', label: 'Settings' },
] as const;

export type PageId = (typeof PAGES)[number]['id'];

/** An account page's URL. */
export function pagePath(accountId: string | number, page: PageId): string {
  return `/${accountId}/${page}`;
}
