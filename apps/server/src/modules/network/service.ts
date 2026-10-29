import { networkConfiguration, type Database } from '@platform/db';
import {
  networkSave,
  networkSettings,
  networkSecretNames,
  type NetworkConfig,
  type NetworkView,
} from '@platform/contracts';
import {
  NetworkClient,
  processNetwork,
  githubClone,
  pythonDeclaration,
  npmDeclaration,
  npmAuthorization,
  resolvePackage,
} from '@platform/network';
import { eq, and } from 'drizzle-orm';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { adminUser } from '../users/userAccess.js';
const ID = 'platform';
export class NetworkService {
  private current?: { revision: number; client: NetworkClient };
  private readonly retired = new Set<NetworkClient>();
  constructor(
    private readonly deps: {
      db: Database;
      vault: Vault;
      fetch: typeof fetch;
      failed: () => void;
      files: { read: (path: string) => Promise<string | undefined>; home: string; cwd: string };
    },
  ) {}
  async snapshot() {
    const [row] = await this.deps.db
      .select()
      .from(networkConfiguration)
      .where(eq(networkConfiguration.id, ID));
    return {
      revision: row?.revision ?? 0,
      config: row
        ? this.deps.vault.open<NetworkConfig>(row.encrypted, 'network-settings')
        : { ...networkSettings.parse({}), secrets: {} },
    };
  }
  async view(actor: string): Promise<NetworkView> {
    await adminUser(this.deps.db, actor);
    const { revision, config } = await this.snapshot();
    const { secrets, ...settings } = config;
    return {
      revision,
      settings,
      secrets: Object.fromEntries(
        networkSecretNames.map((name) => [name, Boolean(secrets[name])]),
      ) as NetworkView['secrets'],
    };
  }
  async save(actor: string, value: unknown) {
    await adminUser(this.deps.db, actor);
    const input = networkSave.parse(value);
    const previous = await this.snapshot();
    if (input.revision !== previous.revision)
      throw new AppError('REVISION_CONFLICT', '网络设置已变化，请重新加载', 409);
    const secrets = { ...previous.config.secrets };
    for (const name of networkSecretNames) {
      const edit = input.secrets[name];
      if (edit?.action === 'clear') delete secrets[name];
      if (edit?.action === 'replace') secrets[name] = edit.value;
    }
    const encrypted = this.deps.vault.seal({ ...input.settings, secrets }, 'network-settings');
    const row = { id: ID, revision: input.revision + 1, encrypted };
    const saved =
      input.revision === 0
        ? await this.deps.db
            .insert(networkConfiguration)
            .values(row)
            .onConflictDoNothing()
            .returning()
        : await this.deps.db
            .update(networkConfiguration)
            .set(row)
            .where(
              and(
                eq(networkConfiguration.id, ID),
                eq(networkConfiguration.revision, input.revision),
              ),
            )
            .returning();
    if (!saved.length) throw new AppError('REVISION_CONFLICT', '网络设置已变化，请重新加载', 409);
    return this.view(actor);
  }
  fetch: typeof fetch = async (input, init) => {
    const snapshot = await this.snapshot();
    if (this.current?.revision !== snapshot.revision) {
      if (this.current) {
        const previous = this.current.client;
        this.retired.add(previous);
        void previous
          .retire()
          .catch(this.deps.failed)
          .finally(() => this.retired.delete(previous));
      }
      this.current = {
        revision: snapshot.revision,
        client: new NetworkClient(snapshot.config, this.deps.fetch),
      };
    }
    return this.current.client.fetch(input, init);
  };
  async process<T extends { command?: string; args: string[]; env: Record<string, string> }>(
    input: T,
  ) {
    const { config } = await this.snapshot();
    const declaration = await npmDeclaration(
      await pythonDeclaration(input, this.deps.files),
      this.deps.files,
    );
    return { ...input, ...processNetwork(declaration.input, config) };
  }
  async package(input: import('@platform/contracts').ConnectionInput) {
    const declaration = await npmDeclaration(
      await pythonDeclaration(input, this.deps.files),
      this.deps.files,
    );
    const snapshot = await this.snapshot();
    const spec = resolvePackage(declaration.input, snapshot.config);
    return {
      spec,
      headers: spec?.ecosystem === 'npm' ? npmAuthorization(spec.source, declaration.auth) : {},
    };
  }
  async git(url: string) {
    const { config } = await this.snapshot();
    return {
      url: githubClone(url, config),
      env: processNetwork({}, config).env,
      token:
        new URL(url).hostname === 'github.com' && config.githubClone
          ? config.secrets.githubCloneToken
          : undefined,
    };
  }
  async close() {
    await this.current?.client.close();
    await Promise.all([...this.retired].map((client) => client.close()));
  }
}
