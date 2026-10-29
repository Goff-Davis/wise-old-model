import { DAY_MS } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { fakeRequester, fixture, testWikiCtx } from '../../test/helpers.ts';
import {
  COMBAT_LEVEL,
  checkDiaryTier,
  checkQuest,
  type DiaryTask,
  findQuestReqs,
  loadAllQuestRequirements,
  loadDiaryPage,
  loadQuestPoints,
  parseDiaryPage,
  parseQuestRequirements,
  type QuestReqs,
  type QuestStatus,
  questPointsOf,
} from './requirements.ts';

/** Dragon Slayer II's requirements as the wiki's Quest bucket gives them (captured in Task 15). */
const DS2_TEXT: string = JSON.parse(fixture('wiki/quest-dragon-slayer-ii.json')).bucket[0]
  .requirements;
const ARDOUGNE = fixture('wiki/diary-ardougne.wikitext');
/** Twenty of the Quest bucket's rows, as captured on 2026-10-28. */
const SAMPLE: { page_name: string; requirements: string }[] = JSON.parse(
  fixture('wiki/quests-sample.json'),
).bucket;

const ds2 = () => parseQuestRequirements('Dragon Slayer II', DS2_TEXT);
const sample = (quest: string) => {
  const row = SAMPLE.find((each) => each.page_name === quest);
  if (!row) throw new Error(`${quest} isn't in the sample`);
  return parseQuestRequirements(quest, row.requirements);
};

/** Every quest in a requirement tree, depth first. */
const allQuests = (nodes: QuestReqs['quests']): string[] =>
  nodes.flatMap((node) => [node.name, ...allQuests(node.children)]);

/** The hiscores' skills, by the names they give them (Runecraft, not Runecrafting). */
const SKILLS: string[] = JSON.parse(fixture('hiscores/lynx-titan.json'))
  .skills.map((skill: { name: string }) => skill.name)
  .filter((name: string) => name !== 'Overall');

/** An account's levels: 99 in every skill and a combat level of 126, unless `levels` says. */
const levelsWith = (levels: Record<string, number> = {}): Record<string, number> => ({
  ...Object.fromEntries(SKILLS.map((skill) => [skill, 99])),
  [COMBAT_LEVEL]: 126,
  ...levels,
});

/** A requester answering the wiki's quest list (the fixture). */
const questListReq = () => fakeRequester(() => fixture('wiki/parse-quests-list.json')).req;

const span = (skill: string, level: number) =>
  `*<span class="scp" data-skill="${skill}" data-level="${level}">${level} [[${skill}]]</span>`;

