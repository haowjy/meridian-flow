/** The prologue on the page, and the choice that ends it. */

export type CharacterKey = "tam" | "sigrun" | "oskar" | "maren";

type Fact = readonly [label: string, value: string];
type Part = readonly [label: string, text: string];
type Section = readonly [heading: string, body: string | readonly Part[]];

/** A Knowledge Base page in plain Markdown: a lead, a list of facts and sections, writer's notes last. */
export type WikiPage = {
  lead: string;
  facts: readonly Fact[];
  sections: readonly Section[];
};

type Character = WikiPage & {
  key: CharacterKey;
  name: string;
  /** The line beside them when they join the party. */
  note: string;
  /** Why the visitor might pick them. */
  pitch: string;
  /** The prologue's last line once they are the one who lived. */
  lastLine: string;
};

/** Hidden until the reveal: these name the dragon and who survives. */
export const NOTES = "Writer’s notes";

export const CHARACTERS: readonly Character[] = [
  {
    key: "tam",
    name: "Tam",
    note: "Seventeen and Level 58: the strongest human his age ever recorded.",
    pitch: "The prodigy who has never failed at anything.",
    lastLine: "That’s it? I was just getting good at this.",
    lead: "Tam is a farm boy from Harl who reached Level 58 at seventeen, higher than anyone his age has ever been.",
    facts: [
      ["Race", "Human"],
      ["Age", "17"],
      ["Level", "58"],
      ["Skill", "[Spark]"],
      ["Homeland", "Harl, the southern lowlands"],
      ["Sent by", "The king of Harl"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Short and sunburnt. Burn scars run from his right hand to the elbow, from the first time [Spark] came, and he holds that arm a little away from his body.",
      ],
      [
        "Personality",
        "Talks when he’s nervous and laughs when he isn’t. Trusts people before they’ve earned it.",
      ],
      [
        "Abilities",
        "[Spark] puts fire into anything he can touch or throw at. It won’t catch in deep cold, so on the ice he fights with a knife, badly.",
      ],
      [
        "History",
        [
          [
            "Early life",
            "His father farms barley on the cliffs above the river. Tam worked the fields until his first skill came.",
          ],
          [
            "The court",
            "Eighteen months from farm boy to Level 58. The king named him before the whole court, and he went red to the ears.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Sigrun", "Told him his arm would ache in the cold. It did."],
          ["Maren", "Describes things to her. He’s bad at it, and she likes it."],
          ["Oskar", "Asks about the ear every day."],
        ],
      ],
      [
        NOTES,
        [
          [
            "Secret",
            "The king didn’t send Tam only to kill the beast. He wants to know how strong a boy can get under the Cold Fire, and what made him that way.",
          ],
          ["Wants", "To buy his father the field next to theirs. He has already picked it out."],
        ],
      ],
    ],
  },
  {
    key: "sigrun",
    name: "Sigrun",
    note: "Champion of the holds. She cuts her wards into her own arms.",
    pitch: "Her ward turns one blow. She has to choose which.",
    lastLine: "One more stroke and that rune would have held.",
    lead: "Sigrun is the champion of the dwarven holds, a runesmith who carves her wards into her own forearms.",
    facts: [
      ["Race", "Dwarf"],
      ["Age", "140"],
      ["Level", "74"],
      ["Skill", "[Ward Rune]"],
      ["Homeland", "The Ninth Hold, Ansgard"],
      ["Sent by", "The council of the holds"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Built like a millstone, beard frozen to her collar on the ice. Both forearms are scarred from wrist to elbow in rows of runes, the newest still scabbed.",
      ],
      ["Personality", "Says little and means all of it. Believes nothing without bones."],
      [
        "Abilities",
        "[Ward Rune]: each rune turns exactly one blow, then goes dark until she cuts another. She can cut one mid-fight. A shield can be dropped; an arm can’t.",
      ],
      [
        "History",
        "Champion of the holds for forty years. She lives with her sister above the watch-ledge of the Ninth Hold.",
      ],
      [
        "Relationships",
        [
          ["Tam", "Walked him away from the frozen army by his collar."],
          ["Maren", "Stands in front of her in every fight."],
          ["Oskar", "Doesn’t believe his song. Listens to it anyway."],
        ],
      ],
      [
        NOTES,
        [
          [
            "Secret",
            "The sealed letter from the Ninth Hold orders her to bring back the beast’s heart, whatever it costs the others.",
          ],
        ],
      ],
    ],
  },
  {
    key: "maren",
    name: "Maren",
    note: "The queen of Vell’s healer. Blind for a thousand years.",
    pitch: "She has never seen anything. Not even a box.",
    lastLine: "So that’s what fire looks like.",
    lead: "Maren has been the queen of Vell’s healer for nine hundred years, and blind since she was six.",
    facts: [
      ["Race", "Elf"],
      ["Age", "1,040"],
      ["Level", "70"],
      ["Skill", "[Mending Hymn]"],
      ["Homeland", "Vell, the forest"],
      ["Sent by", "The queen of Vell"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Small and straight-backed, with white eyes and the queen’s ring on a cord around her neck.",
      ],
      [
        "Personality",
        "Patient, exact and hard to surprise. Listens a long time before she speaks.",
      ],
      [
        "Abilities",
        "[Mending Hymn]: while she sings, a wound closes, and she can sing a long time. She hears the ground, and knows a crevasse by the sound of the snow over it.",
      ],
      [
        "History",
        [
          [
            "Childhood",
            "Went blind at six. The System has read her every box since, in a voice that sounds like her mother’s.",
          ],
          [
            "The queen’s healer",
            "Elves level slowly. Nine hundred years at court took her to Level 70.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Tam", "Lets him describe things to her."],
          ["Sigrun", "Trusts her to stand in front."],
          ["Oskar", "Asked him to sing the last verse again."],
        ],
      ],
      [
        NOTES,
        [
          [
            "Secret",
            "She heard the Kessa song once before, in Vell, the year she went blind. She means to tell the queen she was right about it.",
          ],
        ],
      ],
    ],
  },
  {
    key: "oskar",
    name: "Oskar",
    note: "Kessa guide. The only one who has walked to the ice and back.",
    pitch: "He believed the songs.",
    lastLine: "The song was true, and there’s no one left to sing it.",
    lead: "Oskar is a bear-blooded Kessa guide, and the only living person who has walked to the edge of the ice and come back.",
    facts: [
      ["Race", "Beastkin, bear-blooded"],
      ["Age", "38"],
      ["Level", "66"],
      ["Skill", "[Sense Fear]"],
      ["Homeland", "The Kessa steppe"],
      ["Sent by", "The clan mothers"],
      ["First appears", "Prologue"],
    ],
    sections: [
      ["Appearance", "Twice Sigrun’s height. Half his left ear is gone."],
      ["Personality", "Quiet, dry, patient with Tam. Changes the subject with food."],
      [
        "Abilities",
        "[Sense Fear]: he hears an animal’s fear a breath before it moves, and the choice right behind it. He calls the fights.",
      ],
      [
        "History",
        "Guided hunters to the edge of the Greenlands for twenty years. He came back from the last trip alone, without half his ear, and won’t say what took it.",
      ],
      [
        "Relationships",
        [
          ["Tam", "Answers every question about the ear with “Eat your food.”"],
          ["Sigrun", "She doesn’t believe him. He doesn’t argue."],
          ["Maren", "Sang her the last verse again."],
        ],
      ],
      [
        NOTES,
        [
          [
            "Secret",
            "He has seen the beast once before, asleep in the ice. That is what took his ear, and why the clan mothers believed the song.",
          ],
        ],
      ],
    ],
  },
];

