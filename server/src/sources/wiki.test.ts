import { DAY_MS } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { type FakeAnswer, fakeRequester, fixture, outage, testDb } from '../../test/helpers.ts';
import { NotFoundError, SourceError } from '../http/requester.ts';
import { readCache } from '../store/cache.ts';
import {
  bucketQuery,
  bucketSelect,
  expandTemplates,
  getPageWikitext,
  getSections,
  getSectionText,
  latestRevisions,
  searchWiki,
  type WikiCtx,
  wikiUrl,
} from './wiki.ts';

const wiki = (name: string) => fixture(`wiki/${name}.json`);
const TRUNCATED = '… (truncated; ask for a narrower section)';

type Call =
  | 'search'
  | 'sections'
  | 'section'
  | 'wikitext'
  | 'revisions'
  | 'bucket'
  | 'expandtemplates';

/** Which API call a request is, by its parameters. */
function callOf(params: URLSearchParams): Call | null {
  if (params.get('list') === 'search') return 'search';
  if (params.get('action') === 'parse') {
    if (params.has('section')) return 'section';
    return params.get('prop')?.includes('wikitext') ? 'wikitext' : 'sections';
  }
  if (params.get('prop') === 'revisions') return 'revisions';
  const action = params.get('action');
  return action === 'bucket' || action === 'expandtemplates' ? action : null;
}

type Answer = FakeAnswer | ((params: URLSearchParams) => FakeAnswer);

/**
 * A wiki context over a fresh database whose clock `later` moves on; the wiki answers by call.
 * `reads` lists what every cached answer used said about its age and errors.
 */
async function setup(answers: Partial<Record<Call, Answer>>) {
  const db = await testDb();
  let now = new Date('2026-10-28T12:00:00.000Z');
  const fake = fakeRequester(({ url }) => {
    const params = new URL(url).searchParams;
    const call = callOf(params);
    const answer = call ? answers[call] : undefined;
    if (answer === undefined) return new Error(`No answer for ${url}`);
    return typeof answer === 'function' ? answer(params) : answer;
  });
  const reads: { kind: string; fetchedAt: string; error: string | null }[] = [];
  const ctx: WikiCtx = { req: fake.req, db, now: () => now, noteRead: (read) => reads.push(read) };
  const calls = () => fake.urls.map((url) => callOf(new URL(url).searchParams));
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { ctx, calls, later, reads, ...fake };
}

/** A revisions answer giving each title this revision id. */
const revisions = (revid: number, titles = ['Dragon Slayer II']) =>
  JSON.stringify({ query: { pages: titles.map((title) => ({ title, revisions: [{ revid }] })) } });

/** A section answer for this page with this HTML. */
const sectionHtml = (html: string, title = 'Some Page') =>
  JSON.stringify({ parse: { title, pageid: 1, revid: 7, text: html } });

describe('wikiUrl', () => {
  it("makes a page's URL, at a section when given", () => {
    expect(wikiUrl('Dragon Slayer II')).toBe('https://oldschool.runescape.wiki/w/Dragon_Slayer_II');
    expect(wikiUrl('Dragon Slayer II', 'Starting off')).toBe(
      'https://oldschool.runescape.wiki/w/Dragon_Slayer_II#Starting_off',
    );
    expect(wikiUrl('Lumbridge & Draynor Diary')).toBe(
      'https://oldschool.runescape.wiki/w/Lumbridge_%26_Draynor_Diary',
    );
    expect(wikiUrl('Money making guide/Killing Vorkath')).toBe(
      'https://oldschool.runescape.wiki/w/Money_making_guide/Killing_Vorkath',
    );
  });
});

describe('getPageWikitext', () => {
  it("gives a page's wikitext, kept until the page's revision changes", async () => {
    const page = (wikitext: string) =>
      JSON.stringify({ parse: { title: 'Ardougne Diary', revid: 7, wikitext } });
    const { ctx, calls, later } = await setup({
      wikitext: page('{| data-diary-tier="Easy"'),
      revisions: revisions(7, ['Ardougne Diary']),
    });
    expect(await getPageWikitext(ctx, 'Ardougne_Diary')).toBe('{| data-diary-tier="Easy"');
    expect(await getPageWikitext(ctx, 'Ardougne Diary')).toBe('{| data-diary-tier="Easy"');
    // A day on, the revision is checked and, unchanged, nothing is downloaded again.
    later(DAY_MS);
    await getPageWikitext(ctx, 'Ardougne Diary');
    expect(calls()).toEqual(['wikitext', 'revisions']);
  });
});