describe('parseQuestRequirements', () => {
  it('reads the skills, with whether each can be boosted and is needed to start', () => {
    const { skills } = ds2();
    expect(skills).toHaveLength(8);
    expect(skills).toContainEqual({
      skill: 'Magic',
      level: 75,
      boostable: false,
      toStart: true,
      note: null,
    });
    expect(skills.map((skill) => `${skill.skill} ${skill.level}`)).toEqual([
      'Magic 75',
      'Smithing 70',
      'Mining 68',
      'Crafting 62',
      'Agility 60',
      'Thieving 60',
      'Construction 50',
      'Hitpoints 50',
    ]);
  });

  it('tells "not required to start" from "required to start"', () => {
    expect(sample('Lost City').skills).toEqual([
      { skill: 'Crafting', level: 31, boostable: true, toStart: false, note: null },
      { skill: 'Woodcutting', level: 36, boostable: true, toStart: false, note: null },
    ]);
  });

  it('takes the quest points apart from the skills', () => {
    expect(ds2().questPoints).toEqual({ need: 200, note: null });
  });

  it('reads the quests needed as a tree, each with the quests it needs', () => {
    const { quests } = ds2();
    expect(quests.map((quest) => quest.name)).toEqual([
      "Legends' Quest",
      'Dream Mentor',
      'A Tail of Two Cats',
      'Animal Magnetism',
      'Ghosts Ahoy',
      'Bone Voyage',
      'Client of Kourend',
    ]);
    const legends = quests[0];
    expect(legends?.children.map((quest) => quest.name)).toEqual([
      'Family Crest',
      "Heroes' Quest",
      'Underground Pass',
      'Waterfall Quest',
    ]);
    expect(legends?.children[1]?.children.map((quest) => quest.name)).toEqual([
      'Shield of Arrav',
      'Lost City',
      "Merlin's Crystal",
      'Dragon Slayer I',
    ]);
    expect(allQuests(legends?.children[2]?.children ?? [])).toEqual(['Biohazard', 'Plague City']);
  });

  it("keeps what isn't a skill or a quest as plain text, a line in the tree with its quest", () => {
    expect(ds2().other).toEqual([
      'Started the pyre ship portion of the Barbarian Training miniquest to gain access to the Ancient Cavern',
    ]);
    const boneVoyage = ds2().quests.find((quest) => quest.name === 'Bone Voyage');
    expect(boneVoyage?.other).toEqual(['100 Kudos']);
    expect(allQuests(ds2().quests)).not.toContain('Kudos');
  });

  it("links the quest's wiki page", () => {
    expect(ds2().url).toBe('https://oldschool.runescape.wiki/w/Dragon_Slayer_II');
  });

  it("uses the hiscores' skill names, and reads a combat level", () => {
    const reqs = parseQuestRequirements(
      'Test',
      `${span('Runecraft', 55)}\n${span('Combat level', 85)}`,
    );
    expect(reqs.skills).toEqual([
      { skill: 'Runecraft', level: 55, boostable: true, toStart: false, note: null },
      { skill: COMBAT_LEVEL, level: 85, boostable: true, toStart: false, note: null },
    ]);
    expect(COMBAT_LEVEL).toBe('Combat level');
    // Dream Mentor's combat level, its link outside the level's span.
    expect(sample('Dream Mentor').skills).toEqual([
      { skill: COMBAT_LEVEL, level: 85, boostable: true, toStart: true, note: null },
    ]);
  });

  it('checks a level whose text only explains it, keeping the text as its note', () => {
    expect(sample('Troll Stronghold').skills).toEqual([
      { skill: 'Agility', level: 15, boostable: true, toStart: false, note: '47 is recommended' },
    ]);
    expect(sample('While Guthix Sleeps').skills).toContainEqual({
      skill: 'Firemaking',
      level: 49,
      boostable: true,
      toStart: false,
      note: 'To light the Sapphire Lantern',
    });
    expect(sample('Monkey Madness II').skills).toContainEqual({
      skill: 'Firemaking',
      level: 60,
      boostable: false,
      toStart: true,
      note: 'for Gnome Stronghold Route',
    });
    expect(sample('Curse of the Empty Lord').skills).toEqual([
      {
        skill: 'Thieving',
        level: 53,
        boostable: false,
        toStart: true,
        note: 'to obtain the Ring of visibility',
      },
    ]);
  });

  it('keeps a level with a way around it, or a condition on it, as text', () => {
    const guthix = sample('While Guthix Sleeps');
    expect(guthix.skills.map((skill) => skill.skill)).not.toContain('Attack');
    expect(guthix.other).toEqual([
      "Ability to enter the Warriors' Guild (the sum of your Attack and Strength must be at or above 130; OR 99 Attack, OR 99 Strength)",
    ]);
    const kept: [string, string][] = [
      ['Roving Elves', '56 Agility, unless travelling with a charter ship to the elven woods'],
      ['Desert Treasure I', '10 Slayer or the gas mask from Plague City'],
      ['Temple of Ikov', '40 Ranged - bypassable'],
      [
        'Rag and Bone Man II',
        '20 Defence to wield a mirror shield to kill a basilisk (though not necessary; see below)',
      ],
      [
        'Curse of the Empty Lord',
        '31 Prayer (Some players will need this to access the 2nd floor of the Edgeville Monastery)',
      ],
      ['Architectural Alliance', '42 Mining for any Lovakengj activity'],
    ];
    for (const [quest, text] of kept) {
      const reqs = sample(quest);
      expect(reqs.other, quest).toContain(text);
      const [, level, skill] = /^(\d+) (\w+)/.exec(text) ?? [];
      expect(reqs.skills, quest).not.toContainEqual(
        expect.objectContaining({ skill, level: Number(level) }),
      );
    }
  });

  it('reads a skill line with only a reference after it as the skill', () => {
    const watchtower = sample('Watchtower');
    expect(watchtower.skills.map((skill) => `${skill.skill} ${skill.level}`)).toEqual([
      'Magic 14',
      'Thieving 15',
      'Agility 25',
      'Herblore 14',
      'Mining 40',
    ]);
    expect(watchtower.other).toEqual([
      'The ability to defeat a level 68 Ogre and run past level 111 Blue dragons',
    ]);
  });

  it('keeps a level as text when its note would say it may not be needed', () => {
    // Made-up notes, one for each word that makes a note a condition or a way around a level.
    const notes = [
      '(or a charter ship)',
      '(unless using the shortcut)',
      '(if not using the boat)',
      "(except on a members' world)",
      '(either skill)',
      '(a rope can be used instead)',
      '(otherwise a rope)',
      '(optional)',
      '(for any of the routes)',
      '(some players will need this)',
      '(depending on the route)',
      '(can be bypassed)',
      '(alternatively, a rope)',
      '(recommended)',
      '(for Ironman accounts)',
      '(though not necessary)',
      '(not required for the reward)',
    ];
    for (const note of notes) {
      const reqs = parseQuestRequirements('Test', `${span('Agility', 50)} ${note}`);
      expect(reqs.skills, note).toEqual([]);
      expect(reqs.other, note).toEqual([`50 Agility ${note}`]);
    }
  });

  it('checks quest points whose text only explains them, keeping the text as their note', () => {
    expect(sample('Dragon Slayer I')).toMatchObject({
      questPoints: { need: 32, note: "to enter the Champions' Guild" },
      other: ['The ability to defeat a level 83 dragon'],
    });
    expect(sample('Recipe for Disaster').questPoints).toEqual({
      need: 175,
      note: '9 are earned for the other parts of the quest, and 79 are gained by completing all required quests',
    });
  });

  it('reads a lone quest, inline or as a line of its own, and skips "None"', () => {
    expect(parseQuestRequirements('Family Pest', 'Completion of [[Family Crest]]').quests).toEqual([
      { name: 'Family Crest', children: [], other: [] },
    ]);
    expect(parseQuestRequirements('Test', '*[[Priest in Peril]]').quests).toEqual([
      { name: 'Priest in Peril', children: [], other: [] },
    ]);
    expect(parseQuestRequirements("Cook's Assistant", 'None')).toMatchObject({
      skills: [],
      quests: [],
      other: [],
      questPoints: null,
    });
  });

  it('takes no file link for a quest, as the quest point icon before one is', () => {
    // Troll Stronghold, as the Bucket has it.
    const line =
      '* Completion of <span class="scp" data-skill="Quest points" style="position:relative;">[[File:Quest point icon.png|link=Quest points|alt=Quest points]] </span> [[Death Plateau]]';
    expect(parseQuestRequirements('Troll Stronghold', line).quests).toEqual([
      { name: 'Death Plateau', children: [], other: [] },
    ]);
    // An icon on a line of its own is no quest either.
    expect(parseQuestRequirements('Test', '*[[File:Quest point icon.png]]').quests).toEqual([]);
  });

  it('puts a quest listed under a line of text under the quest that line is under', () => {
    // Once Bone Voyage is finished, what its kudos needed doesn't matter.
    const text = [
      '*Completion of the following quests:',
      '**[[Bone Voyage]]',
      '***100 [[Kudos]]',
      '****[[The Dig Site]]',
    ].join('\n');
    expect(parseQuestRequirements('Test', text).quests).toEqual([
      {
        name: 'Bone Voyage',
        children: [{ name: 'The Dig Site', children: [], other: [] }],
        other: ['100 Kudos'],
      },
    ]);
  });

  it("puts a quest listed under a line that isn't one at the top, not under the quest before", () => {
    // Rogue Trader: Gertrude's Cat is needed for Icthlarin's Little Helper, started.
    const text = [
      'Completion of following quests:',
      '*[[The Feud]]',
      '*[[Rune Mysteries]]',
      "*[[Icthlarin's Little Helper]] (started, for access to [[Sophanem]])",
      "**[[Gertrude's Cat]]",
    ].join('\n');
    const reqs = parseQuestRequirements('Rogue Trader', text);
    expect(reqs.quests).toEqual([
      { name: 'The Feud', children: [], other: [] },
      { name: 'Rune Mysteries', children: [], other: [] },
      { name: "Gertrude's Cat", children: [], other: [] },
    ]);
    expect(reqs.other).toEqual(["Icthlarin's Little Helper (started, for access to Sophanem)"]);
  });

  it('reads every way the wiki starts a list of quests', () => {
    expect(allQuests(sample('The Great Brain Robbery').quests)).toEqual([
      'Creature of Fenkenstrain',
      'Cabin Fever',
      "Pirate's Treasure",
      'Rum Deal',
      'Priest in Peril',
      'Zogre Flesh Eaters',
      'Big Chompy Bird Hunting',
      'Jungle Potion',
      'Druidic Ritual',
      'Recipe for Disaster/Freeing Pirate Pete',
      "Recipe for Disaster/Another Cook's Quest",
      "Cook's Assistant",
    ]);
    expect(sample('The Great Brain Robbery').other).toEqual([
      'Access to a player-owned house workshop and crafting table or the Grand Exchange',
      'Be able to kill a level 190 monster that can disable Prayers (can be safespotted without taking damage).',
    ]);
    expect(sample('Vale Totems (miniquest)')).toMatchObject({
      quests: [{ name: 'Children of the Sun', children: [], other: [] }],
      other: [],
    });
    // A list of what the quests above it need goes on the list.
    const divided = sample('A Kingdom Divided');
    expect(divided.quests.map((quest) => quest.name)).toEqual([
      'The Depths of Despair',
      'The Queen of Thieves',
      'The Ascent of Arceuus',
      'The Forsaken Tower',
      'Tale of the Righteous',
      'Client of Kourend',
    ]);
    expect(divided.other).toEqual([]);
  });

  it('reads a quest whose own needs are listed under it, without category links', () => {
    const archive = sample('The Fractured Archive (miniquest)');
    expect(archive.quests.map((quest) => quest.name)).toEqual(['While Guthix Sleeps']);
    expect(archive.quests[0]?.children.map((quest) => quest.name)).toEqual([
      'Defender of Varrock',
      'The Path of Glouphrie',
      'Fight Arena',
      'Dream Mentor',
      'The Hand in the Sand',
      'Wanted!',
      'Temple of the Eye',
      'Tears of Guthix',
      'Nature Spirit',
      'A Tail of Two Cats',
    ]);
    expect(archive.other).toEqual([]);
  });
});

