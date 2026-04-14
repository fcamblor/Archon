import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// File system mock — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockReadFile = mock(async (_path: string, _encoding: string): Promise<string> => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
});

mock.module('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mock(async () => {}),
  mkdir: mock(async () => {}),
}));

// ---------------------------------------------------------------------------
// Core module mocks (identical to api.health.test.ts)
// ---------------------------------------------------------------------------

const mockGetStats = mock(() => ({
  active: 0,
  queuedTotal: 0,
  queuedByConversation: [] as { conversationId: string; queuedMessages: number }[],
  maxConcurrent: 10,
  activeConversationIds: [] as string[],
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mock(() => 'sqlite' as const),
  loadConfig: mock(async () => ({
    assistants: { claude: { model: 'sonnet' } },
    worktree: { baseBranch: 'main' },
  })),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  isDocker: mock(() => false),
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {
    'archon-assist': '# archon-assist command',
    plan: '# plan command',
    implement: '# implement command',
  },
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Hono = InstanceType<typeof OpenAPIHono>;

function makeApp(): Hono {
  const app = new OpenAPIHono();
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getAbortSignal: mock((_id: string) => undefined),
    getStats: mockGetStats,
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const VALID_USAGES = {
  usages: [
    {
      email: 'user@example.com',
      lastUsageAcquiredOn: '2026-04-14T00:00:00Z',
      usage: {
        sessionUsage: 42,
        sessionResetAt: '2026-04-14T05:00:00Z',
        weeklyUsage: 75,
        weeklyResetAt: '2026-04-21T00:00:00Z',
        extraUsageEnabled: false,
      },
      lastError: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests: GET /api/ccstatusline/usages
// ---------------------------------------------------------------------------

describe('GET /api/ccstatusline/usages', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    // Default: all reads fail with ENOENT
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  test('returns 404 when usages file does not exist', async () => {
    // Both .claude.json and usages.json are ENOENT (default mock)
    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test('returns 200 with usage data when file exists and is valid', async () => {
    // First call: .claude.json → ENOENT (no active email)
    // Second call: usages.json → valid data
    mockReadFile
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async () => JSON.stringify(VALID_USAGES));

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as typeof VALID_USAGES & { activeEmail: string | null };
    expect(body.usages).toHaveLength(1);
    expect(body.usages[0].email).toBe('user@example.com');
    expect(body.activeEmail).toBeNull();
  });

  test('enriches response with activeEmail from .claude.json', async () => {
    // First call: .claude.json → has email
    // Second call: usages.json → valid data
    mockReadFile
      .mockImplementationOnce(async () =>
        JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com' } })
      )
      .mockImplementationOnce(async () => JSON.stringify(VALID_USAGES));

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { activeEmail: string | null };
    expect(body.activeEmail).toBe('user@example.com');
  });

  test('returns activeEmail null when .claude.json is missing', async () => {
    // First call: .claude.json → ENOENT
    // Second call: usages.json → valid data
    mockReadFile
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async () => JSON.stringify(VALID_USAGES));

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { activeEmail: string | null };
    expect(body.activeEmail).toBeNull();
  });

  test('returns activeEmail null when .claude.json has no oauthAccount', async () => {
    // .claude.json exists but has different shape
    mockReadFile
      .mockImplementationOnce(async () => JSON.stringify({ someOtherKey: 'value' }))
      .mockImplementationOnce(async () => JSON.stringify(VALID_USAGES));

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { activeEmail: string | null };
    expect(body.activeEmail).toBeNull();
  });

  test('returns 500 when usages file has unexpected format', async () => {
    // First call: .claude.json → ENOENT
    // Second call: usages.json → wrong JSON shape
    mockReadFile
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async () => JSON.stringify({ wrong: 'shape' }));

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unexpected format');
  });

  test('returns 500 when usages file contains invalid JSON', async () => {
    // First call: .claude.json → ENOENT
    // Second call: usages.json → invalid JSON
    mockReadFile
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async () => 'not-valid-json{{{');

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(500);
  });

  test('returns 500 when usages file read fails with non-ENOENT error', async () => {
    // First call: .claude.json → ENOENT
    // Second call: usages.json → permission denied
    mockReadFile
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      });

    const app = makeApp();
    const response = await app.request('/api/ccstatusline/usages');
    expect(response.status).toBe(500);
  });
});
