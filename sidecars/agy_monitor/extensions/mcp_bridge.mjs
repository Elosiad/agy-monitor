/**
 * Generic zero-dependency MCP stdio bridge for pluggable agy-monitor extensions.
 *
 * Auto-discovers `sidecars/agy_monitor/extensions/<name>/mcp_tools.mjs`.
 * - Deleting an extension directory or setting `AGY_DISABLE_EXTENSIONS=1` cleanly
 *   exposes an empty tool list without crashing.
 * - Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout (Antigravity MCP native format).
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePaths } from '../backend/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function extensionsDisabled() {
  return process.env.AGY_DISABLE_EXTENSIONS === '1' || process.env.AGY_DISABLE_EXTENSIONS === 'true';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Discover and instantiate MCP tools from every installed extension under `extensions/`.
 */
export async function loadExtensionMcpTools({ corePaths } = {}) {
  if (extensionsDisabled()) return [];
  const paths = corePaths || resolvePaths();
  const tools = [];
  try {
    const entries = await fs.readdir(__dirname, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    for (const dirName of dirs) {
      const mcpFile = path.join(__dirname, dirName, 'mcp_tools.mjs');
      if (!fsSync.existsSync(mcpFile)) continue;
      try {
        const mod = await import(pathToFileURL(mcpFile).href);
        const factory = mod?.createMcpTools || mod?.default;
        if (typeof factory === 'function') {
          const list = await factory({ corePaths: paths, extensionDir: path.join(__dirname, dirName) });
          if (Array.isArray(list)) {
            for (const item of list) {
              if (item?.definition?.name && typeof item.handler === 'function') {
                tools.push(item);
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[mcp_bridge] failed to load "${dirName}": ${err?.message || err}\n`);
      }
    }
  } catch {
    // Missing extensions directory -> expose empty toolset cleanly
  }
  return tools;
}

/**
 * Create a testable JSON-RPC 2.0 MCP request dispatcher.
 */
export function createMcpDispatcher(tools = []) {
  const registry = new Map();
  for (const t of tools) {
    if (t?.definition?.name && typeof t.handler === 'function') {
      registry.set(t.definition.name, t);
    }
  }

  return async function dispatch(req) {
    if (!isPlainObject(req)) return null;
    const id = req.id !== undefined ? req.id : null;
    const method = typeof req.method === 'string' ? req.method : '';
    const params = isPlainObject(req.params) ? req.params : {};

    // Notifications (no id) or responses (no method) require no response per JSON-RPC 2.0
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
            name: 'agy-monitor-extensions-mcp',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [...registry.values()].map((t) => t.definition),
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name.trim() : '';
      if (!toolName) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: ERR_INVALID_PARAMS, message: 'Missing tool name' },
        };
      }
      const tool = registry.get(toolName);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: ERR_METHOD_NOT_FOUND, message: `Unknown tool: ${toolName}` },
        };
      }
      const args = isPlainObject(params.arguments) ? params.arguments : {};
      try {
        const result = await tool.handler(args, { meta: params._meta });
        const content = Array.isArray(result?.content)
          ? result.content
          : [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content,
            ...(result?.isError ? { isError: true } : {}),
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: false, error: err?.message || String(err), code: err?.code || 'TOOL_ERROR' },
                  null,
                  2,
                ),
              },
            ],
          },
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

function isSameEntrypoint(argvPath, modulePath) {
  if (typeof argvPath !== 'string' || !argvPath) return false;
  try {
    const a = fsSync.realpathSync(path.resolve(argvPath));
    const b = fsSync.realpathSync(modulePath);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return path.resolve(argvPath).toLowerCase() === path.resolve(modulePath).toLowerCase();
  }
}

if (isSameEntrypoint(process.argv[1], __filename)) {
  // Keep stdout strictly reserved for JSON-RPC frames
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
  });

  const tools = await loadExtensionMcpTools();
  const dispatch = createMcpDispatcher(tools);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } })}\n`,
      );
      return;
    }
    void dispatch(parsed)
      .then((resp) => {
        if (resp) {
          process.stdout.write(`${JSON.stringify(resp)}\n`);
        }
      })
      .catch((err) => {
        if (parsed?.id === undefined) return;
        const errResp = {
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: ERR_INTERNAL, message: err?.message || String(err) },
        };
        process.stdout.write(`${JSON.stringify(errResp)}\n`);
      });
  });
}