export const BEAST_PAGE: WikiPage = {
  lead: "Whatever is breathing the Cold Fire. Every army sent north to find it is listed as Missing.",
  facts: [
    ["Tag", "None"],
    ["Level", "Unknown"],
    ["Range", "The ice north of the Kessa steppe"],
    ["First appears", "Prologue"],
  ],
  sections: [],
};

export const DRAGON_PAGE: WikiPage = {
  lead: "The beast in the ice is a dragon. Its breath is the Cold Fire, and it eats light.",
  facts: [
    ["Status", "Alive"],
    ["Tag", "None"],
    ["Level", "Unknown"],
    ["Range", "An ice basin under the brightest of the Cold Fire"],
    ["First appears", "Prologue"],
  ],
  sections: [
    [
      "Appearance",
      "The size of a hill. Its eye is as big as a door, and green inside, like the sky.",
    ],
    [
      "Abilities",
      "Breathes the Cold Fire into the sky. Where the breath goes, the light goes out of the air. Afraid of its left foot.",
    ],
    ["Wounds", "Lost an eye to Tam’s spark on the ninth night."],
    [
      "History",
      "The Kessa song says it sleeps in the ice, wakes when the sky burns, breathes the sky cold and eats the sun. Everyone but the Kessa called it a myth.",
    ],
    [
      NOTES,
      [
        [
          "Secret",
          "It isn’t what spreads the Cold Fire. Something is drawing the light north through it.",
        ],
        ["Undecided", "Why the System can’t see it."],
      ],
    ],
  ],
};