/** An account that has finished every quest Dragon Slayer II needs, but `unfinished`. */
function ds2Account(opts: {
  levels?: Record<string, number>;
  unfinished?: Record<string, QuestStatus>;
}) {
  const quests: Record<string, QuestStatus> = Object.fromEntries(
    allQuests(ds2().quests).map((name) => [name, 'finished']),
  );
  return {
    levels: levelsWith(opts.levels),
    quests: { ...quests, ...opts.unfinished },
    questPoints: 250,
  };
}

describe('checkQuest', () => {
  it("says what isn't met: a level short, and a quest not started", () => {
    const check = checkQuest(
      ds2(),
      ds2Account({ levels: { Magic: 71 }, unfinished: { 'Dream Mentor': 'not_started' } }),
    );
    expect(check.met).toBe(false);
    expect(check.skills.find((skill) => skill.skill === 'Magic')).toEqual({
      skill: 'Magic',
      level: 75,
      boostable: false,
      toStart: true,
      note: null,
      have: 71,
      met: false,
    });
    expect(check.quests.find((quest) => quest.name === 'Dream Mentor')).toEqual({
      name: 'Dream Mentor',
      need: 'finished',
      state: 'not_started',
      met: false,
    });
  });

  it('checks a Runecraft level', () => {
    const check = checkQuest(sample('What Lies Below'), {
      levels: levelsWith({ Runecraft: 1 }),
      quests: { 'Rune Mysteries': 'finished' },
      questPoints: 0,
    });
    expect(check).toMatchObject({
      met: false,
      skills: [{ skill: 'Runecraft', level: 35, have: 1, met: false }],
      unchecked: [],
    });
  });

  it("lists a quest's own needs only while it isn't finished", () => {
    const check = checkQuest(ds2(), ds2Account({ unfinished: { 'Dream Mentor': 'in_progress' } }));
    // Legends' Quest is finished, so what it needed isn't listed; Dream Mentor's is.
    expect(check.quests.map((quest) => quest.name)).toEqual([
      "Legends' Quest",
      'Dream Mentor',
      'Lunar Diplomacy',
      "Eadgar's Ruse",
      'A Tail of Two Cats',
      'Animal Magnetism',
      'Ghosts Ahoy',
      'Bone Voyage',
      'Client of Kourend',
    ]);
    expect(check.quests[1]).toMatchObject({ state: 'in_progress', met: false });
  });

  it("lists the quest points as unchecked when the account's aren't known", () => {
    const check = checkQuest(ds2(), { ...ds2Account({}), questPoints: null });
    expect(check.met).toBe(true);
    expect(check.questPoints).toBeNull();
    expect(check.unchecked).toContain("200 quest points (the account's quest points aren't known)");
  });

  it("is met when everything checkable is, and says what it couldn't check", () => {
    const check = checkQuest(ds2(), ds2Account({}));
    expect(check.met).toBe(true);
    expect(check.questPoints).toEqual({ need: 200, have: 250, met: true, note: null });
    expect(check.unchecked).toEqual([
      'Started the pyre ship portion of the Barbarian Training miniquest to gain access to the Ancient Cavern',
    ]);
    expect(check.url).toBe('https://oldschool.runescape.wiki/w/Dragon_Slayer_II');
  });

  it("lists what a quest in the tree needs as text only while that quest isn't finished", () => {
    const check = checkQuest(ds2(), ds2Account({ unfinished: { 'Bone Voyage': 'not_started' } }));
    expect(check.unchecked).toEqual([
      '100 Kudos (for Bone Voyage)',
      'Started the pyre ship portion of the Barbarian Training miniquest to gain access to the Ancient Cavern',
    ]);
  });

  it('says what a quest needed by several quests needs once', () => {
    const text = [
      '*Completion of the following quests:',
      '**[[Bone Voyage]]',
      '***100 [[Kudos]]',
      '**[[A Kingdom Divided]]',
      '***[[Bone Voyage]]',
      '****100 [[Kudos]]',
    ].join('\n');
    const check = checkQuest(parseQuestRequirements('Test', text), {
      levels: {},
      quests: { 'Bone Voyage': 'not_started', 'A Kingdom Divided': 'not_started' },
      questPoints: 0,
    });
    expect(check.unchecked).toEqual(['100 Kudos (for Bone Voyage)']);
  });

  it('lists a quest needed by several quests once', () => {
    const reqs = sample('Desert Treasure II - The Fallen Empire');
    const names = allQuests(reqs.quests);
    const quests: Record<string, QuestStatus> = Object.fromEntries(
      names.map((name) => [name, 'not_started']),
    );
    const check = checkQuest(reqs, { levels: levelsWith(), quests, questPoints: 0 });
    const listed = check.quests.map((quest) => quest.name);
    // Priest in Peril is in the tree four times.
    expect(names.filter((name) => name === 'Priest in Peril')).toHaveLength(4);
    expect(listed.filter((name) => name === 'Priest in Peril')).toHaveLength(1);
    expect(listed).toEqual([...new Set(names)]);
  });

  it('counts the quest points', () => {
    const check = checkQuest(ds2(), { ...ds2Account({}), questPoints: 150 });
    expect(check).toMatchObject({ met: false, questPoints: { need: 200, have: 150, met: false } });
    const slayer = checkQuest(sample('Dragon Slayer I'), {
      levels: levelsWith(),
      quests: {},
      questPoints: 20,
    });
    expect(slayer.questPoints).toEqual({
      need: 32,
      have: 20,
      met: false,
      note: "to enter the Champions' Guild",
    });
  });

  it("matches quest names however the apostrophes are written, and can't check a quest it doesn't know", () => {
    const account = ds2Account({});
    const { "Legends' Quest": _legends, 'Client of Kourend': _client, ...rest } = account.quests;
    const check = checkQuest(ds2(), {
      ...account,
      quests: { ...rest, 'Legends’ Quest': 'finished' },
    });
    expect(check.quests.find((quest) => quest.name === "Legends' Quest")?.met).toBe(true);
    expect(check.quests.find((quest) => quest.name === 'Client of Kourend')).toMatchObject({
      state: 'unknown',
      met: false,
    });
    expect(check.unchecked).toContain("Client of Kourend (not in the account's quest list)");
    // What can't be checked isn't counted as unmet.
    expect(check.met).toBe(true);
  });

  it('matches a quest the wiki names with "(quest)" after it', () => {
    const reqs = parseQuestRequirements('Test', '*[[Tears of Guthix (quest)]]');
    const check = checkQuest(reqs, {
      levels: {},
      quests: { 'Tears of Guthix': 'finished' },
      questPoints: 0,
    });
    expect(check.quests).toEqual([
      { name: 'Tears of Guthix (quest)', need: 'finished', state: 'finished', met: true },
    ]);
  });

  it("matches Recipe for Disaster's parts, which the wiki and the game name differently", () => {
    const parts: [string, string][] = [
      ["Recipe for Disaster/Another Cook's Quest", "Recipe for Disaster - Another Cook's Quest"],
      ['Recipe for Disaster/Freeing the Mountain Dwarf', 'Recipe for Disaster - Mountain Dwarf'],
      [
        'Recipe for Disaster/Freeing the Goblin generals',
        'Recipe for Disaster - Wartface & Bentnoze',
      ],
      ['Recipe for Disaster/Freeing Pirate Pete', 'Recipe for Disaster - Pirate Pete'],
      ['Recipe for Disaster/Freeing the Lumbridge Guide', 'Recipe for Disaster - Lumbridge Guide'],
      ['Recipe for Disaster/Freeing Evil Dave', 'Recipe for Disaster - Evil Dave'],
      ['Recipe for Disaster/Freeing Skrach Uglogwee', 'Recipe for Disaster - Skrach Uglogwee'],
      ['Recipe for Disaster/Freeing Sir Amik Varze', 'Recipe for Disaster - Sir Amik Varze'],
      ['Recipe for Disaster/Freeing King Awowogei', 'Recipe for Disaster - King Awowogei'],
      ['Recipe for Disaster/Defeating the Culinaromancer', 'Recipe for Disaster - Culinaromancer'],
    ];
    for (const [wiki, game] of parts) {
      const check = checkQuest(parseQuestRequirements('Test', `*[[${wiki}]]`), {
        levels: {},
        quests: { [game]: 'finished' },
        questPoints: 0,
      });
      expect(check.quests[0]?.state, wiki).toBe('finished');
    }
    // So The Great Brain Robbery is held back by Pirate Pete.
    const robbery = sample('The Great Brain Robbery');
    const quests = Object.fromEntries(allQuests(robbery.quests).map((name) => [name, 'finished']));
    const check = checkQuest(robbery, {
      levels: levelsWith(),
      quests: {
        ...quests,
        "Recipe for Disaster - Another Cook's Quest": 'finished',
        'Recipe for Disaster - Pirate Pete': 'not_started',
      },
      questPoints: 0,
    });
    expect(check.met).toBe(false);
    expect(check.quests).toContainEqual({
      name: 'Recipe for Disaster/Freeing Pirate Pete',
      need: 'finished',
      state: 'not_started',
      met: false,
    });
  });

  it("can't check a skill the account's levels don't have", () => {
    const reqs = parseQuestRequirements(
      'Test',
      '*<span class="scp" data-skill="Combat level" data-level="85">85</span>',
    );
    const check = checkQuest(reqs, { levels: { Attack: 99 }, quests: {}, questPoints: 0 });
    expect(check).toMatchObject({ met: true, skills: [], unchecked: ['Combat level 85'] });
  });
});

