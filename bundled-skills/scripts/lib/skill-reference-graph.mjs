import fs from 'node:fs';
import path from 'node:path';

// Entry references retain the supported inline-code syntax. Nested references
// use Markdown links so output filenames in examples are not dependencies.
export function readSkillReferenceGraph(skillFile) {
  const root = path.dirname(skillFile);
  const reachable = new Set();
  const errors = [];
  const visited = new Set();
  const pending = [skillFile];
  while (pending.length) {
    const source = pending.pop();
    if (visited.has(source)) continue;
    visited.add(source);
    const text = fs.readFileSync(source, 'utf8');
    const pattern =
      source === skillFile
        ? /(?:^|[`(])((?:\.\/)?references\/[^`)\s]+\.md)(?:[`)]|$)/gmu
        : /\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/gu;
    for (const match of text.matchAll(pattern)) {
      const reference = match[1];
      if (/^[a-z]+:/iu.test(reference)) continue;
      const target = path.resolve(path.dirname(source), reference);
      if (!target.startsWith(`${root}${path.sep}`)) {
        errors.push({
          source,
          message: `reference ${reference} escapes the skill directory.`,
        });
      } else if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        errors.push({
          source,
          message: `indexed reference ${reference} is missing.`,
        });
      } else if (
        !fs
          .realpathSync(target)
          .startsWith(`${fs.realpathSync(root)}${path.sep}`)
      ) {
        errors.push({
          source,
          message: `reference ${reference} escapes the skill directory.`,
        });
      } else {
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  return { reachable, errors };
}
