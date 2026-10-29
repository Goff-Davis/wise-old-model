import { z } from 'zod';
import { createItemIndex } from '../../items/itemIndex.ts';
import { findName } from '../../items/itemNames.ts';
import type { AccountDeps } from '../../services/accounts.ts';
import { getItemInfo } from '../../services/itemInfo.ts';
import { orSourceFailure } from '../../sources/answers.ts';
import { getLatestPrices, getMapping, latestTrade } from '../../sources/prices.ts';
import { getSections, getSectionText, pageTitle, searchWiki, wikiUrl } from '../../sources/wiki.ts';
import type { ToolDef } from '../provider.ts';
import { defineTool, type Stale, toolWiki } from './define.ts';

const ItemNameSchema = z.string().trim().min(1).max(100);

/** A section given by its index ('1') rather than its name. */
const SECTION_INDEX = /^(T-)?\d+$/;

/** The game knowledge tools: the OSRS Wiki and its prices, every page read noted as a source. */
export function knowledgeTools(deps: AccountDeps): ToolDef[] {
  return [
    defineTool({
      name: 'search_wiki',
      description:
        "The OSRS Wiki's top five pages for a search, with a snippet of each. Use it to find a page's exact title for get_wiki_page.",
      input: { query: z.string().trim().min(1).max(100) },
      label: ({ query }) => `Searching the wiki for ${query}…`,
      run: async ({ query }, ctx) => {
        const stale: Stale[] = [];
        const results = await searchWiki(toolWiki(deps, ctx, stale), query);
        return { results, stale };
      },
    }),

    defineTool({
      name: 'get_wiki_page',
      description:
        "An OSRS Wiki page: without a section, its list of sections (index and name); with a section (its index, or its name), that section as plain text (up to 4,000 characters), with the page's URL to cite.",
      input: {
        title: z.string().trim().min(1).max(200).describe("The page's title."),
        section: z.string().trim().max(200).optional().describe("A section's index ('2') or name."),
      },
      label: ({ title }) => `Reading wiki: ${title}…`,
      run: async ({ title, section }, ctx) => {
        const stale: Stale[] = [];
        const wiki = toolWiki(deps, ctx, stale);
        const page = pageTitle(title);
        const source = { title: page, url: wikiUrl(page) };
        if (!section) {
          const sections = await getSections(wiki, page);
          ctx.addSource(source);
          return { ...source, sections, stale };
        }
        let index = section;
        if (!SECTION_INDEX.test(section)) {
          const sections = await getSections(wiki, page);
          const line = findName(
            sections.map((one) => one.line),
            section,
          );
          const found = sections.find((one) => one.line === line);
          if (!found) {
            throw new Error(
              `${page} has no section named "${section}". Its sections: ${sections.map((one) => one.line).join(', ')}.`,
            );
          }
          index = found.index;
        }
        const text = await getSectionText(wiki, page, index);
        // The page a redirect led to, as the wiki names it.
        ctx.addSource({ title: text.title, url: wikiUrl(text.title) });
        return { ...text, stale };
      },
    }),

    defineTool({
      name: 'get_item_info',
      description:
        "Items' stats (equipment bonuses, slot, attack speed), Grand Exchange price and when it traded, buy limit, members flag and likeliest drop sources, from the wiki. Takes items' exact names (case aside); get_prices or search_wiki find a name.",
      input: { items: z.array(ItemNameSchema).min(1).max(5) },
      label: ({ items }) => `Looking up ${items.join(', ')}…`,
      run: async ({ items }, ctx) => {
        const stale: Stale[] = [];
        const infos = await getItemInfo(toolWiki(deps, ctx, stale), items);
        for (const info of infos) {
          if (info.found) ctx.addSource({ title: info.name, url: wikiUrl(info.name) });
        }
        return {
          items: infos.map(({ errors, stats, ...info }) => ({
            ...info,
            stats:
              stats && Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== 0)),
            ...(errors.length > 0 ? { errors } : {}),
          })),
          stale,
        };
      },
    }),

    defineTool({
      name: 'get_prices',
      description:
        'Current Grand Exchange prices for items, matched loosely by name ("dragon scim" finds Dragon scimitar): the latest instant-buy price (else instant-sell), when that trade was, and the buy limit.',
      input: { items: z.array(ItemNameSchema).min(1).max(20) },
      label: ({ items }) => `Checking prices for ${items.join(', ')}…`,
      run: async ({ items }, ctx) => {
        const stale: Stale[] = [];
        const wiki = toolWiki(deps, ctx, stale);
        const mapping = await getMapping(wiki);
        const latest = await orSourceFailure(getLatestPrices(wiki), null);
        if (latest.error) stale.push({ kind: 'prices', error: latest.error });
        const index = createItemIndex(mapping);
        const byId = new Map(mapping.map((item) => [item.id, item]));
        return {
          items: items.map((asked) => {
            const [best] = index.find(asked, 1);
            const item = best && byId.get(best.id);
            if (!item) return { asked, found: false };
            const trade = latestTrade(latest.value?.get(item.id));
            return {
              asked,
              name: item.name,
              price: trade?.price ?? null,
              tradedAt: trade?.at ?? null,
              limit: item.limit ?? null,
            };
          }),
          stale,
        };
      },
    }),
  ];
}