const ardougne = () => parseDiaryPage('Ardougne', ARDOUGNE);
const task = (tier: DiaryTask['tier'], number: number) =>
  ardougne().find((each) => each.tier === tier && each.number === number);

/** A diary page of one tier's tasks, each a task's lines (its text, then its requirements). */
const diaryPage = (tier: DiaryTask['tier'], tasks: string[][]) =>
  [
    `{| class="diary-table" data-diary-name="Test" data-diary-tier="${tier}"`,
    '! Task',
    '! Requirements',
    ...tasks.flatMap((lines) => ['|-', ...lines]),
    '|}',
  ].join('\n');

describe('parseDiaryPage', () => {
  it("reads every tier's tasks, numbered", () => {
    const counts = Object.fromEntries(
      (['Easy', 'Medium', 'Hard', 'Elite'] as const).map((tier) => [
        tier,
        ardougne()
          .filter((each) => each.tier === tier)
          .map((each) => each.number),
      ]),
    );
    expect(counts).toEqual({
      Easy: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      Medium: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      Hard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      Elite: [1, 2, 3, 4, 5, 6, 7, 8],
    });
  });

  it('reads a task needing a quest, and one needing a level', () => {
    expect(task('Easy', 1)).toEqual({
      area: 'Ardougne',
      tier: 'Easy',
      number: 1,
      task: 'Have Wizard Cromperty teleport you to the Rune Essence mine.',
      skills: [],
      quests: [{ name: 'Rune Mysteries', need: 'finished' }],
      other: [],
    });
    expect(task('Easy', 2)?.skills).toEqual([
      { skill: 'Thieving', level: 5, boostable: true, toStart: false, note: null },
    ]);
  });

  it('keeps items and anything else as plain text, and a task with none as nothing', () => {
    expect(task('Easy', 3)?.other).toEqual(['Silk']);
    expect(task('Easy', 7)?.other).toEqual(['Rusty sword and 100 coins']);
    expect(task('Easy', 4)).toMatchObject({ skills: [], quests: [], other: [] });
  });

  it('tells a quest to be finished from one to be started or partly done', () => {
    expect(task('Medium', 1)).toMatchObject({
      quests: [{ name: 'Fairytale II - Cure a Queen', need: 'started' }],
      other: ['Dramen or Lunar staff to travel to Fairy ring code BIS.'],
    });
    expect(task('Medium', 7)?.quests).toEqual([{ name: 'Sea Slug', need: 'started' }]);
    expect(task('Medium', 9)?.quests).toEqual([{ name: 'Watchtower', need: 'partial' }]);
    expect(task('Elite', 5)?.quests).toEqual([{ name: 'Haunted Mine', need: 'finished' }]);
  });

  it('reads several levels on one line, each with whether it can be boosted', () => {
    expect(task('Medium', 2)?.skills).toEqual([
      { skill: 'Agility', level: 39, boostable: true, toStart: false, note: null },
      { skill: 'Strength', level: 38, boostable: true, toStart: false, note: null },
      { skill: 'Ranged', level: 21, boostable: true, toStart: false, note: null },
    ]);
    expect(task('Elite', 1)?.skills).toEqual([
      { skill: 'Fishing', level: 81, boostable: false, toStart: false, note: null },
      { skill: 'Cooking', level: 91, boostable: true, toStart: false, note: null },
    ]);
    expect(task('Hard', 10)?.skills).toEqual([
      { skill: 'Construction', level: 50, boostable: false, toStart: false, note: null },
    ]);
  });

  it("keeps a requirement's footnote as text of its own, as ironmen's are", () => {
    expect(task('Medium', 2)?.other).toEqual([
      'Mith grapple and any crossbow',
      'Ironmen require either access to the Ancient Cavern or 59 Smithing and 59 Fletching for a mith grapple.',
    ]);
  });

  it('gives a footnote used again by its name the text it was first given', () => {
    // From the Wilderness, Lumbridge & Draynor and Varrock diaries.
    const page = diaryPage('Elite', [
      [
        '|1. Kill a [[Rune dragon]].',
        '|',
        '*3,750-7,500 [[coins]]{{efn|name=FeeElite|The regular fee to enter the [[Resource Area]] is 7,500 [[coins]]. This is reduced to 6,000 [[coins]] when the rewards for the [[#Medium|medium tasks]] are claimed, and further down to 3,750 [[coins]] with the rewards of the [[#Hard|hard tasks]].}}',
      ],
      ['|2. Smith a [[rune scimitar]].', '|', '*3,750-7,500 [[coins]]{{efn|name=FeeElite}}'],
      [
        '|3. Grapple across a pylon.',
        '|',
        '*[[Mith grapple]]{{efn|[[Ironman Mode|Ironmen]] require one of: <ul><li>Access to the [[Ancient Cavern]]</li><li>59 [[Smithing]] and 59 [[Fletching]] to make a mith grapple</li><li>99 Fletching for a [[mith grapple]] from the [[Fletching cape]]</li></ul>}}, any [[Crossbow (weapon)|crossbow]], and a [[light source]]',
      ],
      // A footnote on two of a task's lines is listed once.
      [
        '|4. Make 20 mahogany planks.',
        '|',
        '*21,000 [[coins]] and 20 [[mahogany logs]]{{efn|name=voucher|You may use ten [[sawmill voucher]]s to halve the required items and runes for the [[Plank Make]] task.}}',
        '*Means to cast [[Plank Make]] twenty times ({{RuneReq|Nature=20|Astral=40|Earth=300}}){{efn|name=voucher}}',
      ],
    ]);
    const fee =
      'The regular fee to enter the Resource Area is 7,500 coins. This is reduced to 6,000 coins when the rewards for the medium tasks are claimed, and further down to 3,750 coins with the rewards of the hard tasks.';
    expect(parseDiaryPage('Test', page).map((each) => each.other)).toEqual([
      ['3,750-7,500 coins', fee],
      ['3,750-7,500 coins', fee],
      [
        'Mith grapple, any crossbow, and a light source',
        'Ironmen require one of: Access to the Ancient Cavern; 59 Smithing and 59 Fletching to make a mith grapple; 99 Fletching for a mith grapple from the Fletching cape',
      ],
      [
        '21,000 coins and 20 mahogany logs',
        'You may use ten sawmill vouchers to halve the required items and runes for the Plank Make task.',
        'Means to cast Plank Make twenty times (20 Nature, 40 Astral, 300 Earth)',
      ],
    ]);
  });

  it("writes the wiki's templates out and leaves notes out", () => {
    expect(task('Medium', 4)).toMatchObject({
      quests: [{ name: 'Plague City', need: 'finished' }],
      skills: [{ skill: 'Magic', level: 51, boostable: true, toStart: false }],
      other: ['Means to cast Ardougne Teleport (2 Water, 2 Law)'],
    });
    expect(task('Hard', 12)).toMatchObject({
      quests: [{ name: "Mourning's End Part II", need: 'finished' }],
      skills: [{ skill: 'Runecraft', level: 65, boostable: true, toStart: false }],
      other: ['Pure or daeyalt essence', 'Access to the Death Altar via the Abyss'],
    });
    // From the Falador, Western Provinces and Varrock diaries.
    const page = diaryPage('Hard', [
      [
        '|1. Enter the Warriors’ Guild.',
        '|',
        '*130 combined levels in {{SCP|Attack|link=yes}} and {{SCP|Strength|link=yes}}, or level 99 in either',
        '*{{SCP|Cooking|29-42|link=y}} (varies per food)',
        '*{{SCP|Quest|32|link=y}}',
      ],
      // A range is no level to check, even on a line of its own.
      ['|2. Cook something.', '|', '*{{SCP|Cooking|29-42|link=y}}'],
    ]);
    const [first, second] = parseDiaryPage('Test', page);
    expect(first).toMatchObject({
      skills: [],
      other: [
        '130 combined levels in Attack and Strength, or level 99 in either',
        'Cooking 29-42 (varies per food)',
        '32 quest points',
      ],
    });
    expect(second).toMatchObject({ skills: [], other: ['Cooking 29-42'] });
  });

  it("checks a line's levels when its text only explains them, but not an ironman's, or a sub-bullet's", () => {
    // From the Kandarin, Falador, Fremennik and Morytania diaries.
    const page = diaryPage('Elite', [
      [
        '|1. Kill a monster.',
        '|',
        '*{{SCP|Prayer|70|link=y}} and {{SCP|Defence|70|link=y}} (neither [[Temporary skill boost|boostable]])',
        '*{{SCP|Crafting|36|link=yes}} (and {{SCP|Farming|30|link=yes}} for [[Ironman mode|Ironman accounts]])',
        '*{{SCP|Agility|70|link=y}}, {{SCP|Strength|70|link=y}}, {{SCP|Hitpoints|70|link=y}}, and {{SCP|Ranged|70|link=y}} (only Hitpoints is [[boostable]])',
        // Neither in brackets nor "to …" or "for …": what's needed with the level.
        '*{{SCP|Hunter|35|link=y}} with a [[butterfly net]] and [[butterfly jar|jar]]',
        '*{{SCP|Runecraft|42|link=y}} with 3+ [[Raiments of the Eye]] pieces',
      ],
      [
        '|2. Loot the [[Barrows chest]] while wearing any complete [[Barrows equipment|barrows set]].',
        '|',
        '*{{SCP|Defence|70|link=y}}{{boostable|no}} ',
        '*Various other skill requirements depending on the set used, none of which can be [[Temporary skill boost|boosted]]:',
        "**{{SCP|Attack|70|link=y}} and {{SCP|Magic|70|link=y}} for [[Ahrim the Blighted's equipment|Ahrim's]]",
        "**{{SCP|Ranged|70|link=y}} for [[Karil the Tainted's equipment|Karil's]]",
      ],
    ]);
    const [kill, barrows] = parseDiaryPage('Test', page);
    // A note on boosting says which can be boosted.
    expect(kill).toMatchObject({
      skills: [
        { skill: 'Prayer', level: 70, boostable: false, note: 'neither boostable' },
        { skill: 'Defence', level: 70, boostable: false, note: 'neither boostable' },
        { skill: 'Agility', level: 70, boostable: false, note: 'only Hitpoints is boostable' },
        { skill: 'Strength', level: 70, boostable: false },
        { skill: 'Hitpoints', level: 70, boostable: true },
        { skill: 'Ranged', level: 70, boostable: false },
      ],
      other: [
        'Crafting 36 (and Farming 30 for Ironman accounts)',
        'Hunter 35 with a butterfly net and jar',
        'Runecraft 42 with 3+ Raiments of the Eye pieces',
      ],
    });
    expect(barrows).toMatchObject({
      skills: [{ skill: 'Defence', level: 70, boostable: false, note: null }],
      other: [
        'Various other skill requirements depending on the set used, none of which can be boosted:',
        "Attack 70 and Magic 70 for Ahrim's",
        "Ranged 70 for Karil's",
      ],
    });
  });

  it('keeps a line mixing levels with other text as text, and reads a combat level', () => {
    // Lines from the Karamja and Lumbridge & Draynor diaries.
    const page = diaryPage('Hard', [
      [
        '|1. Enter the Kharazi Jungle.',
        '|',
        "*[[Machete]] or {{SCP|Agility|79|link=yes}}, and having started {{SCP|Quest}} [[Legends' Quest]] (if using the [[Kharazi Jungle]])",
        '*{{SCP|Combat|100|link=yes}}',
      ],
    ]);
    expect(parseDiaryPage('Karamja', page)).toEqual([
      {
        area: 'Karamja',
        tier: 'Hard',
        number: 1,
        task: 'Enter the Kharazi Jungle.',
        skills: [{ skill: COMBAT_LEVEL, level: 100, boostable: true, toStart: false, note: null }],
        quests: [],
        other: [
          "Machete or Agility 79, and having started Legends' Quest (if using the Kharazi Jungle)",
        ],
      },
    ]);
  });

  it('keeps a quest line with conditions as text, so nothing is dropped', () => {
    expect(task('Medium', 6)?.other).toEqual([
      'Completion of The Hand in the Sand (unless playing as Ultimate Ironman)',
      'Bucket',
    ]);
  });
});

