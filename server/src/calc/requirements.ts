import { type DiaryTierName, squeeze } from '@wom/shared';
import { parse } from 'node-html-parser';
import { SourceError } from '../http/requester.ts';
import {
  bucketQuery,
  bucketSelect,
  getPageWikitext,
  getRenderedPage,
  LINK,
  linkPage,
  linkPages,
  loneLink,
  parsedOnce,
  plainText,
  type WikiCtx,
  wikiUrl,
} from '../sources/wiki.ts';

/** A level needed, and the wiki's note on it ("47 is recommended"), when it has one. */
export type SkillReq = {
  skill: string;
  level: number;
  boostable: boolean;
  toStart: boolean;
  note: string | null;
};

/** A quest needed, the quests it needs, and what else it needs, as plain text (100 Kudos). */
export type QuestNode = { name: string; children: QuestNode[]; other: string[] };

/**
 * A quest's requirements: skills, quest points, the quests it needs (each with the quests that
 * one needs), and, as plain text, everything else (items, kudos, the ability to defeat a
 * monster), which can't be checked.
 */
export type QuestReqs = {
  quest: string;
  skills: SkillReq[];
  questPoints: { need: number; note: string | null } | null;
  quests: QuestNode[];
  other: string[];
  url: string;
};

/** What a quest has to be: finished, started, or partly done (how far, the wiki says in words). */
export type QuestNeed = 'finished' | 'started' | 'partial';

export type DiaryTask = {
  area: string;
  tier: DiaryTierName;
  number: number;
  task: string;
  skills: SkillReq[];
  quests: { name: string; need: QuestNeed }[];
  other: string[];
};

export type QuestState = 'finished' | 'in_progress' | 'not_started' | 'unknown';

/** A quest's state as the account's quests give it (it can't be unknown there). */
export type QuestStatus = Exclude<QuestState, 'unknown'>;

/**
 * Whether an account meets requirements. `met` means everything that could be checked is met;
 * `unchecked` lists what couldn't be (plain-text requirements, a skill or quest the account's
 * data doesn't have).
 */
export type Check = {
  met: boolean;
  skills: (SkillReq & { have: number; met: boolean })[];
  quests: { name: string; need: QuestNeed; state: QuestState; met: boolean }[];
  questPoints: { need: number; have: number; met: boolean; note: string | null } | null;
  unchecked: string[];
  url: string;
};

/**
 * A combat level's name among an account's levels, which are otherwise its skills by the
 * hiscores' names for them (the wiki's names, Runecraft included).
 */
export const COMBAT_LEVEL = 'Combat level';

const SITE = 'OSRS Wiki';

/** The diaries' "Combat" is a combat level. */
const skillName = (name: string) => (name.trim() === 'Combat' ? COMBAT_LEVEL : name.trim());

/** The `{{SCP}}` icons that are no skill: before a quest, or a combat achievement. */
const NOT_A_SKILL = /^(?:quest|combatachievement)$/i;

/** A wiki template written out as text: a level, a fairy ring code, runes; others go. */
function templateText(name: string, args: string[]): string {
  switch (name.trim().toLowerCase()) {
    case 'scp': {
      // The skill, then its level (`79`, or a range such as `29-42`); `link=yes` and such aside.
      const [what = '', level = ''] = args
        .filter((arg) => !arg.includes('='))
        .map((arg) => arg.trim());
      if (/^quest$/i.test(what) && level) return `${level} quest points`;
      if (NOT_A_SKILL.test(what)) return '';
      return level ? `${skillName(what)} ${level}` : skillName(what);
    }
    case 'na':
      return args[0] ?? '';
    case 'fairycode':
      return (args[0] ?? '').toUpperCase();
    case 'runereq':
      return args
        .map((arg) => arg.split('='))
        .map(([rune = '', count = '']) => `${count.trim()} ${rune.trim()}`)
        .join(', ');
    case 'floornumber':
      return `floor ${args[0]?.split('=').at(-1)?.trim() ?? ''}`;
    default:
      // Footnotes ({{efn}}, read apart from the text), {{sic}}, {{Boostable}} and the rest.
      return '';
  }
}

