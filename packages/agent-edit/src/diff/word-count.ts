/** Han and kana have no spaces, so each character counts as a word, as word processors do. */
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}])+(?:['’](?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}])+)*/gu;

export function countWords(text: string): number {
  return (text.match(WORD) ?? []).length;
}
