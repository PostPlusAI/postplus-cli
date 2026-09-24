import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import {
  assertLocalAuthUnchanged,
  readLocalConfig,
  setLocalSession,
  withPostPlusUpdateLock,
} from './local-state.js';

export async function switchWorkspace(accountId: string): Promise<unknown> {
  // Reuse the existing cross-process lock and compare-and-set writer. A login or
  // refresh racing outside this lock still cannot silently overwrite identity.
  return withPostPlusUpdateLock(
    async () => {
      const auth = await resolveFreshRemoteAuth();
      const expected = await readLocalConfig();
      if (expected?.cliSessionToken !== auth.cliSessionToken)
        throw new Error('Authentication changed; run postplus auth status.');
      assertLocalAuthUnchanged(await readLocalConfig(), expected);
      let response: Response;
      try {
        response = await sendAuthedCloudRequest({
          auth,
          method: 'POST',
          pathName: '/api/postplus-cli/workspaces',
          body: { accountId },
          timeoutMs: 30_000,
        });
      } catch {
        throw new Error(
          'Workspace switch outcome is unknown. Run postplus auth login; do not continue using the previous workspace.',
        );
      }
      if (!response.ok)
        throw new Error(
          'Workspace switch failed. Run postplus auth login to verify your workspace.',
        );
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error(
          'Workspace response was lost. Run postplus auth login.',
        );
      }
      if (!value || typeof value !== 'object')
        throw new Error('Invalid workspace response. Run postplus auth login.');
      const data = value as Record<string, unknown>;
      if (
        data.accountId !== accountId ||
        data.userId !== expected.userId ||
        typeof data.cliSessionToken !== 'string' ||
        typeof data.sessionExpiresAt !== 'number' ||
        typeof data.accountName !== 'string' ||
        !['personal', 'team'].includes(String(data.accountType))
      ) {
        throw new Error(
          'Workspace response identity mismatch. Run postplus auth login.',
        );
      }
      try {
        await setLocalSession({
          apiBaseUrl: auth.apiBaseUrl,
          accountId,
          userId: String(data.userId),
          cliSessionToken: data.cliSessionToken,
          sessionExpiresAt: data.sessionExpiresAt,
          userEmail: typeof data.userEmail === 'string' ? data.userEmail : null,
          accountName: data.accountName,
          accountSlug:
            typeof data.accountSlug === 'string' ? data.accountSlug : null,
          accountType: data.accountType as 'personal' | 'team',
          expectedAuthConfig: expected,
        });
      } catch {
        throw new Error(
          'The workspace changed on the server but could not be saved locally. Run postplus auth login.',
        );
      }
      return {
        accountId,
        accountName: data.accountName,
        accountType: data.accountType,
      };
    },
    { timeoutMs: 30_000 },
  );
}

export async function runWorkspaceCommand(args: string[]): Promise<number> {
  const tokens = args.filter((arg) => arg !== '--json');
  if (
    !tokens.length ||
    tokens.some((arg) => ['help', '--help', '-h'].includes(arg))
  ) {
    process.stdout.write(
      'postplus workspace status|list|use <workspace-id> [--json]\nTasks remain in the workspace where they were submitted. Your connections are personal.\n',
    );
    return 0;
  }
  const [operation, id, ...rest] = tokens;
  if (
    rest.length ||
    (id && operation !== 'use') ||
    (operation === 'use' && !id) ||
    !['list', 'status', 'use'].includes(operation ?? '')
  )
    throw new Error(
      'Use postplus workspace status|list|use <workspace-id> [--json].',
    );
  let result: unknown;
  if (operation === 'use') result = await switchWorkspace(id!);
  else {
    const response = await sendAuthedCloudRequest({
      auth: await resolveFreshRemoteAuth(),
      method: 'GET',
      pathName: '/api/postplus-cli/workspaces',
      retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
    });
    if (!response.ok)
      throw new Error('Could not read workspaces. Run postplus auth status.');
    const payload = (await response.json()) as {
      currentWorkspace?: unknown;
      workspaces?: unknown;
    };
    result = operation === 'status' ? payload.currentWorkspace : payload;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