/** An account for the diary checks: every level 99 unless said, and these quest states. */
const diaryAccount = (
  quests: Record<string, QuestStatus>,
  levels: Record<string, number> = {},
) => ({
  levels: levelsWith(levels),
  quests,
});

describe('checkDiaryTier', () => {
  it('says which tasks a quest not finished holds back', () => {
    const check = checkDiaryTier(
      ardougne(),
      'Easy',
      diaryAccount({ 'Rune Mysteries': 'not_started', Biohazard: 'finished' }),
    );
    expect(check.met).toBe(false);
    expect(check.tasks.slice(0, 3)).toEqual([
      {
        number: 1,
        task: 'Have Wizard Cromperty teleport you to the Rune Essence mine.',
        met: false,
      },
      { number: 2, task: 'Steal a cake from the Ardougne market stalls.', met: true },
      { number: 3, task: 'Sell Silk to Silk trader in Ardougne for 60 coins each.', met: true },
    ]);
    expect(check.quests).toEqual([
      { name: 'Rune Mysteries', need: 'finished', state: 'not_started', met: false },
      { name: 'Biohazard', need: 'finished', state: 'finished', met: true },
    ]);
    expect(check.unchecked).toContain('Task 3: Silk');
    expect(check.url).toBe('https://oldschool.runescape.wiki/w/Ardougne_Diary#Easy');
  });

  it('counts a quest that only has to be started once it is', () => {
    const quests: Record<string, QuestStatus> = { 'Sea Slug': 'in_progress' };
    expect(checkDiaryTier(ardougne(), 'Medium', diaryAccount(quests)).tasks[6]).toMatchObject({
      number: 7,
      met: true,
    });
    const notStarted = checkDiaryTier(
      ardougne(),
      'Medium',
      diaryAccount({ 'Sea Slug': 'not_started' }),
    );
    expect(notStarted.tasks[6]?.met).toBe(false);
    expect(notStarted.quests).toContainEqual({
      name: 'Sea Slug',
      need: 'started',
      state: 'not_started',
      met: false,
    });
  });

  it("can't check how far a quest to be partly done is while it's in progress", () => {
    const medium = (state: QuestStatus) =>
      checkDiaryTier(ardougne(), 'Medium', diaryAccount({ Watchtower: state }));
    const inProgress = medium('in_progress');
    expect(inProgress.tasks[8]).toMatchObject({ number: 9, met: true });
    expect(inProgress.unchecked).toContain(
      "Task 9: Watchtower partly done (it's in progress; how far can't be checked)",
    );
    expect(inProgress.quests).toContainEqual({
      name: 'Watchtower',
      need: 'partial',
      state: 'in_progress',
      met: false,
    });
    expect(medium('not_started').tasks[8]?.met).toBe(false);
    const finished = medium('finished');
    expect(finished.tasks[8]?.met).toBe(true);
    expect(finished.unchecked.filter((line) => line.startsWith('Task 9:'))).toEqual([
      'Task 9: Any light source and the Skavid map',
    ]);
  });

  it('checks a Runecraft level', () => {
    const check = checkDiaryTier(ardougne(), 'Hard', diaryAccount({}, { Runecraft: 1 }));
    expect(check.tasks.find((each) => each.number === 12)?.met).toBe(false);
    expect(check.skills).toContainEqual({
      skill: 'Runecraft',
      level: 65,
      boostable: true,
      toStart: false,
      note: null,
      have: 1,
      met: false,
    });
  });

  it('lists each skill the tier needs once, at its highest level', () => {
    const check = checkDiaryTier(ardougne(), 'Hard', diaryAccount({}, { Smithing: 65 }));
    expect(check.skills.filter((skill) => skill.skill === 'Smithing')).toEqual([
      {
        skill: 'Smithing',
        level: 68,
        boostable: true,
        toStart: false,
        note: null,
        have: 65,
        met: false,
      },
    ]);
    // Task 9 needs Smithing 68. Task 11 needs only 60, and its quest isn't in this account's
    // list, so that's left unchecked rather than counted as unmet.
    expect(check.tasks.find((each) => each.number === 9)?.met).toBe(false);
    expect(check.tasks.find((each) => each.number === 11)?.met).toBe(true);
    expect(check.unchecked).toContain("Task 11: Plague City (not in the account's quest list)");
  });

  it("refuses a tier whose tasks couldn't be read, rather than calling it met", () => {
    const withoutElite = ardougne().filter((each) => each.tier !== 'Elite');
    expect(() => checkDiaryTier(withoutElite, 'Elite', diaryAccount({}))).toThrow(
      expect.objectContaining({
        name: 'SourceError',
        message: 'OSRS Wiki: no Elite tasks could be read from the Ardougne Diary page',
      }),
    );
  });
});