// Bucket's marker where a reference was: '"`UNIQ--ref-00000041-QINU`"', between DEL characters.
const REF_MARKER = /\u007f?'"`UNIQ--[^`]*-QINU`"'\u007f?/g;

/** Wikitext and HTML as plain text: links as their text, templates written out, tags gone. */
function plain(text: string): string {
  let out = text
    .replace(REF_MARKER, '')
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, (_link, target: string) => target.split('#')[0]);
  // Innermost templates first, so a template inside another is written out before it.
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_template, body: string) => {
      const [name, ...args] = body.split('|');
      return templateText(name, args);
    });
  }
  // The HTML's text, list items kept apart and bold and italic marks gone.
  return plainText(out.replace(/<\/li>\s*<li[^>]*>/gi, '; ').replace(/'{2,}/g, '')).replace(
    /\s+([,.;:)])/g,
    '$1',
  );
}

const SKILL_SPAN = /<span[^>]*data-skill="([^"]+)"[^>]*data-level="(\d+)"[^>]*>/g;
/** A level's whole span: its icon, its number and (mostly) its skill's link. */
const SCP_SPAN = /<span class="scp"[^>]*>[\s\S]*?<\/span>/g;
/** The notes after a level ("not boostable", "required to start"), each in a <sup>. */
const NOTES = /<sup[^>]*>[\s\S]*?<\/sup>/g;
/** What may sit between parts of a requirement that's only levels, or only quests. */
const SEPARATORS = /^(?:[\s,.]|\band\b)*$/i;

// Words that make a level's text a way around it or a condition on it, rather than an
// explanation: "or the gas mask", "unless travelling with a charter ship", "bypassable",
// "for any Lovakengj activity", "for Ironman accounts", "(though not necessary)".
const CONDITION =
  /\b(?:or|unless|if|except|either|instead|otherwise|optional|any|some|depending|bypass\w*|alternative\w*|recommended|ironm[ae]n)\b|\bnot (?:necessary|required)\b/i;
// "(47 is recommended)" recommends another level, which is no condition on this one.
const ANOTHER_LEVEL_RECOMMENDED = /\b\d+ (?:is |are )?recommended\b/gi;

/**
 * The note the rest of a line makes on its levels: null when it's only separators, the text when
 * it only explains them (in brackets, or "to …" or "for …", with no condition in it), and
 * undefined when it may say they aren't needed, so the line is kept as text.
 */
function levelNote(text: string): string | null | undefined {
  if (SEPARATORS.test(text)) return null;
  const rest = text.replace(/^(?:[\s,;:\-–—]|\band\b)+/i, '').trim();
  if (CONDITION.test(rest.replace(ANOTHER_LEVEL_RECOMMENDED, ''))) return undefined;
  const bracketed = /^\((.+)\)$/.exec(rest)?.[1].trim();
  if (bracketed) return bracketed;
  return /^(?:to|for)\b/i.test(rest) ? rest : undefined;
}

const questNode = (name: string): QuestNode => ({ name, children: [], other: [] });

/**
 * A quest's requirements from the wiki's Quest bucket: skills from their `data-skill` spans (the
 * `<sup>` after one says when it's "not boostable" or "required to start"), the quest points,
 * the quests under a line about "the following quests" as a tree by their `*` depth, and every
 * other line as plain text. A line with more on it than levels gives them, with that text as
 * their note, when it only explains them ("(47 is recommended)"); when it may offer a way around
 * them or a condition ("or the gas mask"), it's kept as text and its levels aren't checked. In
 * the tree, a line that's more than a link is kept as text with the quest above it (whose need
 * it is), and a quest listed under it goes under that quest too.
 */
