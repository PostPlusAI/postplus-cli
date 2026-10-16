import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { normalizeAdReport, renderAdReport } from './generated/ad-library-report.generated.js';
export { normalizeAdReport, renderAdReport, reportCreativeGroupKey } from './generated/ad-library-report.generated.js';
export type { ReportAd, ReportCreative, ReportInput } from './generated/ad-library-report.generated.js';

export async function runAdLibraryReport(
  args: string[],
  print: (text: string) => void,
): Promise<number> {
  const paths: string[] = [];
  let output = '';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (
      !['--input', '--output'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Use ad-library report --input <json> [--input <json>] --output <report.html>.',
      );
    if (flag === '--input') paths.push(resolve(value));
    else {
      if (output) throw new Error('Duplicate --output');
      output = resolve(value);
    }
  }
  if (!paths.length || !output)
    throw new Error('Report requires --input and --output.');
  if (paths.includes(output))
    throw new Error('Report output must not overwrite an input.');
  const inputs = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      payload: JSON.parse(await readFile(path, 'utf8')) as unknown,
    })),
  );
  const html = renderAdReport(inputs);
  await mkdir(dirname(output), { recursive: true });
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, html, { flag: 'wx', mode: 0o600 });
    await rename(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
  print(
    `${JSON.stringify({ output, ads: normalizeAdReport(inputs).ads.length })}\n`,
  );
  return 0;
}
