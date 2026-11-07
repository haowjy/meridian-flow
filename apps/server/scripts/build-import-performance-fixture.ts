/** Builds the nested import performance fixture without retaining generated files in git. */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const FILES = 3_219;
const GROUPS = 34;
const LEAVES = 1_172;

const output = process.argv[2];
if (!output) {
  console.error("Usage: tsx scripts/build-import-performance-fixture.ts <output-dir>");
  process.exitCode = 2;
} else {
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) throw new Error(`Output directory is not empty: ${root}`);

  const leaves: string[] = [];
  for (let groupIndex = 0; groupIndex < GROUPS; groupIndex++) {
    const group = `${root}/Arc ${String(groupIndex + 1).padStart(2, "0")}`;
    await mkdir(group);
    const count = groupIndex < 16 ? 35 : 34;
    for (let leafIndex = 0; leafIndex < count; leafIndex++) {
      const leaf = `${group}/Chapter Set ${String(leafIndex + 1).padStart(2, "0")}`;
      await mkdir(leaf);
      leaves.push(leaf);
    }
  }
  if (leaves.length !== LEAVES) throw new Error(`Fixture has ${leaves.length} leaf folders`);

  const writes: Promise<void>[] = [];
  for (let index = 0; index < FILES; index++) {
    const number = String(index + 1).padStart(4, "0");
    const next = String(((index + 1) % FILES) + 1).padStart(4, "0");
    writes.push(
      writeFile(
        `${leaves[index % leaves.length]}/Note ${number}.md`,
        `# Note ${number}\n\nLink [[Note ${next}]].\n`,
      ),
    );
  }
  await Promise.all(writes);
  console.log(JSON.stringify({ root, files: FILES, folders: 1 + GROUPS + LEAVES }));
}
