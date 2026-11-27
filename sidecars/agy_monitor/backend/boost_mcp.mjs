/**
 * Zero-dependency local Stdio MCP server for AGY Console "增强" (Boost) tools.
 *
 * Dynamically reads `user_prefs.json` -> `boost` on every `tools/list` and `tools/call`:
 * - Default (all OFF): exposes 0 tools (+0 context tokens).
 * - Only exposes tools belonging to enabled switches (`batchOps`, `compactOutput`, `outlineFirst`).
 */

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolvePaths } from './paths.mjs';
import {
  normalizeBoostConfig,
  readBoostConfigSync,
  runApplyEdits,
  runBatchSearch,
  runChecks,
  runCompactCommand,
  runQuickOutline,
  runReadSlices,
} from './boost_tools.mjs';

const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TOOL_SPECS = [
  {
    feature: 'batchOps',
    definition: {
      name: 'boost_batch_search',
      description: 'Run up to 20 concurrent text, regex, glob, fuzzy, or read-only git searches in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Base working directory (optional)' },
          queries: {
            type: 'array',
            description: 'List of search queries (max 20)',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text', 'regex', 'glob', 'fuzzy', 'git'] },
                pattern: { type: 'string' },
                path: { type: 'string' },
                glob: { type: 'string' },
                caseSensitive: { type: 'boolean' },
                outputMode: { type: 'string', enum: ['content', 'files_with_matches'] },
                maxResults: { type: 'integer' },
              },
              required: ['pattern'],
            },
          },
        },
        required: ['queries'],
      },
    },
    async handler(args, boost) {
      return runBatchSearch({ ...args, compact: boost.compactOutput });
    },
  },
  {
    feature: 'batchOps',
    definition: {
      name: 'boost_apply_edits',
      description: 'Atomically validate and apply multi-hunk edits across up to 50 files, with optional inline verify command.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          dryRun: { type: 'boolean' },
          verify: { type: 'string', description: 'Optional build/test command run after applying edits' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                create: { type: 'boolean' },
                content: { type: 'string' },
                hunks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      target: { type: 'string' },
                      replacement: { type: 'string' },
                      startLine: { type: 'integer' },
                      endLine: { type: 'integer' },
                      replaceAll: { type: 'boolean' },
                    },
                    required: ['target', 'replacement'],
                  },
                },
              },
              required: ['path'],
            },
          },
        },
        required: ['edits'],
      },
    },
    async handler(args, boost) {
      return runApplyEdits({ ...args, compact: boost.compactOutput });
    },
  },
  {
    feature: 'batchOps',
    definition: {
      name: 'boost_run_checks',
      description: 'Run up to 12 independent build, lint, or test commands concurrently with compact error-focused output.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          concurrency: { type: 'integer' },
          timeoutSec: { type: 'integer' },
          commands: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    command: { type: 'string' },
                  },
                  required: ['command'],
                },
              ],
            },
          },
        },
        required: ['commands'],
      },
    },
    async handler(args, boost) {
      return runChecks({ ...args, compact: boost.compactOutput });
    },
  },
  {
    feature: 'compactOutput',
    definition: {
      name: 'boost_compact_run',
      description: 'Run a shell command and fold its output strictly within 8.8 KB UTF-8 (Head-Tail error preservation, ANSI stripped).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeoutSec: { type: 'integer' },
        },
        required: ['command'],
      },
    },
    async handler(args) {
      return runCompactCommand(args);
    },
  },
  {
    feature: 'outlineFirst',
    definition: {
      name: 'boost_quick_outline',
      description: 'Extract multi-language symbol/section line outlines across up to 40 files before reading targeted slices.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
      },
    },
    async handler(args, boost) {
      return runQuickOutline({ ...args, compact: boost.compactOutput });
    },
  },
  {
    feature: 'outlineFirst',
    definition: {
      name: 'boost_read_slices',
      description: 'Read targeted [startLine, endLine] slices (and optional outlines) across multiple files in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          requests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                outline: { type: 'boolean' },
                startLine: { type: 'integer' },
                endLine: { type: 'integer' },
                ranges: { type: 'array' },
              },
              required: ['path'],
            },
          },
        },
        required: ['requests'],
      },
    },
    async handler(args, boost) {
      return runReadSlices({ ...args, compact: boost.compactOutput });
    },
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.definition.name, s]));

export function createBoostMcpDispatcher({ corePaths, getBoostConfig } = {}) {
  const paths = corePaths || resolvePaths();
  const readBoost =
    typeof getBoostConfig === 'function'
      ? () => normalizeBoostConfig(getBoostConfig())
      : () => readBoostConfigSync(paths.userPrefsFile);

  return async function dispatch(req) {
    if (!isPlainObject(req)) return null;
    const id = req.id !== undefined ? req.id : null;
    const method = typeof req.method === 'string' ? req.method : '';
    const params = isPlainObject(req.params) ? req.params : {};

    if (
      req.id === undefined ||
      !method ||
      method === 'notifications/initialized' ||
      method.startsWith('notifications/')
    ) {
      return null;
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'initialize') {
      const clientVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
          ? params.protocolVersion.trim()
          : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'agy-monitor-boost-mcp',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'tools/list') {
      const boost = readBoost();
      const tools = TOOL_SPECS.filter((s) => boost[s.feature] === true).map((s) => s.definition);
      return {
        jsonrpc: '2.0',
        id,
        result: { tools },
      };
    }

    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name.trim() : '';
      if (!toolName) {
        return { jsonrpc: '2.0', id, error: { code: ERR_INVALID_PARAMS, message: 'Missing tool name' } };
      }
      const spec = SPEC_BY_NAME.get(toolName);
      if (!spec) {
        return { jsonrpc: '2.0', id, error: { code: ERR_METHOD_NOT_FOUND, message: `Unknown tool: ${toolName}` } };
      }
      const boost = readBoost();
      if (!boost[spec.feature]) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: `功能未开启：请在 AGY 控制台「增强」分页启用 ${spec.feature} 后重试。`,
                }),
              },
            ],
          },
        };
      }

      const args = isPlainObject(params.arguments) ? params.arguments : {};
      try {
        const res = await spec.handler(args, boost);
        const text = typeof res?.text === 'string' ? res.text : JSON.stringify(res, null, 2);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text }],
            ...(res?.ok === false ? { isError: true } : {}),
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: ERR_INTERNAL, message: err?.message || String(err) },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${method}` },
    };
  };
}

async function runStdioServer() {
  const dispatch = createBoostMcpDispatcher();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const resp = await dispatch(parsed);
    if (resp) {
      process.stdout.write(`${JSON.stringify(resp)}\n`);
    }
  });
}

const isEntrypoint = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isEntrypoint) {
  runStdioServer().catch((err) => {
    process.stderr.write(`[boost_mcp] fatal: ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