export function parseQuestRequirements(quest: string, requirements: string): QuestReqs {
  const skills: SkillReq[] = [];
  const quests: QuestNode[] = [];
  const other: string[] = [];
  let questPoints: QuestReqs['questPoints'] = null;
  // The quest list under way: its line's depth, and the quests still open at each depth.
  let tree: { depth: number; open: { depth: number; node: QuestNode }[] } | null = null;

  for (const line of requirements.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const depth = /^\**/.exec(trimmed)?.[0].length ?? 0;
    const body = trimmed.slice(depth).trim();
    if (tree && depth <= tree.depth) tree = null;
    const text = plain(body.replace(NOTES, ''));

    const spans = [...body.matchAll(SKILL_SPAN)];
    if (spans.length > 0) {
      const named = new Set(spans.map((span) => span[1]));
      // Without its levels, their notes and links to their skills, the line should be empty.
      const rest = plain(
        body
          .replace(NOTES, '')
          .replace(SCP_SPAN, '')
          .replace(LINK, (link, target: string) => (named.has(linkPage(target)) ? '' : link)),
      );
      const note = levelNote(rest);
      if (note === undefined) {
        other.push(text);
        continue;
      }
      spans.forEach((span, i) => {
        const level = Number(span[2]);
        const name = skillName(span[1]);
        // What follows this span, up to the next: its notes.
        const notes = body.slice(span.index, spans[i + 1]?.index ?? body.length);
        if (name === 'Quest points') questPoints = { need: level, note };
        else {
          skills.push({
            skill: name,
            level,
            boostable: !/not boostable/i.test(notes),
            toStart: /(?<!not )required to start/i.test(notes),
            note,
          });
        }
      });
      continue;
    }

    if (/\bfollowing quests?\b/i.test(text)) {
      // "Completion of the following quests:" starts a list, and "Completion of [[X]], which
      // requires the following quests:" a list of what X needs.
      const [named] = linkPages(body);
      if (named) {
        const node = questNode(named);
        quests.push(node);
        tree = { depth, open: [{ depth, node }] };
      } else tree = { depth, open: [] };
      continue;
    }
    if (/^completion of\b/i.test(text)) {
      // "Completion of [[Family Crest]]" names its quests.
      const named = linkPages(body);
      if (named.length > 0) {
        quests.push(...named.map(questNode));
        continue;
      }
    }
    const link = loneLink(body);
    if (tree) {
      while (tree.open.length > 0 && (tree.open.at(-1)?.depth ?? 0) >= depth) tree.open.pop();
      const parent = tree.open.at(-1)?.node;
      if (link !== undefined) {
        const node = questNode(link);
        (parent ? parent.children : quests).push(node);
        tree.open.push({ depth, node });
      } else if (text) (parent ? parent.other : other).push(text);
      continue;
    }
    // A quest on a line of its own, outside the list (every such line in the Bucket is one).
    if (link !== undefined) quests.push(questNode(link));
    else if (text && !/^none\.?$/i.test(text)) other.push(text);
  }
  return { quest, skills, questPoints, quests, other, url: wikiUrl(quest) };
}

const QUEST_LINE = /^\{\{SCP\|Quest[^}]*\}\}\s*/i;
/** What a diary's quest line can begin with, and what it says the quest has to be. */
const QUEST_NEEDS: Record<string, QuestNeed> = {
  'full completion of': 'finished',
  'completion of': 'finished',
  'partial completion of': 'partial',
  'quest start of': 'started',
  started: 'started',
};
const QUEST_VERB = new RegExp(`^(${Object.keys(QUEST_NEEDS).join('|')})\\s+(?:the\\s+)?`, 'i');
const SKILL_TEMPLATE =
  /\{\{SCP\|([^|}]+)\|(\d+)(?:\|[^}]*)?\}\}(\s*\{\{[Bb]oostable\|([^}]*)\}\})?/g;