describe('searchWiki', () => {
  it('gives the top five pages with plain snippets and their URLs', async () => {
    const { ctx } = await setup({ search: wiki('search-dragon-slayer-ii') });
    const results = await searchWiki(ctx, 'Dragon Slayer II');
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      title: 'Dragon Slayer II',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II',
    });
    expect(results[0]?.snippet).toMatch(/^Dragon Slayer II: The Legacy of Elvarg is a quest/);
    expect(results.every((result) => !result.snippet.includes('<'))).toBe(true);
  });

  it('says how old a search answer is, and why when the wiki is down', async () => {
    const answers: Partial<Record<Call, Answer>> = { search: wiki('search-dragon-slayer-ii') };
    const { ctx, later, reads } = await setup(answers);
    await searchWiki(ctx, 'Dragon Slayer II');
    answers.search = outage('OSRS Wiki');
    later(2 * DAY_MS);
    await searchWiki(ctx, 'Dragon Slayer II');
    expect(reads).toEqual([
      { kind: 'wiki_search', fetchedAt: '2026-10-28T12:00:00.000Z', error: null },
      {
        kind: 'wiki_search',
        fetchedAt: '2026-10-28T12:00:00.000Z',
        error: 'OSRS Wiki: server error (500)',
      },
    ]);
  });

  it('asks the wiki once a day for the same search', async () => {
    const { ctx, calls, later } = await setup({ search: wiki('search-dragon-slayer-ii') });
    await searchWiki(ctx, 'Dragon Slayer II');
    later(DAY_MS - 1);
    await searchWiki(ctx, 'dragon slayer ii ');
    expect(calls()).toEqual(['search']);
    later(1);
    await searchWiki(ctx, 'Dragon Slayer II');
    expect(calls()).toEqual(['search', 'search']);
  });
});