describe('loadAllQuestRequirements', () => {
  it("reads every quest's requirements from one Bucket query, kept a day", async () => {
    const bucket = JSON.stringify({
      bucket: [
        { page_name: 'Dragon Slayer II', requirements: DS2_TEXT },
        { page_name: "Cook's Assistant", requirements: 'None' },
        { page_name: 'Rune Mysteries' },
      ],
    });
    const { ctx, urls } = await testWikiCtx(() => bucket);
    const all = await loadAllQuestRequirements(ctx);
    expect([...all.keys()]).toEqual(['Dragon Slayer II', "Cook's Assistant", 'Rune Mysteries']);
    expect(all.get('Dragon Slayer II')?.questPoints).toEqual({ need: 200, note: null });
    expect(all.get('Rune Mysteries')).toMatchObject({ skills: [], quests: [], other: [] });
    await loadAllQuestRequirements(ctx);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').searchParams.get('query')).toBe(
      "bucket('quest').select('page_name','requirements').limit(2000).run()",
    );
  });

  it('parses each copy kept once', async () => {
    const { ctx, later } = await testWikiCtx(() => JSON.stringify({ bucket: SAMPLE }));
    const first = await loadAllQuestRequirements(ctx);
    expect(await loadAllQuestRequirements(ctx)).toBe(first);
    // A day on, the query is asked again, and its answer parsed again.
    later(DAY_MS);
    const next = await loadAllQuestRequirements(ctx);
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
    const points = await loadQuestPoints({ ...ctx, req: questListReq() });
    expect(await loadQuestPoints({ ...ctx, req: questListReq() })).toBe(points);
  });

  it('finds a quest by its name as the account or the AI writes it', async () => {
    const { ctx } = await testWikiCtx(() => JSON.stringify({ bucket: SAMPLE }));
    const all = await loadAllQuestRequirements(ctx);
    expect(findQuestReqs(all, 'dragon slayer i')?.quest).toBe('Dragon Slayer I');
    expect(findQuestReqs(all, 'Vale Totems')?.quest).toBe('Vale Totems (miniquest)');
    expect(findQuestReqs(all, 'Dragon Slayer III')).toBeUndefined();
    // A part of Recipe for Disaster by the game's name for it.
    const part = 'Recipe for Disaster/Freeing Pirate Pete';
    const parts = new Map([[part, parseQuestRequirements(part, '')]]);
    expect(findQuestReqs(parts, 'Recipe for Disaster - Pirate Pete')?.quest).toBe(part);
  });
});

