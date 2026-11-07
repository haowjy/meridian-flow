/** The prologue on the page, and the choice that ends it. */

export type CharacterKey = "tam" | "sigrun" | "oskar" | "maren";

type Character = {
  key: CharacterKey;
  name: string;
  note: string;
  /** Why the visitor might pick them. */
  pitch: string;
  facts: ReadonlyArray<readonly [label: string, value: string]>;
  sections: ReadonlyArray<readonly [heading: string, text: string]>;
  /** The prologue's last line once they are the one who lived. */
  lastLine: string;
};

export const CHARACTERS: readonly Character[] = [
  {
    key: "tam",
    name: "Tam",
    note: "Mill boy from Harl. Accused of burning the town’s grain. Says he didn’t.",
    pitch: "He still has to prove he didn’t do it.",
    facts: [
      ["Age", "16"],
      ["From", "Harl, a river town in the south"],
      ["Trade", "Miller’s apprentice"],
      ["Sent by", "The magistrate of Harl"],
      ["Carries", "A hatchet and a sling"],
    ],
    sections: [
      [
        "Before",
        "Raised by his uncle at the mill after the river took his parents. Can’t read, but he can weigh a sack by hand and tell you the price of grain in any month of the last ten years.",
      ],
      [
        "How he got here",
        "The town granary burned in a hungry winter with the whole harvest inside. Tam held the only key that night. He ran north before the hearing and was caught at the border, where the magistrate offered him the beast instead of the rope.",
      ],
      [
        "How he fights",
        "Never trained. He’s small and quick, throws straight, and runs first. Sigrun is teaching him to stop running.",
      ],
      [
        "Personality",
        "Trusts people too fast. Counts things when he’s scared. Tells the truth badly, which is why nobody believed him.",
      ],
      ["Wants", "To go home and be believed."],
      ["Afraid of", "That he left a lamp burning that night, and doesn’t remember."],
    ],
    lastLine:
      "My name is Tam. I did not burn the grain. I walked out of the fire, and nobody believed that either.",
  },
  {
    key: "sigrun",
    name: "Sigrun",
    note: "Sent by the northern clans. She killed a jarl and won’t say why.",
    pitch: "She still hasn’t said why.",
    facts: [
      ["Age", "34"],
      ["From", "Clan Vard, in the northern fjords"],
      ["Trade", "Sworn guard to Jarl Hakon"],
      ["Sent by", "The clan moot"],
      ["Carries", "A long axe and a round shield"],
    ],
    sections: [
      [
        "Before",
        "Twelve years at Hakon’s right hand. She carried his shield in three wars and taught his sons to fight. Has a daughter of nine, raised by her sister.",
      ],
      [
        "How she got here",
        "At the midwinter feast she stood up and killed Hakon at his own table, in front of forty witnesses, and sat back down. She has refused to say why. The clans can’t hang a sworn guard without a reason, so they gave her the beast.",
      ],
      [
        "How she fights",
        "Close and patient. She lets the other side make the first mistake, then ends it in one or two blows. The best fighter of the four by a long way.",
      ],
      [
        "Personality",
        "Says little. Sleeps sitting up and takes the worst watch without being asked. Kinder to Tam than she lets on.",
      ],
      ["Wants", "To finish what she started at that table."],
      ["Afraid of", "Her daughter hearing why."],
    ],
    lastLine:
      "My name is Sigrun. I killed a jarl, and I will tell you why. I walked out of the fire because I had not finished.",
  },
  {
    key: "oskar",
    name: "Oskar",
    note: "Sent by the king of the coast. He sold a fleet. Two fingers short.",
    pitch: "He’d sell this story to anyone.",
    facts: [
      ["Age", "51"],
      ["From", "Port Selle, on the coast"],
      ["Trade", "Purser to the king’s fleet"],
      ["Sent by", "The king of the coast"],
      ["Carries", "A crossbow on a strap and a thin knife"],
    ],
    sections: [
      [
        "Before",
        "A chandler’s son who talked his way up to keeping the accounts for sixty ships. He knew every captain’s debts and spent his evenings collecting on them.",
      ],
      [
        "How he got here",
        "He sold the fleet’s sailing dates to the enemy, and twenty-two ships burned off Cape Ansel. The king’s men took two fingers from his right hand while they asked who else knew. Hanging him would have meant a public trial, so the king sent him north instead.",
      ],
      [
        "How he fights",
        "Badly, and from behind something. With two fingers gone he can’t draw a bow, so he uses a crossbow and shoots first. He has also been known to pay the other side to leave.",
      ],
      [
        "Personality",
        "Charming, tired and always bargaining. Keeps a small ledger of what everyone in the party owes him, and it’s usually right.",
      ],
      ["Wants", "To buy his way out of this."],
      ["Afraid of", "Finding something he can’t put a price on."],
    ],
    lastLine:
      "My name is Oskar. I have sold everything I ever owned. I walked out of the fire and started looking for a buyer.",
  },
  {
    key: "maren",
    name: "Maren",
    note: "Sent by the abbey at Vell for heresy. She doesn’t flinch at fire.",
    pitch: "The fire didn’t burn her.",
    facts: [
      ["Age", "29"],
      ["From", "The abbey at Vell, in the mountains"],
      ["Trade", "Infirmarian"],
      ["Sent by", "The abbess of Vell"],
      ["Carries", "A staff, a lantern and a bag of needles"],
    ],
    sections: [
      [
        "Before",
        "Left at the abbey gate as a baby. She ran the infirmary by twenty-two and spent fever seasons walking the valley villages, setting bones and sitting with the dying.",
      ],
      [
        "How she got here",
        "The infirmary caught fire one night and she went back in for the patients. She walked out with her habit burned off and no mark on her skin. When she told the village that fire was not God’s judgement, the abbey tried her for heresy and gave her the north as penance.",
      ],
      [
        "How she fights",
        "She doesn’t, if she can help it. She stands in front of whoever is hurt with her staff, and she keeps the other three alive afterwards.",
      ],
      [
        "Personality",
        "Calm and blunt, with a dark sense of humour. Looks straight at things other people look away from.",
      ],
      ["Wants", "To learn why the fire didn’t burn her."],
      ["Afraid of", "That the answer has nothing to do with God."],
    ],
    lastLine:
      "My name is Maren. I walked out of the fire, and it did not burn me. I have stopped telling people that.",
  },
];

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

export const SURVIVED = "Walked out of the fire. Protagonist.";
export const FELL = "Died in the Greenlands, in the prologue.";

export const museReply = (key: CharacterKey) =>
  `The prologue ends with ${characterName(key)} now, and all four pages are up to date.`;