describe('getSections and getSectionText', () => {
  it("lists a page's sections", async () => {
    const { ctx } = await setup({ sections: wiki('sections-dragon-slayer-ii') });
    const sections = await getSections(ctx, 'Dragon Slayer II');
    expect(sections.slice(0, 2)).toEqual([
      { index: '1', line: 'Details' },
      { index: '2', line: 'Starting off' },
    ]);
  });

  it('gives a section as plain text of at most 4,000 characters, with its URL', async () => {
    const { ctx } = await setup({ section: wiki('section-1-dragon-slayer-ii') });
    const section = await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(section).toMatchObject({
      title: 'Dragon Slayer II',
      section: 'Details',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II#Details',
    });
    expect(section.text).not.toContain('<');
    expect(section.text.length).toBeLessThanOrEqual(4_000 + TRUNCATED.length);
    expect(section.text).toMatch(/^Details\nStart point \| /);
  });

  it('says when it cut a section short', async () => {
    const long = `<p>${'Lorem ipsum dolor sit amet. '.repeat(200)}</p>`;
    const { ctx } = await setup({ section: sectionHtml(long) });
    const { text } = await getSectionText(ctx, 'Some Page', '2');
    expect(text.endsWith(TRUNCATED)).toBe(true);
    expect(text.length).toBe(4_000 + TRUNCATED.length);
  });

  it('keeps headings, paragraphs, list items and table rows, and drops references, navboxes, edit and map links', async () => {
    const { ctx } = await setup({
      section: sectionHtml(
        `<div class="mw-parser-output"><div class="mw-heading mw-heading2"><h2 id="Getting_there">Getting there</h2><span class="mw-editsection">[<a href="/edit">edit</a>]</span></div>
        <p>Take the <a href="/w/Fairy_ring">fairy ring</a> to <b>AKS</b>.<sup class="reference"><a href="#cite">[1]</a></sup></p>
        <ul><li>Bring a <a href="/w/Rope">rope</a></li><li>Bring food<br>and potions<ul><li>Sharks</li></ul></li></ul>
        <table><tbody><tr><th>Item</th><th>Price</th></tr><tr><td>Rope</td><td>&lt; 100 coins</td></tr>
        <tr><th>Start point</th><td>Talk to <a href="/w/Alec">Alec</a>. <a class="mw-kartographer-maplink"><b>Show on map</b></a></td></tr>
        <tr><th>Requirements</th><td><ul><li>75 <a href="/w/Magic">Magic</a> <sup class="nowrap"><span>[</span><span>not boostable</span><span>]</span></sup></li><li>Quests:<ul><li>Legends' Quest<ul><li>Family Crest</li></ul></li><li>Dream Mentor</li></ul></li></ul></td></tr></tbody></table>
        <table class="navbox"><tbody><tr><td>Every quest</td></tr></tbody></table></div>`,
      ),
    });
    const { text, section, url } = await getSectionText(ctx, 'Some Page', '3');
    expect(text).toBe(
      [
        'Getting there',
        'Take the fairy ring to AKS.',
        '- Bring a rope',
        '- Bring food and potions',
        '  - Sharks',
        'Item | Price',
        'Rope | < 100 coins',
        'Start point | Talk to Alec.',
        "Requirements | 75 Magic [not boostable]; Quests: (Legends' Quest (Family Crest); Dream Mentor)",
      ].join('\n'),
    );
    expect(section).toBe('Getting there');
    expect(url).toBe('https://oldschool.runescape.wiki/w/Some_Page#Getting_there');
  });

  it("calls the part before a page's first heading its introduction", async () => {
    const { ctx } = await setup({ section: sectionHtml('<p>Vorkath is a dragon.</p>', 'Vorkath') });
    expect(await getSectionText(ctx, 'Vorkath', '0')).toMatchObject({
      section: 'Introduction',
      text: 'Vorkath is a dragon.',
      url: 'https://oldschool.runescape.wiki/w/Vorkath',
    });
  });

  it("leaves out the wiki's table of contents, asking it not to send one", async () => {
    const { ctx, urls } = await setup({ section: wiki('section-7-dragon-slayer-ii') });
    const section = await getSectionText(ctx, 'Dragon Slayer II', '7');
    expect(section).toMatchObject({
      section: 'The Dragon key',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II#The_Dragon_key',
    });
    expect(section.text).toMatch(/^The Dragon key\n/);
    expect(section.text).not.toContain('Contents');
    expect(new URL(urls[0] ?? '').searchParams.get('disabletoc')).toBe('1');
  });

  it("refuses an index that isn't a section's, asking nothing", async () => {
    const { ctx, urls } = await setup({ section: wiki('section-1-dragon-slayer-ii') });
    for (const index of ['sections', 'a:b', '1 ', '']) {
      await expect(getSectionText(ctx, 'Dragon Slayer II', index), index).rejects.toThrow(
        RangeError,
      );
    }
    expect(urls).toEqual([]);
    // Sections taken in from templates have indexes like T-1.
    await getSectionText(ctx, 'Dragon Slayer II', 'T-1');
    expect(urls).toHaveLength(1);
  });

  it("says plainly when there's no such page", async () => {
    const { ctx } = await setup({ sections: wiki('parse-missing-page') });
    await expect(getSections(ctx, 'No such page here 12345')).rejects.toMatchObject({
      name: 'NotFoundError',
      message: "OSRS Wiki: there's no page called No such page here 12345",
    });
    await expect(getSections(ctx, 'No such page here 12345')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the page cache', () => {
  it("doesn't download a page again within a day, or after when its revision is unchanged", async () => {
    const { ctx, calls, later } = await setup({
      section: wiki('section-1-dragon-slayer-ii'),
      revisions: revisions(15380440),
    });
    const first = await getSectionText(ctx, 'Dragon Slayer II', '1');
    later(DAY_MS - 1);
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(calls()).toEqual(['section']);

    later(DAY_MS + 1);
    expect(await getSectionText(ctx, 'Dragon_Slayer_II', '1')).toEqual(first);
    expect(calls()).toEqual(['section', 'revisions']);
    // Checked just now, so not again for a day.
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(calls()).toEqual(['section', 'revisions']);
  });

  it('downloads a page again once its revision has changed', async () => {
    const { ctx, calls, later } = await setup({
      section: wiki('section-1-dragon-slayer-ii'),
      revisions: revisions(15380441),
    });
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    later(2 * DAY_MS);
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(calls()).toEqual(['section', 'revisions', 'section']);
  });

  it("checks every day-old page's revision in one request", async () => {
    const asked: string[][] = [];
    const { ctx, calls, later } = await setup({
      sections: wiki('sections-dragon-slayer-ii'),
      section: (params) =>
        params.get('page') === 'Vorkath'
          ? sectionHtml('<p>Vorkath is a dragon.</p>', 'Vorkath')
          : wiki('section-1-dragon-slayer-ii'),
      revisions: (params) => {
        const titles = params.get('titles')?.split('|') ?? [];
        asked.push(titles);
        return JSON.stringify({
          query: {
            pages: titles.map((title) => ({
              title,
              revisions: [{ revid: title === 'Vorkath' ? 7 : 15380440 }],
            })),
          },
        });
      },
    });
    await getSections(ctx, 'Dragon Slayer II');
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    await getSectionText(ctx, 'Vorkath', '0');
    later(2 * DAY_MS);
    await getSections(ctx, 'Dragon Slayer II');
    expect(asked).toEqual([['Dragon Slayer II', 'Vorkath']]);
    // Both pages were unchanged, so neither is checked or downloaded again today.
    await getSectionText(ctx, 'Vorkath', '0');
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(calls()).toEqual(['sections', 'section', 'section', 'revisions']);
  });

  it('says how old every page it serves is, and why when it is an old copy', async () => {
    const { ctx, later, reads } = await setup({
      section: wiki('section-1-dragon-slayer-ii'),
      revisions: outage('OSRS Wiki'),
    });
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    later(3 * DAY_MS);
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(reads).toEqual([
      { kind: 'wiki_page', fetchedAt: '2026-10-28T12:00:00.000Z', error: null },
      {
        kind: 'wiki_page',
        fetchedAt: '2026-10-28T12:00:00.000Z',
        error: 'OSRS Wiki: server error (500)',
      },
    ]);
  });

  it('shares a page download, or its revision check, already under way', async () => {
    const { ctx, calls, later } = await setup({
      section: wiki('section-1-dragon-slayer-ii'),
      revisions: revisions(15380440),
    });
    const [first, second] = await Promise.all([
      getSectionText(ctx, 'Dragon Slayer II', '1'),
      getSectionText(ctx, 'Dragon Slayer II', '1'),
    ]);
    expect(second).toEqual(first);
    later(2 * DAY_MS);
    await Promise.all([
      getSectionText(ctx, 'Dragon Slayer II', '1'),
      getSectionText(ctx, 'Dragon Slayer II', '1'),
    ]);
    expect(calls()).toEqual(['section', 'revisions']);
  });

  it('downloads again a page another check found changed, without checking it again', async () => {
    const asked: string[][] = [];
    const { ctx, calls, later } = await setup({
      section: (params) =>
        params.get('page') === 'Vorkath'
          ? sectionHtml('<p>Vorkath is a dragon.</p>', 'Vorkath')
          : wiki('section-1-dragon-slayer-ii'),
      revisions: (params) => {
        const titles = params.get('titles')?.split('|') ?? [];
        asked.push(titles);
        // Vorkath's page has changed since it was saved; the others haven't.
        return JSON.stringify({
          query: {
            pages: titles.map((title) => ({
              title,
              revisions: [{ revid: title === 'Vorkath' ? 8 : 15380440 }],
            })),
          },
        });
      },
    });
    await getSectionText(ctx, 'Vorkath', '0');
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    later(2 * DAY_MS);
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    expect(asked).toEqual([['Dragon Slayer II', 'Vorkath']]);

    // A later check leaves out the page already known to have changed.
    await getSectionText(ctx, 'Dragon Slayer II', '2');
    later(2 * DAY_MS);
    await getSectionText(ctx, 'Dragon Slayer II', '2');
    expect(asked[1]).toEqual(['Dragon Slayer II']);

    // When it's next wanted, it's downloaded straight away, with no check of its own.
    const before = calls().length;
    await getSectionText(ctx, 'Vorkath', '0');
    expect(calls().slice(before)).toEqual(['section']);
  });

  it("keeps a page's HTML, so improvements to the text reach pages already saved", async () => {
    const { ctx } = await setup({ section: wiki('section-1-dragon-slayer-ii') });
    await getSectionText(ctx, 'Dragon Slayer II', '1');
    const saved = await readCache(ctx.db, 'page:Dragon Slayer II:1');
    expect(saved?.data).toContain('<h2 id=\\"Details\\">Details</h2>');
  });

  it('serves the saved page, however old, when the wiki is down, and fails without one', async () => {
    const { ctx, later } = await setup({
      // Section 1 is saved before the wiki goes down; section 2 never is.
      section: (params) =>
        params.get('section') === '1' ? wiki('section-1-dragon-slayer-ii') : outage('OSRS Wiki'),
      revisions: outage('OSRS Wiki'),
    });
    const first = await getSectionText(ctx, 'Dragon Slayer II', '1');
    later(10 * DAY_MS);
    expect(await getSectionText(ctx, 'Dragon Slayer II', '1')).toEqual(first);
    await expect(getSectionText(ctx, 'Dragon Slayer II', '2')).rejects.toBeInstanceOf(SourceError);
  });
});

describe('latestRevisions', () => {
  const DIARIES = [
    'Ardougne Diary',
    'Desert Diary',
    'Falador Diary',
    'Fremennik Diary',
    'Kandarin Diary',
    'Karamja Diary',
    'Kourend & Kebos Diary',
    'Lumbridge & Draynor Diary',
    'Morytania Diary',
    'Varrock Diary',
    'Western Provinces Diary',
    'Wilderness Diary',
  ];

  it("gives each page's current revision id, by the title asked for", async () => {
    const { ctx } = await setup({ revisions: wiki('revisions-diaries') });
    const ids = await latestRevisions(ctx, DIARIES);
    expect(Object.keys(ids).sort()).toEqual([...DIARIES].sort());
    expect(ids['Karamja Diary']).toBe(15384444);
  });

  it('follows the wiki renaming a title, and leaves out pages that are missing', async () => {
    const { ctx } = await setup({
      revisions: JSON.stringify({
        query: {
          normalized: [{ from: 'ardougne_Diary', to: 'Ardougne Diary' }],
          redirects: [{ from: 'DS2', to: 'Dragon Slayer II' }],
          pages: [
            { title: 'Ardougne Diary', revisions: [{ revid: 1 }] },
            { title: 'Dragon Slayer II', revisions: [{ revid: 2 }] },
            { title: 'Nothing Here', missing: true },
          ],
        },
      }),
    });
    expect(await latestRevisions(ctx, ['ardougne_Diary', 'DS2', 'Nothing Here'])).toEqual({
      ardougne_Diary: 1,
      DS2: 2,
    });
  });

  it('asks about at most 50 pages at a time', async () => {
    const titles = Array.from({ length: 120 }, (_, i) => `Page ${i}`);
    const { ctx, urls } = await setup({
      revisions: (params) => revisions(1, params.get('titles')?.split('|')),
    });
    const ids = await latestRevisions(ctx, titles);
    expect(Object.keys(ids)).toHaveLength(120);
    expect(urls.map((url) => new URL(url).searchParams.get('titles')?.split('|').length)).toEqual([
      50, 50, 20,
    ]);
  });
});

describe('bucketQuery and expandTemplates', () => {
  const QUERY =
    "bucket('quest').select('page_name','requirements').where('page_name','Dragon Slayer II').run()";

  it("gives a Bucket query's rows, asking once a day", async () => {
    const { ctx, calls, later } = await setup({ bucket: wiki('quest-dragon-slayer-ii') });
    const rows = await bucketQuery<{ page_name: string; requirements: string }>(ctx, QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.page_name).toBe('Dragon Slayer II');
    expect(rows[0]?.requirements).toContain('data-skill="Magic" data-level="75"');
    later(DAY_MS - 1);
    await bucketQuery(ctx, QUERY);
    expect(calls()).toEqual(['bucket']);
  });

  it('writes a Bucket query, its strings quoted with apostrophes and backslashes escaped', () => {
    expect(
      bucketSelect('dropsline', ['page_name', 'drop_json'], {
        where: ['item_name', "Karil's coif"],
        limit: 5000,
      }),
    ).toBe(
      String.raw`bucket('dropsline').select('page_name','drop_json').where('item_name','Karil\'s coif').limit(5000).run()`,
    );
    expect(bucketSelect('quest', [String.raw`a\b`])).toBe(
      String.raw`bucket('quest').select('a\\b').run()`,
    );
  });

  it('expands templates', async () => {
    const { ctx } = await setup({ expandtemplates: wiki('expandtemplates-ca-elite-points') });
    expect(await expandTemplates(ctx, '{{Globals|ca elite points}}')).toBe('1100');
  });

  it("passes on the wiki's reason when it refuses a query or a page", async () => {
    const { ctx } = await setup({
      bucket: wiki('bucket-unknown'),
      expandtemplates: JSON.stringify({
        error: { code: 'invalidparammix', info: 'The parameters cannot be used together.' },
      }),
    });
    await expect(
      bucketQuery(ctx, "bucket('questt').select('page_name').run()"),
    ).rejects.toMatchObject({
      name: 'SourceError',
      message: 'OSRS Wiki: Bucket questt does not exist.',
    });
    await expect(expandTemplates(ctx, '{{x}}')).rejects.toMatchObject({
      name: 'SourceError',
      message: 'OSRS Wiki: The parameters cannot be used together.',
    });
  });
});
