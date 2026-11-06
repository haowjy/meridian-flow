/** The story the page tells. Text the visitor's answers change lives here. */

export type AnswerKey = "a" | "b";

export type Question = {
  text: string;
  options: ReadonlyArray<{
    key: AnswerKey;
    label: string;
    detail: string;
    recommended?: boolean;
  }>;
};

export const QUESTIONS: readonly Question[] = [
  {
    text: "Dell’s scar is on his right hand here. Chapter 9 says left. What’s going on?",
    options: [
      {
        key: "a",
        label: "He is not Dell",
        detail: "Someone took his place. The wrong hand is the first clue.",
        recommended: true,
      },
      {
        key: "b",
        label: "The log is wrong",
        detail: "Ise rewrote that volume from memory. Now she has to doubt herself.",
      },
    ],
  },
  {
    text: "Does Ise tell anyone in chapter 413?",
    options: [
      {
        key: "a",
        label: "She tells no one",
        detail: "She watches him alone for now.",
        recommended: true,
      },
      {
        key: "b",
        label: "She tells the bosun",
        detail: "She gets one ally, and one more person who can talk.",
      },
    ],
  },
];

/** Chapter 413's next line, by who the man is, then whether Ise tells. */
export const NEXT_LINE: Record<AnswerKey, Record<AnswerKey, string>> = {
  a: {
    a: "She did not tell the crew. She told the log, in the brown ink she kept for weather, and went up on deck to stand beside him.",
    b: "She found the bosun in the chain locker and shut the door. “Show me your hands,” she said. “Then I’ll tell you about the captain’s.”",
  },
  b: {
    a: "She did not tell the crew. She took the eleventh volume to her bunk and began checking her own handwriting against the sky.",
    b: "She found the bosun in the chain locker and shut the door. “How much of the log do you remember?” she said.",
  },
};

export const MUSE_REPLY: Record<AnswerKey, { chat: string; note: string }> = {
  a: {
    chat: "I read every chapter with Dell in it and put the hints in 146, 263 and 380. His notes now say he was replaced at 380.",
    note: "Replaced at chapter 380. The man aboard after that has the scar on his right hand, on purpose.",
  },
  b: {
    chat: "I read every chapter that quotes the log and put the hints in 146, 263 and 380. Ise’s notes now say volume two is unreliable.",
    note: "Scar across the left palm (chapter 9). The right-hand scar in chapter 412 stands: Ise’s log is the error.",
  },
};
