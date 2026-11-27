const MIN_LENGTH = 2;

const FLAG_GROUP = /\(\?(?!:|P?<[A-Za-z_])/u;
const REPEAT = /^\{\d+(?:,\d*)?\}/u;

export function requiredLiterals(pattern: string): string[] | undefined {
  if (FLAG_GROUP.test(pattern) || pattern.includes("\\Q")) return undefined;
  const chars = Array.from(pattern);
  const literals = new Set<string>();
  let run: string[] = [];
  let best: string[] = [];
  let depth = 0;
  const endRun = () => {
    if (run.length > best.length) best = run;
    run = [];
  };
  const endAlternative = (): boolean => {
    endRun();
    if (best.length < MIN_LENGTH) return false;
    literals.add(best.join(""));
    best = [];
    return true;
  };
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    if (char === "\\") {
      const next = chars[++i] ?? "";
      if (/[pPxXcC0-9]/u.test(next)) return undefined;
      if (depth > 0) continue;
      if (/[A-Za-z]/u.test(next)) endRun();
      else run.push(next);
    } else if (char === "[") {
      // A leading `]` (after an optional `^`) is a member, not the end.
      let j = i + 1;
      if (chars[j] === "^") j += 1;
      if (chars[j] === "]") j += 1;
      while (j < chars.length && chars[j] !== "]") {
        // `[:alpha:]` inside a class has its own `]`.
        if (chars[j] === "[" && chars[j + 1] === ":") {
          const close = chars.indexOf("]", j + 2);
          if (close < 0) return undefined;
          j = close + 1;
        } else j += chars[j] === "\\" ? 2 : 1;
      }
      i = j;
      if (depth === 0) endRun();
    } else if (char === "(") {
      depth += 1;
      if (depth === 1) endRun();
    } else if (char === ")") {
      depth -= 1;
    } else if (depth > 0) {
      // Inside a group: nothing in it is required of the whole pattern.
    } else if (char === "|") {
      if (!endAlternative()) return undefined;
    } else if (char === "*" || char === "?") {
      run.pop();
      endRun();
    } else if (char === "+") {
      endRun();
    } else if (char === "{") {
      const repeat = REPEAT.exec(chars.slice(i).join(""));
      if (repeat) {
        run.pop();
        endRun();
        i += repeat[0].length - 1;
      } else run.push(char);
    } else if (char === "." || char === "^" || char === "$") {
      endRun();
    } else run.push(char);
  }
  return endAlternative() ? [...literals] : undefined;
}
