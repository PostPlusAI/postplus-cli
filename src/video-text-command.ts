import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { postHostedJson } from './hosted-command-runtime.js';
import {
  runMediaFileCommand,
  stageHostedMediaFile,
} from './hosted-domain-commands.js';
import { createMediaFileFingerprint } from './hosted-media-transfer.js';
import {
  VIDEO_TEXT_LIMITS,
  VIDEO_TEXT_PLAN_SCHEMA,
  parseVideoTextPlan,
  renderVideoText,
  videoTextFileHash,
} from './video-text.js';

export async function runVideoTextCommand(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (
    !verb ||
    ['--help', '-h', 'help'].includes(verb) ||
    rest.includes('--help')
  ) {
    process.stdout.write(
      'Render explicitly timed captions and static overlays. This is separate from video generation.\n\nUsage:\n  postplus video-text schema --json\n  postplus video-text render --video <raw.mp4> --plan <plan.json> --output <new.mp4> [--remote] [--operation-id <uuid>] [--wait-seconds <0..600>] [--json]\n  postplus video-text status --operation-id <uuid> [--output <new.mp4>] [--json]\n\nLocal rendering uses FFmpeg/FFprobe and bundled fonts. --remote uses the configured PostPlus Cloud and accepts a local file or owned postplus-media reference. Keep the operation ID after interrupted waits. Raw is never overwritten.\n',
    );
    return 0;
  }
  const flags = new Map<string, string>(),
    booleans = new Set<string>();
  const values = new Set([
    '--video',
    '--plan',
    '--output',
    '--operation-id',
    '--wait-seconds',
  ]);
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (['--json', '--remote'].includes(key)) {
      if (booleans.has(key)) throw Error('Duplicate ' + key);
      booleans.add(key);
    } else {
      if (!values.has(key) || flags.has(key))
        throw Error('Unknown or duplicate video-text option: ' + key);
      const value = rest[++i];
      if (!value || value.startsWith('--'))
        throw Error('Missing value for ' + key);
      flags.set(key, value);
    }
  }
  if (verb === 'schema') {
    if (flags.size || [...booleans].some((key) => key !== '--json'))
      throw Error('schema only accepts --json.');
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 1,
          plan: VIDEO_TEXT_PLAN_SCHEMA,
          limits: VIDEO_TEXT_LIMITS,
          defaults:
            'B-style starting point at 720x1280; choose and adjust layout for the actual clip.',
          fonts:
            'Bundled OFL-1.1 Arimo and Noto Sans SC. Arimo substitutes for the reference Helvetica Neue.',
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  if (!['render', 'status'].includes(verb))
    throw Error('Unknown video-text command: ' + verb);
  const output = flags.get('--output');
  if (
    verb === 'render' &&
    (!flags.get('--video') || !flags.get('--plan') || !output)
  )
    throw Error('render requires --video, --plan and --output.');
  if (
    verb === 'status' &&
    (!flags.get('--operation-id') ||
      flags.has('--video') ||
      flags.has('--plan') ||
      booleans.has('--remote'))
  )
    throw Error('status requires --operation-id and optional --output.');
  if (verb === 'render' && !booleans.has('--remote')) {
    if (flags.has('--operation-id') || flags.has('--wait-seconds'))
      throw Error('Operation and wait options require --remote.');
    const plan = parseVideoTextPlan(
      JSON.parse(await readFile(path.resolve(flags.get('--plan')!), 'utf8')),
    );
    const result = await renderVideoText({
      videoPath: flags.get('--video')!,
      outputPath: output!,
      plan,
      fontsDirectory: fileURLToPath(
        new URL('../assets/video-text/fonts/', import.meta.url),
      ),
    });
    process.stdout.write(
      JSON.stringify(
        {
          state: 'completed',
          raw: path.resolve(flags.get('--video')!),
          ...result,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  const seconds = Number(
    flags.get('--wait-seconds') ?? (verb === 'render' ? 240 : 0),
  );
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600)
    throw Error('wait-seconds must be between 0 and 600.');
  const suppliedId = flags.get('--operation-id');
  if (
    suppliedId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      suppliedId,
    )
  )
    throw Error('operation-id must be a UUID.');
  const auth = await resolveFreshRemoteAuth();
  let operationId = flags.get('--operation-id'),
    video = flags.get('--video'),
    plan: ReturnType<typeof parseVideoTextPlan> | undefined;
  if (verb === 'render') {
    plan = parseVideoTextPlan(
      JSON.parse(await readFile(path.resolve(flags.get('--plan')!), 'utf8')),
    );
    const checkpointPath = path.resolve(output! + '.postplus-render.json');
    const planHash = createHash('sha256')
      .update(JSON.stringify(plan))
      .digest('hex');
    let previous:
      | {
          operationId: string;
          video: string;
          planHash: string;
          apiBaseUrl: string;
        }
      | undefined;
    try {
      previous = JSON.parse(await readFile(checkpointPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      previous &&
      (previous.planHash !== planHash ||
        previous.video !== video ||
        previous.apiBaseUrl !== auth.apiBaseUrl ||
        (operationId && previous.operationId !== operationId))
    )
      throw Error(
        'Existing render checkpoint belongs to another source, plan, environment or operation. Choose a new output path.',
      );
    operationId ??= previous?.operationId ?? randomUUID();
    if (
      !previous &&
      (await stat(output!).then(
        () => true,
        (e) => {
          if (e.code !== 'ENOENT') throw e;
          return false;
        },
      ))
    )
      throw Error('Output already exists. Choose a new output path.');
    if (!previous)
      await writeFile(
        checkpointPath,
        JSON.stringify(
          { operationId, video, planHash, apiBaseUrl: auth.apiBaseUrl },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    if (!video!.startsWith('postplus-media://')) {
      if (/^[a-z]+:/i.test(video!))
        throw Error(
          'Remote rendering accepts an owned media reference or local file. Import other URLs first.',
        );
      const absolutePath = path.resolve(video!),
        fingerprint = await createMediaFileFingerprint(absolutePath);
      if ((await stat(absolutePath)).size > VIDEO_TEXT_LIMITS.maxBytes)
        throw Error('Source exceeds 100 MiB.');
      video = await stageHostedMediaFile({
        file: {
          ...fingerprint,
          absolutePath,
          mimeType: 'video/mp4',
          name: path.basename(absolutePath),
        },
        operationId,
        skillName: '',
      });
    }
  }
  if (
    !operationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  )
    throw Error('operation-id must be a UUID.');
  const call = (body: object) =>
    postHostedJson({ pathName: '/api/video-text', body, skillName: null });
  let job = (await call(
    verb === 'render'
      ? { action: 'render', operationId, video, plan }
      : { action: 'status', operationId },
  )) as { state: string; output?: Record<string, unknown>; error?: string };
  const deadline = Date.now() + seconds * 1000;
  while (job.state === 'processing' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    job = (await call({ action: 'status', operationId })) as typeof job;
  }
  if (job.state === 'completed' && output) {
    const reference = String(job.output?.mediaReference ?? '');
    let exists = false;
    try {
      exists = (await stat(output)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) {
      if ((await videoTextFileHash(output)) !== job.output?.outputSha256)
        throw Error('Output already exists with different contents.');
    } else {
      await runMediaFileCommand(
        ['download', '--reference', reference, '--output-file', output],
        { auth },
      );
      await writeFile(
        output + '.plan.json',
        JSON.stringify(job.output?.plan, null, 2) + '\n',
        { flag: 'wx' },
      );
      await writeFile(
        output + '.render.json',
        JSON.stringify(job.output, null, 2) + '\n',
        { flag: 'wx' },
      );
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        ...job,
        operationId,
        ...(output ? { outputPath: path.resolve(output) } : {}),
        ...(job.state === 'processing' || job.state === 'unknown'
          ? {
              nextAction:
                'postplus video-text status --operation-id ' + operationId,
            }
          : {}),
      },
      null,
      2,
    ) + '\n',
  );
  return ['failed', 'unknown'].includes(job.state) ? 1 : 0;
}