/** The Knowledge Base's World folder, after The Beast. */
export const WORLD_PAGES: readonly { key: string; name: string; page: WikiPage }[] = [
  {
    key: "coldfire",
    name: "The Cold Fire",
    page: {
      lead: "The green light that came over the north on a clear night in spring, seen in every country at once.",
      facts: [
        ["First seen", "The first night of spring"],
        ["Spreads", "South, a little further each night"],
        ["Effect", "The sun rises colder"],
        ["First appears", "Prologue"],
      ],
      sections: [
        [
          "Effects",
          "By the tenth day the barley in Harl had stopped growing. By the twentieth there was frost on the river at noon. The scholars agree on one thing: it eats the light.",
        ],
        [NOTES, [["Cause", "The dragon’s breath."]]],
      ],
    },
  },
  {
    key: "armies",
    name: "The First Armies",
    page: {
      lead: "The armies sent north before the four. None of them came back.",
      facts: [
        ["Harl", "Two thousand spears under the king’s banner"],
        ["Ansgard", "A hold’s whole garrison"],
        ["Vell", "Its rangers"],
        ["The Kessa", "Every hunter who would go"],
        ["System status", "Missing"],
      ],
      sections: [
        [
          "Found",
          "Harl’s army sits in the snow five days north of the last Kessa camp, in ranks, spears across their knees, frosted over like fur. They didn’t fight anything. The System still hasn’t decided they’re dead.",
        ],
        [NOTES, [["Undecided", "Whether someone could stop them leaving."]]],
      ],
    },
  },
  {
    key: "system",
    name: "The System",
    page: {
      lead: "Levels, skills and tags. Everyone has had them for as long as anyone remembers.",
      facts: [
        ["Who has it", "Everyone"],
        ["Tags", "Every living thing, except the beast"],
        ["Boxes", "Blue; read aloud to anyone who can’t see"],
        ["Status", "Alive, Missing or Dead"],
      ],
      sections: [
        [
          "Levels",
          "The strongest means the highest level alive. Elves level slowly; a seventeen-year-old at 58 is a record.",
        ],
        [
          "Skills",
          "A first skill comes at a moment of need. Every skill box names where it came from: [Source: practice], [Source: bloodline], [Source: rune]. No box in recorded history has said [Source: unknown].",
        ],
        [
          "What it never says",
          "Levels, skills, tags and cores, and nothing else. No quests, no tutorials, no instructions. It has never told anyone what to do.",
        ],
        [
          NOTES,
          [
            ["Secret", "Something has taken hold of it. It wrote “Tutorial complete.”"],
            ["Undecided", "What took hold, and what it wants."],
          ],
        ],
      ],
    },
  },
  {
    key: "song",
    name: "The Kessa Song",
    page: {
      lead: "A long Kessa song, mostly about weather. The last verse is about a dragon in the ice.",
      facts: [
        ["Sung by", "The Kessa, and Oskar on the march"],
        ["Believed by", "The Kessa"],
      ],
      sections: [
        [
          "The last verse",
          "It sleeps in the ice and wakes when the sky burns, and breathes the sky cold, and eats the sun.",
        ],
        [NOTES, [["Note", "There is no verse about boxes."]]],
      ],
    },
  },
];

