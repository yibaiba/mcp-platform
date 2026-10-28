import { scopeToolDefinition } from './catalogEntries.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { z } from 'zod';
import { artifactToolset, isArtifactTool } from '../artifacts/artifactTools.js';
import type { ArtifactService } from '../artifacts/artifactService.js';
import type { AccessService } from '../permissions/accessService.js';
import { availablePermissionTools, externalPermissionResult } from '../permissions/tools.js';
import type { RequestService } from '../permissions/requestService.js';
import {
  Server,
  type ServerContext,
  type RequestMethod,
  type RequestTypeMap,
  type HandlerResultTypeMap,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
} from '@modelcontextprotocol/server';
import type { Principal, ProfileService } from '../agent-profiles/profileService.js';
import type { InvocationService } from './invocationService.js';
import type { ContentService } from './contentService.js';
import type { ResourceSubscriptions } from './resourceSubscriptions.js';
import { currentExecution, withExecution } from './executionContext.js';
import { legacyToolDefinition, parseTool, isInputRequiredResult } from '@platform/mcp';

export type GatewayHandlers = {
  webOrigin: string;
  access: AccessService;
  artifacts: ArtifactService;
  requests: RequestService;
  logger: DiagnosticLogger;
  profiles: ProfileService;
  invocations: InvocationService;
  interactions: import('../interactions/interactionService.js').InteractionService;
  content: ContentService;
  subscriptions: ResourceSubscriptions;
};
export async function createGatewayServer(
  input: GatewayHandlers & { principal: Principal; channel: string; era: 'legacy' | 'modern' },
) {
  const { principal } = input;
  const execution = <T>(action: () => T) =>
    withExecution(
      {
        identity: principal.credentialId,
        ownerId: principal.ownerId,
        credentialId: principal.credentialId,
        profileId: principal.profileId,
        entry: 'gateway',
        sessionId: input.channel,
        headers: currentExecution()?.headers,
        capabilities: server.getClientCapabilities() ?? {},
      },
      action,
    );
  const access = () => ({ ...principal, principal });
  const server = new Server(
    { name: 'mcp-platform', version: '0.1.0' },
    {
      instructions: await input.profiles.instructions(principal.ownerId, principal.profileId),
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
    },
  );
  function setHandler<M extends RequestMethod>(
    method: M,
    handler: (
      request: RequestTypeMap[M],
      context: ServerContext,
    ) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>,
  ) {
    server.setRequestHandler(method, (request, context) =>
      execution(() => handler(request, context)),
    );
  }
  setHandler('tools/list', async () => {
    await input.profiles.authenticate(principal.profileId, principal.token);
    const rows = await input.profiles.describedCatalog(principal.ownerId, principal.profileId);
    const artifacts = await artifactToolset(input, access());
    return {
      tools: [
        ...(await availablePermissionTools(input.requests, access())),
        ...artifacts.tools,
        ...rows.map((row) => {
          const definition = {
            ...parseTool(scopeToolDefinition(row.connectionId, row.definition)),
            name: row.id,
          };
          return input.era === 'legacy' ? legacyToolDefinition(definition) : definition;
        }),
      ],
    };
  });
  setHandler('tools/call', async (request, context) => {
    const name = request.params.name;
    if (isArtifactTool(name)) {
      const artifacts = await artifactToolset(input, access());
      return artifacts.call(name, request.params.arguments ?? {}, context.mcpReq.signal);
    }
    if (name === 'platform_permissions_catalog')
      return {
        content: [{ type: 'text', text: JSON.stringify(await input.requests.catalog(access())) }],
      };
    if (name === 'platform_permissions_request')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              externalPermissionResult(
                await input.requests.create(access(), request.params.arguments),
                input.webOrigin,
              ),
            ),
          },
        ],
      };
    if (name === 'platform_permissions_status')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              externalPermissionResult(
                await input.requests.status(access(), z.uuid().parse(request.params.arguments?.id)),
                input.webOrigin,
              ),
            ),
          },
        ],
      };
    const toolId = name;
    const state = context.mcpReq.requestState();
    if (typeof state === 'string')
      return input.interactions.respond({
        ownerId: principal.ownerId,
        id: state,
        credentialId: principal.credentialId,
        toolId,
        responses: context.mcpReq.inputResponses as Record<
          string,
          import('@modelcontextprotocol/client').ElicitResult
        >,
      }) as Promise<import('@platform/mcp').McpToolResult>;
    let result = await input.invocations.dispatch({
      ...access(),
      toolId,
      arguments: request.params.arguments ?? {},
      ...(input.era === 'legacy'
        ? { signal: context.mcpReq.signal }
        : { requestSignal: context.mcpReq.signal }),
      onprogress: progressReporter(request.params._meta?.progressToken, context, input.logger),
    });
    while (input.era === 'legacy' && isInputRequiredResult(result)) {
      const responses: Record<string, import('@modelcontextprotocol/client').ElicitResult> = {};
      for (const [id, request] of Object.entries(result.inputRequests ?? {})) {
        if (request.method !== 'elicitation/create')
          throw new Error(`不支持交互方法 ${request.method}`);
        responses[id] = await context.mcpReq.elicitInput(
          request.params as import('@modelcontextprotocol/client').ElicitRequestParams,
          { timeout: 0 },
        );
      }
      result = (await input.interactions.respond({
        ownerId: principal.ownerId,
        id: result.requestState!,
        credentialId: principal.credentialId,
        toolId,
        responses,
      })) as typeof result;
    }
    return result;
  });
  setHandler('prompts/list', async () => ({
    prompts: (await input.content.catalog(access()))
      .filter((row) => row.kind === 'prompt')
      .map((row) => input.content.definition(row) as Prompt),
  }));
  setHandler('resources/list', async () => ({
    resources: (await input.content.catalog(access()))
      .filter((row) => row.kind === 'resource')
      .map((row) => input.content.definition(row) as Resource),
  }));
  setHandler('resources/templates/list', async () => ({
    resourceTemplates: (await input.content.catalog(access()))
      .filter((row) => row.kind === 'template')
      .map((row) => input.content.definition(row) as ResourceTemplateType),
  }));
  setHandler('prompts/get', (request, context) =>
    input.content.prompt({
      ...access(),
      id: request.params.name,
      arguments: request.params.arguments,
      signal: context.mcpReq.signal,
      onprogress: progressReporter(request.params._meta?.progressToken, context, input.logger),
    }),
  );
  setHandler('resources/read', (request, context) =>
    input.content.read({
      ...access(),
      uri: request.params.uri,
      signal: context.mcpReq.signal,
      onprogress: progressReporter(request.params._meta?.progressToken, context, input.logger),
    }),
  );
  setHandler('resources/subscribe', async (request, context) => {
    await input.subscriptions.subscribe({
      access: access(),
      channel: input.channel,
      uri: request.params.uri,
      signal: context.mcpReq.signal,
    });
    return {};
  });
  setHandler('resources/unsubscribe', async (request) => {
    await input.content.resolveResource(access(), request.params.uri);
    await input.subscriptions.release(input.channel, request.params.uri);
    return {};
  });
  return server;
}

function progressReporter(
  token: string | number | undefined,
  context: ServerContext,
  logger: DiagnosticLogger,
) {
  return token === undefined
    ? undefined
    : (progress: { progress: number; total?: number; message?: string }) => {
        void context.mcpReq
          .notify({
            method: 'notifications/progress',
            params: { ...progress, progressToken: token },
          })
          .catch(() => logger.report('MCP_PROGRESS_DELIVERY_FAILED'));
      };
}
