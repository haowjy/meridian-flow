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
    note: "Youngest warden in Harl’s history. Accused of burning the town’s grain. Says he didn’t.",
    pitch: "He still has to prove he didn’t do it.",
    lastLine:
      "My name is Tam. I did not burn the grain. I walked out of the fire, and nobody believed that either.",
    lead: "Tam is the youngest warden in Harl’s history, condemned for burning the town’s grain.",
    facts: [
      ["Age", "24"],
      ["Homeland", "Harl, a river town in the south"],
      ["Allegiance", "None since the trial"],
      ["Occupation", "Warden of the Harl woods and grain road"],
      ["Abilities", "Archery, tracking"],
      ["Sent by", "The magistrate of Harl"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Lean and sunburnt, a head shorter than Sigrun. Wears the warden’s green coat with the badge cut off.",
      ],
      [
        "Personality",
        "Trusts people too fast. Counts things when he’s scared. Tells the truth badly, which is why nobody believed him.",
      ],
      [
        "Abilities",
        "The best shot of the four and the quietest walker. He scouts, tracks and keeps the party fed. Up close he’s only adequate.",
      ],
      [
        "History",
        [
          [
            "Early life",
            "A miller’s orphan, raised at the mill on the Harl. He won the crown’s archery at seventeen, and the town made him warden at twenty.",
          ],
          [
            "The granary",
            "It burned in a hungry winter with the whole harvest inside. As warden, Tam held the only key. He ran north before the hearing and was caught at the border, where the magistrate offered him the beast instead of the rope. He still isn’t sure he put the lamp out that night.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Sigrun", "Teaching him to fight up close. He thinks she likes him."],
          ["Oskar", "Owes him eleven silver, according to Oskar."],
          ["Maren", "Stitched his arm after the wolves. The only one who has asked if he did it."],
        ],
      ],
      [
        NOTES,
        [
          [
            "Secret",
            "He can’t read. He signed the grain ledger that week without knowing it showed the stores already sold.",
          ],
          ["If he survives", "He goes home to find who emptied the granary before it burned."],
        ],
      ],
    ],
  },
  {
    key: "sigrun",
    name: "Sigrun",
    note: "Sent by the northern clans. She killed a jarl and won’t say why.",
    pitch: "She still hasn’t said why.",
    lastLine:
      "My name is Sigrun. I killed a jarl, and I will tell you why. I walked out of the fire because I had not finished.",
    lead: "Sigrun held the bridge at Ansgard alone, and was Jarl Hakon’s sworn guard until she killed him at his own table.",
    facts: [
      ["Age", "34"],
      ["Homeland", "The northern fjords"],
      ["Allegiance", "Clan Vard"],
      ["Occupation", "Sworn guard to Jarl Hakon"],
      ["Abilities", "Axe and shield"],
      ["Sent by", "The clan moot"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Tall, going grey early, with her left ear missing. Wears a mail shirt patched with rings from three clans.",
      ],
      [
        "Personality",
        "Says little. Sleeps sitting up and takes the worst watch without being asked.",
      ],
      [
        "Abilities",
        "The best fighter of the four. She lets the other side make the first mistake, then ends it in a blow or two.",
      ],
      [
        "History",
        [
          [
            "Early life",
            "Born to Clan Vard. She joined Hakon’s guard at twenty-two and carried his shield in three wars.",
          ],
          [
            "Ansgard",
            "She held the bridge alone for a morning until the clans came up. They still sing about it.",
          ],
          [
            "The feast",
            "At midwinter she stood up, killed Hakon in front of forty witnesses and sat back down. The moot can’t hang a sworn guard without a reason, and she won’t give one, so it gave her the beast.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Tam", "Teaching him to stop running."],
          ["Oskar", "Sits where she can see his hands."],
          ["Maren", "The only one she lets stand behind her."],
          ["Family", "A daughter of nine, raised by her sister."],
        ],
      ],
      [
        NOTES,
        [
          ["Secret", "Hakon had promised her daughter to a southern lord to settle a debt."],
          ["If she survives", "She goes south to find the lord."],
        ],
      ],
    ],
  },
  {
    key: "oskar",
    name: "Oskar",
    note: "Stormcaller, sent by the king of the coast. He sold a fleet. Two fingers short.",
    pitch: "He’d sell this story to anyone.",
    lastLine:
      "My name is Oskar. I have sold everything I ever owned. I walked out of the fire and started looking for a buyer.",
    lead: "Oskar was stormcaller to the king’s fleet and the hero of Selle Sound, until he sold its sailing dates to the enemy.",
    facts: [
      ["Age", "51"],
      ["Homeland", "Port Selle, on the coast"],
      ["Allegiance", "Whoever is paying"],
      ["Occupation", "Stormcaller to the king’s fleet"],
      ["Abilities", "Wind and lightning"],
      ["Sent by", "The king of the coast"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Broad and soft around the middle, with a well-kept beard. Two fingers gone from his right hand. Keeps the king’s ring on a cord.",
      ],
      [
        "Personality",
        "Charming, tired and always bargaining. Keeps a small ledger of what the others owe him, and it’s usually right.",
      ],
      [
        "Abilities",
        "Calls storms with both hands. Since he lost the fingers they come bigger and harder to aim. Carries a boarding sword, and has been known to pay the other side to leave.",
      ],
      [
        "History",
        [
          ["Early life", "A chandler’s son, born able to pull wind out of a clear sky."],
          [
            "Selle Sound",
            "He won the battle with one storm, and the king knighted him on the deck.",
          ],
          [
            "Cape Ansel",
            "He sold the sailing dates, and twenty-two ships burned. The king’s men took two fingers while they asked who else knew. A public trial would have shamed the crown, so the king sent him north.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Tam", "Lends him money, mostly to see if he pays it back."],
          ["Sigrun", "Afraid of her, and says so."],
          ["Maren", "Asks her to look at his hand every night. It doesn’t need it."],
        ],
      ],
      [
        NOTES,
        [
          ["Secret", "The enemy held his son. He has heard nothing since the ships burned."],
          ["If he survives", "He goes looking for his son with no fleet and no name."],
        ],
      ],
    ],
  },
  {
    key: "maren",
    name: "Maren",
    note: "Healer and ward-mage, sent by the abbey at Vell for heresy. She doesn’t flinch at fire.",
    pitch: "The fire didn’t burn her.",
    lastLine:
      "My name is Maren. I walked out of the fire, and it did not burn me. I have stopped telling people that.",
    lead: "Maren is a healer and ward-mage who saved the queen from the red fever, then was tried for heresy by her own abbey.",
    facts: [
      ["Age", "29"],
      ["Homeland", "The abbey at Vell, in the mountains"],
      ["Allegiance", "The abbey, until the trial"],
      ["Occupation", "Infirmarian"],
      ["Abilities", "Wards, healing"],
      ["Sent by", "The abbess of Vell"],
      ["First appears", "Prologue"],
    ],
    sections: [
      [
        "Appearance",
        "Small, with a shaved head and abbey grey. No burns anywhere, not even old ones.",
      ],
      [
        "Personality",
        "Calm and blunt, with a dark sense of humour. Looks straight at what other people look away from.",
      ],
      [
        "Abilities",
        "She can hold a shield of light over all four for about as long as she can hold her breath, and close a wound while it’s still bleeding. Good with her staff, which surprises people.",
      ],
      [
        "History",
        [
          ["Early life", "Left at the abbey gate as a baby. She ran the infirmary by twenty-two."],
          [
            "The red fever",
            "She nursed the queen through it and was expected to be the next abbess.",
          ],
          [
            "The fire",
            "The infirmary burned and she went back in for the patients. She walked out with her habit gone and no mark on her skin. When she told the village that fire wasn’t God’s judgement, the abbey tried her and gave her the north as penance. She has been trying to work out why she didn’t burn ever since.",
          ],
        ],
      ],
      [
        "Relationships",
        [
          ["Tam", "The first to thank her."],
          ["Sigrun", "Stands behind her in every fight."],
          ["Oskar", "Knows his hand doesn’t need looking at, and looks anyway."],
        ],
      ],
      [
        NOTES,
        [
          ["Secret", "She was born in the Greenlands. She doesn’t know."],
          ["If she survives", "She finds out the dragon won’t attack her."],
        ],
      ],
    ],
  },
];