/** A footnote, which can hold a template: `{{efn|…}}`, or `{{efn|name=x|…}}` used again as `{{efn|name=x}}`. */
const FOOTNOTE = /\{\{efn\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi;

/**
 * Whether a level can be boosted, by its line's note when that says ("neither boostable",
 * "only Hitpoints is boostable"), else as its template says.
 */
function boostableBy(note: string | null, skill: string, otherwise: boolean): boolean {
  if (!note || !/\bboost/i.test(note)) return otherwise;
  const only = /\bonly (\w+) is boostable\b/i.exec(note)?.[1];
  if (only) return only.toLowerCase() === skill.toLowerCase();
  return /\b(?:neither|none|not)\b/i.test(note) ? false : otherwise;
}

/** One requirement line of a diary task (its footnotes left out), into skills, quests or text. */
function readLine(line: string, text: string, task: DiaryTask): void {
  const questLine = QUEST_LINE.exec(line);
  if (questLine) {
    const rest = line.slice(questLine[0].length);
    const verb = QUEST_VERB.exec(rest);
    const named = rest.slice(verb?.[0].length ?? 0);
    const pages = linkPages(named);
    if (verb && pages.length > 0 && SEPARATORS.test(named.replace(/\[\[[^\]]*\]\]/g, ''))) {
      const need = QUEST_NEEDS[verb[1].toLowerCase()];
      task.quests.push(...pages.map((name) => ({ name, need })));
      return;
    }
  } else {
    const levels = [...line.matchAll(SKILL_TEMPLATE)].filter(
      (match) => !NOT_A_SKILL.test(match[1].trim()),
    );
    const note = levelNote(plain(line.replace(SKILL_TEMPLATE, '')));
    if (levels.length > 0 && note !== undefined) {
      for (const match of levels) {
        const skill = skillName(match[1]);
        task.skills.push({
          skill,
          level: Number(match[2]),
          boostable: boostableBy(note, skill, !/^n/i.test((match[4] ?? 'yes').trim())),
          toStart: false,
          note,
        });
      }
      return;
    }
  }
  task.other.push(text);
}

/** A footnote's text: its own, or the text it was given before under its name. */
function footnoteText(body: string, named: Map<string, string>): string {
  const [, name, text] = /^name=([^|]*)(?:\|([\s\S]*))?$/i.exec(body) ?? [body, undefined, body];
  return plain(text?.trim() ? text : (named.get(name?.trim() ?? '') ?? ''));
}

/**
 * One requirement line of a diary task, into the task's skills, quests or plain text, each of
 * its footnotes (an ironman's requirement, a fee) as text of its own; a note is left out. A
 * sub-bullet belongs to the line above it (one of several sets, how to make an item), so it's
 * kept as text.
 */
function readRequirement(
  line: string,
  task: DiaryTask,
  named: Map<string, string>,
  nested: boolean,
): void {
  const withoutNotes = line.replace(FOOTNOTE, '');
  const text = plain(withoutNotes);
  if (!text || /^none\.?$/i.test(text) || /^note:/i.test(text)) return;
  if (nested) task.other.push(text);
  else readLine(withoutNotes, text, task);
  for (const [, body] of line.matchAll(FOOTNOTE)) {
    const note = footnoteText(body, named);
    if (note && !task.other.includes(note)) task.other.push(note);
  }
}

/** Each named footnote's text on a page, for where it's used again by its name. */
function namedFootnotes(wikitext: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const [, body] of wikitext.matchAll(FOOTNOTE)) {
    const [, name, text] = /^name=([^|]*)\|([\s\S]*)$/i.exec(body) ?? [];
    if (name && text?.trim()) named.set(name.trim(), text);
  }
  return named;
}

const TIER_TABLE = /data-diary-tier="(Easy|Medium|Hard|Elite)"([\s\S]*?)\n\|\}/g;

/**
 * A diary's tasks from its wiki page: each `data-diary-tier` table's rows, a task cell (its
 * number and text; notes after it left out) and a requirements cell. A requirement that's only
 * levels (`{{SCP|Agility|39}}`, `{{Boostable|no}}` after one that can't be boosted), or levels
 * with text that only explains them (their note), gives skills; one that's only "Completion of"
 * a quest (or "Started", "Partial completion of") gives quests; anything else, and every
 * sub-bullet, is kept as plain text, and each footnote as text of its own, so nothing but notes
 * is dropped.
 */