/** The Knowledge Base's Places folder, in the order the road north passes them. */
export const PLACE_PAGES: readonly { key: string; name: string; page: WikiPage }[] = [
  {
    key: "harl",
    name: "Harl",
    page: {
      lead: "The human lowlands, furthest south: river towns, barley, and a king who keeps count of everyone’s level.",
      facts: [
        ["People", "Humans"],
        ["Ruled by", "The king"],
        ["Known for", "Barley, the Rolls"],
        ["Sent north", "Tam"],
      ],
      sections: [
        [
          "The Rolls",
          "Every spring the king’s clerks walk the villages reading tags and write down every subject’s level. In Harl, rank follows level more than birth, and a high-level commoner is taken into the king’s service whether they want to go or not.",
        ],
        [
          "Under the Cold Fire",
          "The barley stopped growing by the tenth day. Harl has the most mouths and the least grain stored. It sent the largest army north and lost it.",
        ],
        [
          NOTES,
          [
            [
              "Secret",
              "If the beast dies, Tam is the strongest person in Harl after the king. The court has already argued about whether to allow it.",
            ],
          ],
        ],
      ],
    },
  },
  {
    key: "ansgard",
    name: "Ansgard",
    page: {
      lead: "The dwarven holds, twelve of them, cut into the mountains between Harl and the north.",
      facts: [
        ["People", "Dwarves"],
        ["Ruled by", "The Moot of hold-masters"],
        ["Known for", "Runes, cores, the bone-halls"],
        ["Sent north", "Sigrun, of the Ninth Hold"],
      ],
      sections: [
        [
          "The bone-halls",
          "Dwarves keep every bone they dig up. The bone-halls hold a labelled skeleton of every creature that has ever lived in the mountains, and not one of them is a dragon.",
        ],
        [
          "Cores",
          "When a creature with a tag dies, the System leaves a core in its chest, priced by its level. Ansgard’s runesmithing runs on them.",
        ],
        [
          NOTES,
          [
            [
              "Secret",
              "A beast with no tag has a core nobody has ever priced. The Moot wants it more than it wants the other three alive.",
            ],
          ],
        ],
      ],
    },
  },
  {
    key: "vell",
    name: "Vell",
    page: {
      lead: "The elven forest north of the mountains, so old that sound carries differently in it.",
      facts: [
        ["People", "Elves"],
        ["Ruled by", "The queen, for as long as records go back"],
        ["Known for", "The Long Archive"],
        ["Sent north", "Maren, the queen’s healer"],
      ],
      sections: [
        [
          "The Long Archive",
          "The oldest written record in the world, kept by the queen under the roots of the oldest trees.",
        ],
        [
          "Under the Cold Fire",
          "The trees went on as if nothing had happened. That frightened the elves more than frost would have.",
        ],
        [
          NOTES,
          [
            [
              "Secret",
              "The queen sang Maren the Kessa song’s last verse a thousand years ago, the year Maren went blind.",
            ],
          ],
        ],
      ],
    },
  },
  {
    key: "steppe",
    name: "The Kessa Steppe",
    page: {
      lead: "Open grass and wind between the forest and the ice. The Kessa have no king and no army, and write nothing down.",
      facts: [
        ["People", "The Kessa, beastkin"],
        ["Ruled by", "The clan mothers"],
        ["Bloodlines", "Bear, wolf, elk, hare"],
        ["Sent north", "Oskar, bear-blooded"],
      ],
      sections: [
        [
          "The songs",
          "Kessa history, law and maps are sung. A song changes only when the world does.",
        ],
        [
          "The last camp",
          "The furthest north any clan pitches its tents. Nine days on is the basin where the beast lies.",
        ],
      ],
    },
  },
  {
    key: "greenlands",
    name: "The Greenlands",
    page: {
      lead: "The Kessa name for the ice north of the steppe. On summer nights the ice glows faintly green under the snow.",
      facts: [
        ["People", "None"],
        ["Tags seen", "Frost wolves"],
        ["Furthest anyone has gone", "Oskar, once"],
      ],
      sections: [
        ["The edge", "Guides take hunters as far as the edge. Nobody goes further."],
        [
          NOTES,
          [
            [
              "Secret",
              "The green under the ice is the beast’s breath. It has been there the whole time.",
            ],
          ],
        ],
      ],
    },
  },
];

