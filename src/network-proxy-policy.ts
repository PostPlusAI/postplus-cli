import {
  Agent,
  Dispatcher,
  ProxyAgent,
  setGlobalDispatcher,
} from 'undici-runtime';

const LOOPBACK_NO_PROXY_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
] as const;

type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

export type EnvironmentProxyPolicy = Readonly<{
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string;
}>;

let isEnvironmentProxyInstalled = false;

/**
 * Opts the short-lived CLI process into the caller's standard HTTP proxy
 * environment. PostPlus never chooses or persists a proxy; it only makes Node
 * honor the runtime-owned HTTP(S)_PROXY/NO_PROXY contract. Loopback is always
 * merged into NO_PROXY so Local Studio and other local callbacks stay direct.
 */
export function ensureEnvironmentProxyDispatcher(
  env: ProxyEnvironment = process.env,
): void {
  if (isEnvironmentProxyInstalled) {
    return;
  }

  const policy = resolveEnvironmentProxyPolicy(env);
  if (!policy.httpProxy && !policy.httpsProxy) {
    return;
  }

  setGlobalDispatcher(new StandardEnvironmentProxyDispatcher(policy));
  isEnvironmentProxyInstalled = true;
}

export function resolveEnvironmentProxyPolicy(
  env: ProxyEnvironment,
): EnvironmentProxyPolicy {
  const allProxy = readFirst(env, 'all_proxy', 'ALL_PROXY');
  const httpProxy = readFirst(env, 'http_proxy', 'HTTP_PROXY') ?? allProxy;
  const httpsProxy =
    readFirst(env, 'https_proxy', 'HTTPS_PROXY') ?? allProxy ?? httpProxy;
  const configuredNoProxy = readFirst(env, 'no_proxy', 'NO_PROXY');

  return Object.freeze({
    httpProxy,
    httpsProxy,
    noProxy: mergeNoProxy(configuredNoProxy),
  });
}

function mergeNoProxy(configuredNoProxy: string | null): string {
  const values = new Set(
    (configuredNoProxy ?? '')
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const hostname of LOOPBACK_NO_PROXY_HOSTS) {
    values.add(hostname);
  }
  return [...values].join(',');
}

function readFirst(
  env: ProxyEnvironment,
  ...names: readonly string[]
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

class StandardEnvironmentProxyDispatcher extends Dispatcher {
  private readonly directAgent = new Agent();
  private readonly httpAgent: Dispatcher;
  private readonly httpsAgent: Dispatcher;

  constructor(private readonly policy: EnvironmentProxyPolicy) {
    super();
    this.httpAgent = policy.httpProxy
      ? new ProxyAgent(policy.httpProxy)
      : this.directAgent;
    this.httpsAgent = policy.httpsProxy
      ? new ProxyAgent(policy.httpsProxy)
      : this.httpAgent;
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    if (!options.origin) {
      throw new TypeError('Provider request origin is required.');
    }
    const target = new URL(options.origin.toString());
    if (targetIsExcludedFromProxy(target, this.policy.noProxy)) {
      return this.directAgent.dispatch(options, handler);
    }
    return (
      target.protocol === 'https:' ? this.httpsAgent : this.httpAgent
    ).dispatch(options, handler);
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const operation = this.forEachDispatcher((dispatcher) =>
      dispatcher.close(),
    );
    if (callback) {
      void operation.then(callback);
      return;
    }
    return operation;
  }

  destroy(): Promise<void>;
  destroy(error: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(error: Error | null, callback: () => void): void;
  destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error =
      typeof errorOrCallback === 'function' ? undefined : errorOrCallback;
    const completion =
      typeof errorOrCallback === 'function' ? errorOrCallback : callback;
    const operation = this.forEachDispatcher((dispatcher) =>
      error === undefined ? dispatcher.destroy() : dispatcher.destroy(error),
    );
    if (completion) {
      void operation.then(completion);
      return;
    }
    return operation;
  }

  private async forEachDispatcher(
    operation: (dispatcher: Dispatcher) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      [...new Set([this.directAgent, this.httpAgent, this.httpsAgent])].map(
        operation,
      ),
    );
  }
}

function targetIsExcludedFromProxy(target: URL, noProxy: string): boolean {
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return noProxy.split(',').some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;

    const portMatch = entry.match(/^(.*):(\d+)$/u);
    const entryHostname = (portMatch?.[1] ?? entry).replace(/^\*?\./u, '');
    if (portMatch?.[2] && portMatch[2] !== port) return false;
    return hostname === entryHostname || hostname.endsWith(`.${entryHostname}`);
  });
}