export function parseDiaryPage(area: string, wikitext: string): DiaryTask[] {
  const named = namedFootnotes(wikitext);
  const tasks: DiaryTask[] = [];
  for (const [, tier, body] of wikitext.matchAll(TIER_TABLE)) {
    for (const row of body.split(/\n\|-[^\n]*/)) {
      const lines = row.split('\n');
      const taskAt = lines.findIndex((line) => /^\|\s*\d+\./.test(line));
      if (taskAt < 0) continue;
      const [, number = '', text = ''] = /^\|\s*(\d+)\.\s*(.*)$/.exec(lines[taskAt]) ?? [];
      const task: DiaryTask = {
        area,
        tier: tier as DiaryTask['tier'],
        number: Number(number),
        task: plain(text),
        skills: [],
        quests: [],
        other: [],
      };
      const cellAt = lines.findIndex((line, i) => i > taskAt && line.startsWith('|'));
      if (cellAt >= 0) {
        // The cell's first line may hold a requirement after its "|"; the rest are "*" lines.
        const first = lines[cellAt].slice(1).trim();
        const read = (text: string) =>
          readRequirement(text.replace(/^\*+/, ''), task, named, text.startsWith('**'));
        if (first) read(first);
        for (const line of lines.slice(cellAt + 1)) if (line.startsWith('*')) read(line);
      }
      tasks.push(task);
    }
  }
  return tasks;
}

/** Recipe for Disaster's parts: the wiki's page for each, and the game's name for it. */
const RECIPE_FOR_DISASTER_PARTS: [string, string][] = [
  ["Recipe for Disaster/Another Cook's Quest", "Recipe for Disaster - Another Cook's Quest"],
  ['Recipe for Disaster/Freeing the Mountain Dwarf', 'Recipe for Disaster - Mountain Dwarf'],
  ['Recipe for Disaster/Freeing the Goblin generals', 'Recipe for Disaster - Wartface & Bentnoze'],
  ['Recipe for Disaster/Freeing Pirate Pete', 'Recipe for Disaster - Pirate Pete'],
  ['Recipe for Disaster/Freeing the Lumbridge Guide', 'Recipe for Disaster - Lumbridge Guide'],
  ['Recipe for Disaster/Freeing Evil Dave', 'Recipe for Disaster - Evil Dave'],
  ['Recipe for Disaster/Freeing Skrach Uglogwee', 'Recipe for Disaster - Skrach Uglogwee'],
  ['Recipe for Disaster/Freeing Sir Amik Varze', 'Recipe for Disaster - Sir Amik Varze'],
  ['Recipe for Disaster/Freeing King Awowogei', 'Recipe for Disaster - King Awowogei'],
  ['Recipe for Disaster/Defeating the Culinaromancer', 'Recipe for Disaster - Culinaromancer'],
];

/** A name with case, how its apostrophes are written and "(quest)" or "(miniquest)" not counting. */
const plainName = (name: string) =>
  squeeze(name.toLowerCase().replace(/[\u2018\u2019]/g, "'")).replace(
    /\s*\((?:quest|miniquest)\)$/,
    '',
  );

const SAME_QUESTS = new Map(
  RECIPE_FOR_DISASTER_PARTS.map(([wiki, game]) => [plainName(wiki), plainName(game)]),
);

/**
 * A quest's name for matching: case, how its apostrophes are written and the wiki's "(quest)"
 * or "(miniquest)" after a name it shares with something else don't count, and a part of
 * Recipe for Disaster matches by the wiki's name for it or the game's.
 */
export const questKey = (name: string) => {
  const key = plainName(name);
  return SAME_QUESTS.get(key) ?? key;
};

/** A quest's requirements by its name, written however the account or the AI writes it. */
export function findQuestReqs(all: Map<string, QuestReqs>, name: string): QuestReqs | undefined {
  const key = questKey(name);
  for (const [page, reqs] of all) if (questKey(page) === key) return reqs;
  return undefined;
}

/** Each quest's state from the account's quests; one they don't list is unknown. */
function questStates(quests: Record<string, QuestStatus>): (name: string) => QuestState {
  const states = new Map(Object.entries(quests).map(([name, state]) => [questKey(name), state]));
  return (name) => states.get(questKey(name)) ?? 'unknown';
}

const notListed = (name: string) => `${name} (not in the account's quest list)`;

/** A level checked against an account's levels; null when they don't have its skill. */
function checkLevel(req: SkillReq, levels: Record<string, number>): Check['skills'][number] | null {
  const have = levels[req.skill];
  return have === undefined ? null : { ...req, have, met: have >= req.level };
}

/**
 * Whether an account meets a quest's requirements. `levels` are its skills by the hiscores'
 * names, and its combat level as COMBAT_LEVEL. A quest needed is listed once, however many
 * quests need it, and with its own needs only while it isn't finished (a finished one has had
 * them met). Quest points the account's data can't give (null) are listed as unchecked.
 */