/** The writer's page of everything the reader doesn't know yet, at the Knowledge Base's root. */
export const SPOILERS_PAGE: WikiPage = {
  lead: "What the reader doesn’t know yet, what the characters don’t, and what isn’t decided.",
  facts: [
    ["Series", "The Long Reckoning"],
    ["Genre", "LitRPG, time loop"],
    ["Arc 1", "Nine Days"],
    ["Drafting", "Prologue"],
  ],
  sections: [
    [
      "The loop",
      [
        [
          "Trigger:",
          "The last one standing wakes on the first night of the Cold Fire with [Rekindle], forty days before the ninth night.",
        ],
        ["What carries over:", "Memory, and what they’ve learned to do. Levels reset."],
        [
          "Everyone else:",
          "Alive again, and has never met them. The beast doesn’t remember either.",
        ],
        ["When it ends:", "When the beast dies. [Tutorial cleared]"],
      ],
    ],
    [
      "Who took hold of the System",
      "Something wrote “Tutorial complete.” and gave the survivor Rekindle, and it wants the beast dead. It is the serial’s long mystery. Undecided: something from outside the world, or the System waking to what it was built for.",
    ],
    [
      "The beast",
      [
        [
          "The Cold Fire:",
          "Its breath, but it isn’t what spreads it. Something is drawing the light north through it. Arc 1’s midpoint.",
        ],
        [
          "The Greenlands:",
          "The green under the ice is its breath, asleep. It has been there the whole time.",
        ],
        ["Undecided:", "Why the System can’t see it, and whether it has woken before."],
      ],
    ],
    [
      "What each of the four hides",
      [
        [
          "Tam:",
          "If the beast dies, he is the strongest person in Harl after the king, and the court has argued about whether to allow it.",
        ],
        [
          "Sigrun:",
          "The Moot’s sealed letter orders her to bring back the beast’s heart, whatever it costs the others.",
        ],
        [
          "Maren:",
          "The queen sang her the Kessa song’s last verse a thousand years ago. Vell knew.",
        ],
        ["Oskar:", "He has seen the beast before, asleep in the ice. That is what took his ear."],
      ],
    ],
    [
      "The world",
      [
        [
          "The System:",
          "Has never given a quest, a tutorial or an instruction. “Tutorial complete.” is the first box in history to talk about a game, and Rekindle the first skill with [Source: unknown].",
        ],
        [
          "Cores:",
          "A beast with no tag has a core nobody has ever priced. That is why Ansgard wants the heart.",
        ],
      ],
    ],
    [
      "After the kill",
      "Arc 2, The Game. The morning after, the System changes for everyone: new boxes, new rules, quests nobody understands. The world thinks the four saved it. The survivor knows the beast was the tutorial.",
    ],
  ],
};

export const characterName = (key: CharacterKey) =>
  CHARACTERS.find((character) => character.key === key)?.name ?? "";

export const PROLOGUE = {
  opening: "The Cold Fire came on a clear night in spring, and every country saw it.",
  lines: [
    "Every night it reached a little further south, and the sun came up a little colder.",
    "Four peoples sent their strongest north to kill whatever was breathing it.",
    "We were the four.",
  ],
  turn: "On the ninth night, we found it. It was a dragon.",
} as const;

export const QUESTION =
  "This is the prologue. Only one of them survives it and becomes the protagonist. Who is it?";

export const ALIVE = "Alive";
export const SURVIVED = "Alive, protagonist";
export const FELL = "Died in the prologue";

export const museReply = (key: CharacterKey) =>
  `The prologue ends with ${characterName(key)} now, and all four pages are up to date.`;

/** The end, after the Rekindle window. */
export const END = {
  question: "What will you write?",
  placeholder: "A farm boy, a dragon, and nine days north…",
  start: "Start writing →",
} as const;

/** The System's windows: the twist, the card when the visitor doesn't pick, and the end. */
export const SYSTEM = {
  tutorial: "Tutorial complete.",
  assigned: (key: CharacterKey) => `[No selection. Survivor assigned: ${characterName(key)}.]`,
  skill: ["[Unique skill acquired: Rekindle]", "[Source: unknown]"],
  rekindle: "Rekindle",
} as const;
