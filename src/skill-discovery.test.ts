import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPublicSkillCatalog } from './skill-catalog.js';
import { formatSkillDiscovery } from './skill-discovery.js';

const legacy = { schemaVersion: 2, releaseId: 'skills-2026-09-19.1', source: 'PostPlusAI/postplus-skills', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', status: 'released', requirements: { localDependencies: ['ffmpeg'] } }] };
const discovery = { ...legacy, discoveryCategories: { research: { title: 'Research your audience' } }, skills: [{ ...legacy.skills[0], description: 'Understand real audience questions.', category: 'research', example: 'What do customers ask about this product?' }] };
const load = (value: unknown) => loadPublicSkillCatalog(async () => new Response(JSON.stringify(value)), {});

test('catalog discovery is additive and legacy fields remain available', async () => {
  const catalog = await load(legacy);
  assert.equal(catalog.skills[0]!.name, 'demo');
  assert.equal(catalog.skills[0]!.skillId, 'demo');
  assert.equal(catalog.skills[0]!.path, 'skills/demo/SKILL.md');
  assert.deepEqual(catalog.skills[0]!.localDependencies, ['ffmpeg']);
  assert.deepEqual(catalog.skills[0]!.requirements.localDependencies, ['ffmpeg']);
  assert.equal(catalog.categories, undefined);
  assert.match(formatSkillDiscovery(catalog), /demo/);
  assert.doesNotMatch(formatSkillDiscovery(catalog), /skills\/demo|Source:|baseline|manifest/);
});

test('list and initial discovery use the same authored categories and examples', async () => {
  const catalog = await load(discovery);
  assert.deepEqual(catalog.categories, discovery.discoveryCategories);
  for (const mode of ['full', 'summary'] as const) {
    const text = formatSkillDiscovery(catalog, mode);
    assert.match(text, /Research your audience/);
    if (mode === 'full') assert.match(text, /demo: Understand real audience questions\./);
    else assert.doesNotMatch(text, /Understand real audience questions/);
    assert.match(text, /What do customers ask about this product\?/);
    assert.match(text, /postplus list/);
    assert.doesNotMatch(text, /skills\/demo|Source:|baseline|manifest/);
  }
});

test('present but malformed discovery fields fail with a structured catalog error', async () => {
  for (const invalid of [
    { ...discovery, discoveryCategories: null },
    { ...discovery, discoveryCategories: { research: { title: '' } } },
    ...['description', 'category', 'example'].map(key => ({ ...discovery, skills: [{ ...discovery.skills[0], [key]: null }] })),
    { ...discovery, skills: [{ ...discovery.skills[0], category: 'unknown' }] },
    { ...legacy, skills: [{ ...legacy.skills[0], description: 'Partial metadata' }] },
  ]) await assert.rejects(load(invalid), error => (error as { details?: { code?: string } }).details?.code === 'postplus_skills_catalog_invalid');
});

// Multiple entries in one category are essential: a first-entry-only formatter
// must fail this coverage assertion even though every category still appears.
test('full discovery lists every catalog member once; summary keeps only group examples', async () => {
  const catalog = await loadPublicSkillCatalog(undefined, {});
  const full = formatSkillDiscovery(catalog, 'full');
  for (const skill of catalog.skills) {
    const entry = `  ${skill.skillId}: ${skill.description}`;
    assert.equal(full.split('\n').filter(line => line === entry).length, 1, skill.skillId);
  }
  const summary = formatSkillDiscovery(catalog, 'summary');
  for (const skill of catalog.skills) assert.ok(!summary.includes(`  ${skill.skillId}: `));
  const groupLines = summary.split('\n').filter(line => line.startsWith('- '));
  assert.deepEqual(groupLines, Object.values(catalog.categories!).map(category => `- ${category.title}`));
  assert.equal(groupLines.at(-1), `- ${catalog.categories!.workspace!.title}`);
  assert.ok(summary.split('\n').filter(line => line.startsWith('  Try:')).length <= 6);
  const firstOnly = { ...catalog, skills: catalog.skills.filter((skill, index, all) => all.findIndex(candidate => candidate.category === skill.category) === index) };
  assert.notEqual(formatSkillDiscovery(firstOnly), full, 'A category representative cannot stand in for the full list');
});