export function checkQuest(
  reqs: QuestReqs,
  account: {
    levels: Record<string, number>;
    quests: Record<string, QuestStatus>;
    questPoints: number | null;
  },
): Check {
  const stateOf = questStates(account.quests);
  const unchecked: string[] = [];
  const cantCheck = (text: string) => {
    if (!unchecked.includes(text)) unchecked.push(text);
  };
  const skills = reqs.skills.flatMap((req) => {
    const checked = checkLevel(req, account.levels);
    if (!checked) cantCheck(`${req.skill} ${req.level}`);
    return checked ? [checked] : [];
  });
  const quests: Check['quests'] = [];
  const listed = new Set<string>();
  const walk = (nodes: QuestNode[]) => {
    for (const node of nodes) {
      const state = stateOf(node.name);
      if (!listed.has(questKey(node.name))) {
        listed.add(questKey(node.name));
        quests.push({ name: node.name, need: 'finished', state, met: state === 'finished' });
        if (state === 'unknown') cantCheck(notListed(node.name));
      }
      if (state !== 'finished') {
        for (const text of node.other) cantCheck(`${text} (for ${node.name})`);
        walk(node.children);
      }
    }
  };
  walk(reqs.quests);
  for (const text of reqs.other) cantCheck(text);
  const have = account.questPoints;
  if (reqs.questPoints && have === null) {
    cantCheck(`${reqs.questPoints.need} quest points (the account's quest points aren't known)`);
  }
  const questPoints =
    reqs.questPoints === null || have === null
      ? null
      : {
          need: reqs.questPoints.need,
          have,
          met: have >= reqs.questPoints.need,
          note: reqs.questPoints.note,
        };
  return {
    met:
      skills.every((skill) => skill.met) &&
      quests.every((quest) => quest.met || quest.state === 'unknown') &&
      (questPoints?.met ?? true),
    skills,
    quests,
    questPoints,
    unchecked,
    url: reqs.url,
  };
}

/**
 * Whether an account meets a diary tier's requirements, task by task (`levels` as for
 * checkQuest). Each skill is listed once, at the highest level a task in the tier needs; what
 * can't be checked is listed with its task's number, a quest to be partly done that's in
 * progress among it. A tier with no tasks means the page couldn't be read, so it's a
 * SourceError rather than met.
 */
export function checkDiaryTier(
  tasks: DiaryTask[],
  tier: DiaryTask['tier'],
  account: { levels: Record<string, number>; quests: Record<string, QuestStatus> },
): Check & { tasks: { number: number; task: string; met: boolean }[] } {
  const tierTasks = tasks.filter((task) => task.tier === tier);
  const [first] = tierTasks;
  if (!first) {
    const page = tasks[0] ? `the ${tasks[0].area} Diary page` : 'the diary page';
    throw new SourceError(SITE, null, `${SITE}: no ${tier} tasks could be read from ${page}`);
  }
  const stateOf = questStates(account.quests);
  const skills = new Map<string, Check['skills'][number]>();
  const quests = new Map<string, Check['quests'][number]>();
  const unchecked: string[] = [];
  const results = tierTasks.map((task) => {
    let met = true;
    for (const req of task.skills) {
      const checked = checkLevel(req, account.levels);
      if (!checked) {
        unchecked.push(`Task ${task.number}: ${req.skill} ${req.level}`);
        continue;
      }
      if (!checked.met) met = false;
      const listed = skills.get(req.skill);
      if (!listed || req.level > listed.level) skills.set(req.skill, checked);
    }
    for (const { name, need } of task.quests) {
      const state = stateOf(name);
      const done = state === 'finished' || (need === 'started' && state === 'in_progress');
      if (state === 'unknown') unchecked.push(`Task ${task.number}: ${notListed(name)}`);
      else if (need === 'partial' && state === 'in_progress') {
        unchecked.push(
          `Task ${task.number}: ${name} partly done (it's in progress; how far can't be checked)`,
        );
      } else if (!done) met = false;
      quests.set(`${need}:${questKey(name)}`, { name, need, state, met: done });
    }
    for (const text of task.other) unchecked.push(`Task ${task.number}: ${text}`);
    return { number: task.number, task: task.task, met };
  });
  return {
    met: results.every((result) => result.met),
    skills: [...skills.values()],
    quests: [...quests.values()],
    questPoints: null,
    unchecked,
    url: wikiUrl(`${first.area} Diary`, tier),
    tasks: results,
  };
}

