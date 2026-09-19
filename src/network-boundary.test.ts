import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function rawFetchReferences(source: string, name: string): number[] {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      // Object keys do not invoke or capture the global implementation.
      if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
        lines.push(tree.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return lines;
}

test('transport boundary catches native fetch values, aliases and calls but not type references or browser strings', () => {
  assert.equal(rawFetchReferences('const a = fetch; const b = globalThis.fetch; fetch(url);', 'sample.ts').length, 3);
  assert.deepEqual(rawFetchReferences('const f: typeof fetch = diagnosticFetch; const html = `<script>fetch(url)</script>`;', 'sample.ts'), []);
});

test('all Node native fetch references stay in the diagnostic transport', async () => {
  const violations: string[] = [];
  const root = new URL('.', import.meta.url);
  for (const file of await readdir(root)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'network-diagnostics.ts') continue;
    const source = await readFile(new URL(file, root), 'utf8');
    for (const line of rawFetchReferences(source, file)) violations.push(`${file}:${line}`);
  }
  assert.deepEqual(violations, [], `Native fetch escapes the transport boundary: ${violations.join(', ')}`);
});