export const BEAST_PAGE: WikiPage = {
  lead: "The reason they were sent north. Nobody who went under the Cold Fire has come back to say what it is.",
  facts: [
    ["Range", "The Greenlands"],
    ["Seen by", "Nobody living"],
    ["First appears", "Prologue"],
  ],
  sections: [],
};

export const DRAGON_PAGE: WikiPage = {
  lead: "The beast in the Greenlands. Nobody who went north was told what it was.",
  facts: [
    ["Status", "Alive"],
    ["Kind", "Green dragon"],
    ["Range", "The Greenlands"],
    ["First appears", "Prologue"],
  ],
  sections: [
    ["Appearance", "Green-black and longer than a longship, with a spined back and a barbed tail."],
    ["Abilities", "Flies, and breathes fire that burns blue at the centre and green at the edge."],
    [
      "History",
      "Every country in this story has sent people north to kill it. None of them came back.",
    ],
    [
      NOTES,
      [
        ["Secret", "It has never once left the Greenlands. Nobody has asked why."],
        ["Undecided", "Whether it’s the last one."],
      ],
    ],
  ],
};

export const characterName = (key: CharacterKey) =>
  CHARACTERS.find((character) => character.key === key)?.name ?? "";

export const PROLOGUE = {
  opening: "They sent us to the Greenlands to kill the beast under the Cold Fire.",
  lines: [
    "Each of us had been condemned by our own country. Kill it, they said, and our “crimes” would be forgiven.",
    "Nobody who went under the Cold Fire had ever come back to say what the beast was.",
    "Every night the sky burned green above us. We thought it was beautiful.",
  ],
  turn: "On the ninth night, the beast found us.",
} as const;

export const QUESTION =
  "This is the prologue. Only one of them survives it and becomes the protagonist. Who is it?";

export const ALIVE = "Alive";
export const SURVIVED = "Alive, protagonist";
export const FELL = "Died in the prologue";

export const museReply = (key: CharacterKey) =>
  `The prologue ends with ${characterName(key)} now, and all four pages are up to date.`;
