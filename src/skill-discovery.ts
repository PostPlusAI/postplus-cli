import type { PublicSkillCatalogReport } from './skill-catalog.js';

// All discovery facts come from the selected catalog. Legacy catalogs remain
// readable without inventing descriptions or assigning speculative categories.
export function formatSkillDiscovery(catalog: PublicSkillCatalogReport, mode: 'full' | 'summary' = 'full'): string {
  const onboarding = mode === 'summary';
  const lines = [onboarding ? 'Try PostPlus with your agent:' : 'What you can do with PostPlus:'];
  if (!catalog.categories) {
    lines.push(...catalog.skills.map(skill => `- ${skill.skillId}${skill.description ? `: ${skill.description}` : ''}`));
  } else {
    const groups = Object.entries(catalog.categories).sort(([left], [right]) =>
      Number(left === 'workspace') - Number(right === 'workspace'));
    let examples = 0;
    for (const [id, category] of groups) {
      const skills = catalog.skills.filter(skill => skill.category === id);
      if (!skills.length) continue;
      const first = skills[0]!;
      lines.push(`- ${category.title}`);
      if (mode === 'full') lines.push(...skills.map(skill => `  ${skill.name ?? skill.skillId}: ${skill.description}`));
      if (first.example && (mode === 'full' || (id !== 'workspace' && examples < 6))) {
        lines.push(`  Try: "${first.example}"`); examples += 1;
      }
    }
  }
  lines.push(onboarding ? 'Explore tasks: postplus list' : 'Describe your task to your agent. Use postplus list --json for the full skill details.');
  return lines.join('\n');
}