describe('loadQuestPoints', () => {
  it("reads each quest's points from the wiki's quest list, kept a day, a quest made of parts by its parts", async () => {
    const { ctx, urls } = await testWikiCtx(() => fixture('wiki/parse-quests-list.json'));
    const points = await loadQuestPoints(ctx);
    expect(Object.fromEntries(points)).toEqual({
      'Dragon Slayer I': 2,
      "Cook's Assistant": 1,
      'Dream Mentor': 2,
      'Monkey Madness II': 4,
      'Dragon Slayer II': 5,
      "Recipe for Disaster/Another Cook's Quest": 1,
      'Recipe for Disaster/Freeing Pirate Pete': 1,
    });
    await loadQuestPoints(ctx);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').searchParams.get('page')).toBe('Quests/List');
  });

  it('leaves out a row whose points cell is no number', async () => {
    const header =
      '<tr><th>Name</th><th><span class="scp" data-skill="Quest points"></span></th></tr>';
    const rows =
      '<tr data-rowid="Cook&#39;s Assistant"><td>Cook\'s Assistant</td><td>1</td></tr>' +
      '<tr data-rowid="Future Quest"><td>Future Quest</td><td>TBA</td></tr>';
    const page = JSON.stringify({
      parse: { title: 'Quests/List', text: `<table>${header}${rows}</table>` },
    });
    const { ctx } = await testWikiCtx(() => page);
    expect(Object.fromEntries(await loadQuestPoints(ctx))).toEqual({ "Cook's Assistant": 1 });
  });

  it("is a SourceError when the list's quest points can't be read", async () => {
    const page = JSON.stringify({
      parse: { title: 'Quests/List', text: '<table><tr><th>Name</th></tr></table>' },
    });
    const { ctx } = await testWikiCtx(() => page);
    await expect(loadQuestPoints(ctx)).rejects.toMatchObject({
      name: 'SourceError',
      message: "OSRS Wiki: the quest points couldn't be read from Quests/List",
    });
  });
});