const QUEST_QUERY = bucketSelect('quest', ['page_name', 'requirements'], { limit: 2000 });

/**
 * Every quest's requirements, by its page name, from one Bucket query kept a day; findQuestReqs
 * looks one up by the name it's asked for.
 */
export function loadAllQuestRequirements(ctx: WikiCtx): Promise<Map<string, QuestReqs>> {
  type Row = { page_name?: unknown; requirements?: unknown };
  return parsedOnce(
    ctx,
    QUEST_QUERY,
    (read) => bucketQuery<Row>(read, QUEST_QUERY),
    (rows) => {
      const all = new Map<string, QuestReqs>();
      for (const row of rows) {
        if (typeof row.page_name !== 'string') continue;
        const text = Array.isArray(row.requirements)
          ? row.requirements.join('\n')
          : typeof row.requirements === 'string'
            ? row.requirements
            : '';
        all.set(row.page_name, parseQuestRequirements(row.page_name, text));
      }
      return all;
    },
  );
}

const QUEST_LIST = 'Quests/List';

/**
 * Each quest's quest points, by its page name, from the wiki's list of quests (Quests/List,
 * rendered and kept a day): the column headed by the quest point icon in each of its tables (the
 * miniquests' table has none, as they give none). A quest whose parts are listed as quests of
 * their own (Recipe for Disaster/…) is left out, its points being its parts'. A list with no
 * quest points read is a SourceError rather than none.
 */
export function loadQuestPoints(ctx: WikiCtx): Promise<Map<string, number>> {
  return parsedOnce(ctx, QUEST_LIST, (read) => getRenderedPage(read, QUEST_LIST), questPointsIn);
}

/** Each quest's points in the quest list's HTML (see loadQuestPoints). */
function questPointsIn(html: string): Map<string, number> {
  const root = parse(html);
  const points = new Map<string, number>();
  // A table without the column (the miniquests') has no cell there, so no number.
  for (const table of root.querySelectorAll('table')) {
    const column = table
      .querySelectorAll('th')
      .findIndex((th) => th.querySelector('[data-skill="Quest points"]'));
    for (const row of table.querySelectorAll('tr[data-rowid]')) {
      const value = squeeze(row.querySelectorAll('td')[column]?.text ?? '');
      const quest = row.getAttribute('data-rowid');
      if (quest && /^\d+$/.test(value)) points.set(quest, Number(value));
    }
  }
  // A quest whose parts are listed too counts by its parts.
  for (const quest of [...points.keys()]) {
    const slash = quest.indexOf('/');
    if (slash > 0) points.delete(quest.slice(0, slash));
  }
  if (points.size === 0) {
    throw new SourceError(
      SITE,
      null,
      `${SITE}: the quest points couldn't be read from ${QUEST_LIST}`,
    );
  }
  return points;
}

/**
 * An account's quest points: those of the quests it has finished (its quests by name and state,
 * as for checkQuest), from loadQuestPoints.
 */
export function questPointsOf(
  quests: Record<string, QuestStatus>,
  points: Map<string, number>,
): number {
  const byKey = new Map([...points].map(([quest, value]) => [questKey(quest), value]));
  let total = 0;
  for (const [quest, state] of Object.entries(quests)) {
    if (state === 'finished') total += byKey.get(questKey(quest)) ?? 0;
  }
  return total;
}

/** One diary's tasks, from its wiki page (`<area> Diary`), kept until the page changes. */
export function loadDiaryPage(ctx: WikiCtx, area: string): Promise<DiaryTask[]> {
  return parsedOnce(
    ctx,
    `diary:${area}`,
    (read) => getPageWikitext(read, `${area} Diary`),
    (wikitext) => parseDiaryPage(area, wikitext),
  );
}
