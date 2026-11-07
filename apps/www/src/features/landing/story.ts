/** The prologue on the page, and the choice that ends it. */

export type CharacterKey = "tam" | "sigrun" | "oskar" | "maren";

type Character = {
  key: CharacterKey;
  name: string;
  note: string;
  /** Why the visitor might pick them. */
  pitch: string;
  /** The prologue's last line once they are the one who lived. */
  lastLine: string;
};

export const CHARACTERS: readonly Character[] = [
  {
    key: "tam",
    name: "Tam",
    note: "Mill boy from Harl. Accused of burning the town’s grain. Says he didn’t.",
    pitch: "He still has to prove he didn’t do it.",
    lastLine:
      "My name is Tam. I did not burn the grain. I walked out of the fire, and nobody believed that either.",
  },
  {
    key: "sigrun",
    name: "Sigrun",
    note: "Sent by the northern clans. She killed a jarl and won’t say why.",
    pitch: "She still hasn’t said why.",
    lastLine:
      "My name is Sigrun. I killed a jarl, and I will tell you why. I walked out of the fire because I had not finished.",
  },
  {
    key: "oskar",
    name: "Oskar",
    note: "Sent by the king of the coast. He sold a fleet. Two fingers short.",
    pitch: "He’d sell this story to anyone.",
    lastLine:
      "My name is Oskar. I have sold everything I ever owned. I walked out of the fire and started looking for a buyer.",
  },
  {
    key: "maren",
    name: "Maren",
    note: "Sent by the abbey at Vell for heresy. She doesn’t flinch at fire.",
    pitch: "The fire didn’t burn her.",
    lastLine:
      "My name is Maren. I walked out of the fire, and it did not burn me. I have stopped telling people that.",
  },
];

export const characterName = (key: CharacterKey) =>
  CHARACTERS.find((character) => character.key === key)?.name ?? "";

export const PROLOGUE = {
  opening: "They told us to kill the beast in the Greenlands.",
  lines: [
    "Four of us went north, and four countries wanted us dead.",
    "Nobody said what the beast was. I don’t think they knew.",
    "Every night the Cold Fire burned above us. We thought it was beautiful.",
  ],
  turn: "On the ninth night, the Cold Fire came down.",
} as const;

export const QUESTION =
  "This is the prologue. Only one of them survives it and becomes the protagonist. Who is it?";

export const SURVIVED = "Walked out of the fire. Protagonist.";
export const FELL = "Died in the Greenlands, in the prologue.";

export const museReply = (key: CharacterKey) =>
  `The prologue ends with ${characterName(key)} now, and all four pages are up to date.`;