describe('questPointsOf', () => {
  it('adds up the points of the quests finished, Recipe for Disaster by its parts', () => {
    const points = new Map([
      ['Dragon Slayer I', 2],
      ["Cook's Assistant", 1],
      ['Dragon Slayer II', 5],
      ['Recipe for Disaster/Freeing Pirate Pete', 1],
      ["Recipe for Disaster/Another Cook's Quest", 1],
    ]);
    expect(
      questPointsOf(
        {
          'Dragon Slayer I': 'finished',
          'Cook’s Assistant': 'finished',
          'Dragon Slayer II': 'in_progress',
          'Recipe for Disaster': 'finished',
          'Recipe for Disaster - Pirate Pete': 'finished',
          "Recipe for Disaster - Another Cook's Quest": 'not_started',
          // A miniquest has none.
          'Barbarian Training': 'finished',
        },
        points,
      ),
    ).toBe(4);
  });
});

describe('loadDiaryPage', () => {
  it("reads one diary's tasks from its page", async () => {
    const { ctx, urls } = await testWikiCtx((url) => {
      const page = url.searchParams.get('page') ?? '';
      return JSON.stringify({ parse: { title: page, revid: 1, wikitext: ARDOUGNE } });
    });
    expect(await loadDiaryPage(ctx, 'Ardougne')).toEqual(ardougne());
    expect(urls.map((url) => new URL(url).searchParams.get('page'))).toEqual(['Ardougne Diary']);
  });

  it("keeps each diary's tasks apart, worked out once per copy of its page", async () => {
    const { ctx, urls } = await testWikiCtx((url) => {
      const page = url.searchParams.get('page') ?? '';
      // Varrock's page has no task table the parser knows.
      const wikitext = page === 'Ardougne Diary' ? ARDOUGNE : '';
      return JSON.stringify({ parse: { title: page, revid: 1, wikitext } });
    });
    const tasks = await loadDiaryPage(ctx, 'Ardougne');
    expect(await loadDiaryPage(ctx, 'Varrock')).toEqual([]);
    expect(await loadDiaryPage(ctx, 'Ardougne')).toBe(tasks);
    expect(urls).toHaveLength(2);
  });
});
