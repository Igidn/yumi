import { parseEpub, readEpubMeta } from "./parse";
import type { ContentBlock } from "./types";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx src/main/epub/self-check.ts <file.epub>");
    process.exit(1);
  }
  const meta = await readEpubMeta(file);
  console.log(
    `meta title="${meta.title}" author="${meta.author}" cover=${meta.cover ? meta.cover.ext + " " + meta.cover.data.length + "b" : "none"}`,
  );
  const parsed = await parseEpub(file);
  console.log(
    `title="${parsed.title}" author="${parsed.author}" chapters=${parsed.chapters.length}`,
  );
  const first = parsed.chapters[0];
  if (first) {
    const blocks: ContentBlock[] = JSON.parse(first.rawText);
    console.log(`  ch0 "${first.title}": ${blocks.length} blocks`);
    console.log(`  first block: ${JSON.stringify(blocks[0])}`);
  }
  assert(parsed.chapters.length > 0, "parsed chapters empty");
  assert(parsed.title === meta.title, "meta/parse title mismatch");
  console.log("OK");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("ASSERT FAILED: " + msg);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
