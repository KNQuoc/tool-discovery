#!/usr/bin/env node
/**
 * generate.mjs — Turn discovered API endpoints into workflow nodes
 * 
 * Takes tool-discovery JSON output and generates:
 * 1. Universal node schema (engine-agnostic)
 * 2. Engine-specific adapters (jam-nodes, openai, langchain, n8n)
 * 
 * Usage:
 *   node generate.mjs <discovery.json> [--adapter jam-nodes|openai|langchain|n8n] [--output dir] [--base-url https://api.example.com]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// ═══════════════════════════════════════════════════════════════
// Universal Node Schema
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a discovered tool to a universal node schema.
 * Engine-agnostic — just describes what the node does.
 * 
 * Universal schema shape:
 * {
 *   id: string,              // unique node type id (e.g. "stripe__create_customer")
 *   name: string,            // display name
 *   description: string,
 *   service: string,         // service name derived from API
 *   category: string,        // "integration"
 *   inputs: [{ name, type, required, description, enum?, default? }],
 *   outputs: [{ name, type, description }],
 *   execution: {
 *     method: string,
 *     pathTemplate: string,  // e.g. "/v1/customers/{id}"
 *     pathParams: string[],  // params that go in the URL
 *     queryParams: string[], // params that go in query string (GET)
 *     bodyParams: string[],  // params that go in body (POST/PUT/PATCH)
 *   },
 *   auth: { type, header?, scheme? } | null,
 *   source: { url, type, discoveredAt }
 * }
 */
function toUniversalNode(tool, serviceName) {
  const method = (tool.method || 'GET').toUpperCase();
  const path = tool.path || '/';
  
  // Extract path params from template (e.g. {id}, {external_delivery_id})
  const pathParamNames = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  
  // Classify params
  const params = tool.params || [];
  const pathParams = [];
  const queryParams = [];
  const bodyParams = [];
  
  for (const p of params) {
    if (pathParamNames.includes(p.name)) {
      pathParams.push(p.name);
    } else if (method === 'GET' || method === 'DELETE') {
      queryParams.push(p.name);
    } else {
      bodyParams.push(p.name);
    }
  }
  
  // Build typed inputs (deduplicate by name — some APIs list same param in path + body)
  const seenParams = new Set();
  const inputs = params.filter(p => {
    if (seenParams.has(p.name)) return false;
    seenParams.add(p.name);
    return true;
  }).map(p => ({
    name: p.name,
    type: normalizeType(p.type),
    required: p.required || false,
    description: p.description || '',
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  }));
  
  // Build outputs — use response schema if available, otherwise infer from method/name
  let outputs;
  if (tool.responseSchema) {
    outputs = parseResponseSchema(tool.responseSchema);
  } else {
    outputs = inferOutputSchema(tool.name, method, path);
  }
  
  const id = `${sanitizeId(serviceName)}__${sanitizeId(tool.name)}`;
  
  return {
    id,
    name: humanize(tool.name),
    description: tool.description || `${method} ${path}`,
    service: serviceName,
    category: 'integration',
    inputs,
    outputs,
    execution: {
      method,
      pathTemplate: path,
      pathParams,
      queryParams,
      bodyParams,
    },
    auth: tool.auth || null,
    source: {
      url: tool.sourceUrl,
      type: tool.sourceType,
      discoveredAt: new Date().toISOString(),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Adapters
// ═══════════════════════════════════════════════════════════════

/**
 * JAM-NODES adapter
 * Generates TypeScript NodeDefinition files with Zod schemas
 */
function toJamNodes(universalNodes, serviceName, baseUrl) {
  const ServicePascal = pascalCase(serviceName);
  
  // Deduplicate method names — suffix with _v2, _v3, etc.
  const methodNameCounts = {};
  const methodNameMap = new Map(); // node.id -> unique method name
  for (const node of universalNodes) {
    const base = camelCase(node.name.replace(/\s+/g, '_'));
    methodNameCounts[base] = (methodNameCounts[base] || 0) + 1;
  }
  const methodNameSeen = {};
  for (const node of universalNodes) {
    const base = camelCase(node.name.replace(/\s+/g, '_'));
    if (methodNameCounts[base] > 1) {
      methodNameSeen[base] = (methodNameSeen[base] || 0) + 1;
      methodNameMap.set(node.id, methodNameSeen[base] === 1 ? base : `${base}_v${methodNameSeen[base]}`);
    } else {
      methodNameMap.set(node.id, base);
    }
  }
  
  // ─── File 1: types (service client interface) ───────────────
  
  const methodSignatures = universalNodes.map(node => {
    const methodName = methodNameMap.get(node.id);
    
    // Build params type inline
    const paramFields = node.inputs.map(i => {
      const tsType = typeToTS(i.type);
      return `    ${safeName(i.name)}${i.required ? '' : '?'}: ${tsType};`;
    }).join('\n');
    
    // Build return type from outputs (skip status/ok — those are HTTP-level)
    const returnFields = node.outputs
      .filter(o => o.name !== 'status' && o.name !== 'ok')
      .map(o => `    ${safeName(o.name)}: ${typeToTS(o.type)};`)
      .join('\n');
    
    const paramsType = paramFields ? `params: {\n${paramFields}\n  }` : '';
    const returnType = returnFields ? `{\n${returnFields}\n  }` : 'void';
    const desc = node.description ? `  /** ${node.description} */\n` : '';
    
    return `${desc}  ${methodName}(${paramsType}): Promise<${returnType}>;`;
  }).join('\n\n');
  
  const typesFile = `/**
 * ${ServicePascal} service client interface.
 * Generated by tool-discovery — matches jam-nodes service pattern.
 * 
 * Inject via context.services.${serviceName} in your workflow engine.
 */

export interface ${ServicePascal}Client {
${methodSignatures}
}
`;

  // ─── File 2: client implementation ───────────────────────────
  
  const clientMethods = universalNodes.map(node => {
    const methodName = methodNameMap.get(node.id);
    
    // Build path params replacement
    const pathParamLines = node.execution.pathParams.map(p =>
      `      path = path.replace('{${p}}', encodeURIComponent(String(params.${safeName(p)})));`
    ).join('\n');
    
    // Build query params
    const queryParamLines = node.execution.queryParams.map(p =>
      `      if (params.${safeName(p)} !== undefined) query.append('${p}', String(params.${safeName(p)}));`
    ).join('\n');
    
    // Build body
    const bodyFields = node.execution.bodyParams;
    const bodyObj = bodyFields.length > 0
      ? `{ ${bodyFields.map(p => `${safeName(p)}: params.${safeName(p)}`).join(', ')} }`
      : 'undefined';
    
    const hasQuery = node.execution.queryParams.length > 0;
    const hasBody = bodyFields.length > 0 && ['POST', 'PUT', 'PATCH'].includes(node.execution.method);
    
    return `    async ${methodName}(${node.inputs.length > 0 ? 'params: any' : ''}) {
      let path = '${node.execution.pathTemplate}';
${pathParamLines ? pathParamLines + '\n' : ''}${hasQuery ? `      const query = new URLSearchParams();\n${queryParamLines}\n      const qs = query.toString();\n      if (qs) path += '?' + qs;\n` : ''}
      return request('${node.execution.method}', path${hasBody ? `, ${bodyObj}` : ''});
    }`;
  }).join(',\n\n');

  const clientFile = `/**
 * ${ServicePascal} API client implementation.
 * Generated by tool-discovery.
 * 
 * Usage:
 *   const client = create${ServicePascal}Client({ apiKey: process.env.${serviceName.toUpperCase()}_API_KEY });
 *   context.services.${serviceName} = client;
 */

import type { ${ServicePascal}Client } from './${sanitizeId(serviceName)}-types';

export interface ${ServicePascal}ClientConfig {
  /** API base URL (default: ${baseUrl || 'https://api.example.com'}) */
  baseUrl?: string;
  /** Bearer token or API key */
  apiKey: string;
  /** Custom auth header name (default: Authorization) */
  authHeader?: string;
  /** Auth scheme (default: Bearer) */
  authScheme?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retries on transient errors (default: 3) */
  maxRetries?: number;
}

export function create${ServicePascal}Client(config: ${ServicePascal}ClientConfig): ${ServicePascal}Client {
  const baseUrl = (config.baseUrl || ${JSON.stringify(baseUrl || 'https://api.example.com')}).replace(/\\/$/, '');
  const timeout = config.timeout ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const authHeader = config.authHeader || 'Authorization';
  const authScheme = config.authScheme || 'Bearer';

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const url = baseUrl + path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      [authHeader]: authHeader === 'Authorization' ? \`\${authScheme} \${config.apiKey}\` : config.apiKey,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Rate limit handling
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * Math.pow(2, attempt);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
        }

        // Parse response
        const contentType = response.headers.get('content-type') || '';
        let data: any;
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const text = await response.text();
          try { data = JSON.parse(text); } catch { data = text; }
        }

        if (!response.ok) {
          // Retry on transient errors
          if ([502, 503, 504].includes(response.status) && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            continue;
          }
          // Structured error
          const msg = data?.error?.message || data?.message || data?.error || JSON.stringify(data);
          throw new Error(\`[${serviceName}] \${response.status}: \${msg}\`);
        }

        return data;
      } catch (error: any) {
        clearTimeout(timeoutId);
        lastError = error;

        if (error.name === 'AbortError') {
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(\`[${serviceName}] Request timed out after \${timeout}ms\`);
        }

        // Network errors — retry
        if (attempt < maxRetries && !(error.message || '').includes('[${serviceName}]')) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  return {
${clientMethods}
  };
}
`;

  // ─── File 3: nodes (clean, call context.services) ────────────
  
  const nodeDefinitions = universalNodes.map(node => {
    const methodName = methodNameMap.get(node.id);
    
    // Deduplicate inputs by name (some APIs have same param as path + body)
    const seenInputs = new Set();
    const dedupedInputs = node.inputs.filter(i => {
      const key = safeName(i.name);
      if (seenInputs.has(key)) return false;
      seenInputs.add(key);
      return true;
    });
    const inputSchemaFields = dedupedInputs.map(i => {
      let zodType = typeToZod(i);
      if (!i.required) zodType += '.optional()';
      const desc = i.description ? `.describe(${JSON.stringify(i.description)})` : '';
      return `  ${safeName(i.name)}: ${zodType}${desc},`;
    }).join('\n');

    const outputSchemaFields = node.outputs.map(o => {
      const zodType = typeToZod(o);
      const desc = o.description ? `.describe(${JSON.stringify(o.description)})` : '';
      return `  ${safeName(o.name)}: ${zodType}${desc},`;
    }).join('\n');

    const isList = node.execution.method === 'GET' && 
      (node.name.startsWith('List') || node.name.startsWith('Search') || node.name.startsWith('Get All'));

    // Build the params object passed to the client method
    const paramEntries = node.inputs.map(i => safeName(i.name)).join(', ');
    const paramsObj = paramEntries ? `{ ${paramEntries} }` : '';

    return `
// ── ${node.name} ──────────────────────────────────────

export const ${camelCase(node.id)}InputSchema = z.object({
${inputSchemaFields}
});

export const ${camelCase(node.id)}OutputSchema = z.object({
${outputSchemaFields}
});

export const ${camelCase(node.id)}Node = defineNode({
  type: '${node.id}',
  name: ${JSON.stringify(node.name)},
  description: ${JSON.stringify(node.description)},
  category: 'integration',
  inputSchema: ${camelCase(node.id)}InputSchema,
  outputSchema: ${camelCase(node.id)}OutputSchema,
  estimatedDuration: ${isList ? 10 : 5},
  capabilities: { supportsRerun: true },
  executor: async (input, context) => {
    const client = (context.services as any)?.${serviceName} as import('./${sanitizeId(serviceName)}-types').${ServicePascal}Client | undefined;
    if (!client) {
      return {
        success: false,
        error: '${ServicePascal} service not configured. Provide context.services.${serviceName}.',
      };
    }

    try {
      const result = await client.${methodName}(${paramsObj ? `{ ${node.inputs.map(i => `${safeName(i.name)}: input.${safeName(i.name)}`).join(', ')} } as any` : ''});
      return {
        success: true,
        output: result as any,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }
  },
});`;
  }).join('\n');

  // Index export
  const indexExports = [
    `export type { ${ServicePascal}Client } from './${sanitizeId(serviceName)}-types';`,
    `export { create${ServicePascal}Client } from './${sanitizeId(serviceName)}-client';`,
    ...universalNodes.map(n =>
      `export { ${camelCase(n.id)}Node } from './${sanitizeId(serviceName)}-nodes';`
    ),
  ].join('\n');

  const nodesFile = `import { z } from 'zod';
import { defineNode } from '@jam-nodes/core';
${nodeDefinitions}
`;

  return {
    typesFile,
    clientFile,
    nodesFile,
    indexFile: indexExports,
    nodeCount: universalNodes.length,
  };
}

/** Map discovery types to TypeScript types */
function typeToTS(type) {
  switch (type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'unknown[]';
    case 'object': return 'Record<string, unknown>';
    default: return 'string';
  }
}

/**
 * OPENAI FUNCTIONS adapter
 * Generates OpenAI function-calling compatible schemas
 */
function toOpenAIFunctions(universalNodes) {
  return universalNodes.map(node => ({
    type: 'function',
    function: {
      name: node.id,
      description: node.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          node.inputs.map(i => [i.name, {
            type: mapToJsonSchemaType(i.type),
            description: i.description,
            ...(i.enum ? { enum: i.enum } : {}),
            ...(i.default !== undefined ? { default: i.default } : {}),
          }])
        ),
        required: node.inputs.filter(i => i.required).map(i => i.name),
      },
    },
  }));
}

/**
 * LANGCHAIN TOOLS adapter
 * Generates LangChain-compatible tool definitions
 */
function toLangChainTools(universalNodes, serviceName, baseUrl) {
  const toolDefs = universalNodes.map(node => {
    const zodFields = node.inputs.map(i => {
      const base = typeToZodBase(i.type);
      const zodCall = base.includes('(') ? `z.${base}` : `z.${base}()`;
      let field = `  ${safeName(i.name)}: ${zodCall}`;
      if (i.description) field += `.describe(${JSON.stringify(i.description)})`;
      if (!i.required) field += `.optional()`;
      return field + ',';
    }).join('\n');

    return `
export const ${camelCase(node.id)}Tool = new DynamicStructuredTool({
  name: ${JSON.stringify(node.id)},
  description: ${JSON.stringify(node.description)},
  schema: z.object({
${zodFields}
  }),
  func: async (input) => {
    // HTTP execution — inject your own fetch + auth here
    return JSON.stringify({ todo: 'implement' });
  },
});`;
  }).join('\n');

  return `import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
${toolDefs}
`;
}

/**
 * N8N NODES adapter
 * Generates n8n-compatible node description JSON
 */
function toN8nNodes(universalNodes, serviceName) {
  return universalNodes.map(node => ({
    displayName: node.name,
    name: node.id,
    group: ['transform'],
    version: 1,
    description: node.description,
    defaults: { name: node.name },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{
      name: `${serviceName}Api`,
      required: true,
    }],
    properties: node.inputs.map(i => ({
      displayName: humanize(i.name),
      name: i.name,
      type: mapToN8nType(i.type),
      required: i.required,
      default: i.default ?? '',
      description: i.description,
      ...(i.enum ? { options: i.enum.map(e => ({ name: e, value: e })) } : {}),
    })),
  }));
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function normalizeType(t) {
  if (!t) return 'string';
  if (typeof t !== 'string') return 'object';
  const lower = t.toLowerCase();
  if (['string', 'str', 'text'].includes(lower)) return 'string';
  if (['number', 'int', 'integer', 'float', 'double', 'decimal'].includes(lower)) return 'number';
  if (['boolean', 'bool'].includes(lower)) return 'boolean';
  if (['array', 'list'].includes(lower)) return 'array';
  if (['object', 'json', 'map', 'dict', 'hash'].includes(lower)) return 'object';
  if (['file', 'binary', 'blob'].includes(lower)) return 'file';
  return 'string';
}

function typeToZod(field) {
  const t = field.type || 'string';
  if (field.enum && field.enum.length > 0) {
    const vals = field.enum.filter(e => typeof e === 'string' && e.length > 0);
    if (vals.length > 0) {
      return `z.enum([${vals.map(e => JSON.stringify(e)).join(', ')}])`;
    }
  }
  const base = typeToZodBase(t);
  // typeToZodBase may return compound like "array(z.unknown())" — don't append ()
  const zodStr = base.includes('(') ? `z.${base}` : `z.${base}()`;
  // Don't emit .default(null) — Zod doesn't accept null as default for non-nullable types
  if (field.default !== undefined && field.default !== null) {
    return `${zodStr}.default(${JSON.stringify(field.default)})`;
  }
  return zodStr;
}

function typeToZodBase(type) {
  switch (type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array(z.unknown())';  // can't know inner type
    case 'object': return 'record(z.string(), z.unknown())';
    case 'file': return 'string'; // file paths as strings
    default: return 'string';
  }
}

function mapToJsonSchemaType(type) {
  switch (type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array';
    case 'object': return 'object';
    default: return 'string';
  }
}

function mapToN8nType(type) {
  switch (type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'json';
    default: return 'string';
  }
}

function sanitizeId(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function safeName(s) {
  // JS property name safe — replace dashes/dots with underscores
  return s.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function camelCase(s) {
  let result = s.replace(/[_-](\w)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
  // Ensure valid JS identifier — prefix with _ if starts with digit
  if (/^\d/.test(result)) result = '_' + result;
  return result;
}

function pascalCase(s) {
  return s.replace(/(^|[_-])(\w)/g, (_, __, c) => c.toUpperCase());
}

function humanize(s) {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Infer output schema from endpoint name/method/path when no explicit schema exists.
 * Smarter than always returning generic {status, body, ok}.
 */
function inferOutputSchema(name, method, path) {
  const nameLower = (name || '').toLowerCase();
  const base = [
    { name: 'status', type: 'number', description: 'HTTP status code' },
    { name: 'ok', type: 'boolean', description: 'Whether request succeeded (2xx)' },
  ];
  
  // DELETE typically returns minimal data
  if (method === 'DELETE') {
    return [
      ...base,
      { name: 'deleted', type: 'boolean', description: 'Whether the resource was deleted' },
    ];
  }
  
  // List/search endpoints return arrays
  if (nameLower.startsWith('list') || nameLower.startsWith('search') || nameLower.startsWith('get_all')) {
    return [
      ...base,
      { name: 'items', type: 'array', description: 'Array of returned items' },
      { name: 'total', type: 'number', description: 'Total number of items (if provided)' },
      { name: 'hasMore', type: 'boolean', description: 'Whether more items exist' },
    ];
  }
  
  // Create endpoints return the created resource
  if (nameLower.startsWith('create') || method === 'POST') {
    return [
      ...base,
      { name: 'id', type: 'string', description: 'ID of the created resource' },
      { name: 'body', type: 'object', description: 'Created resource data' },
    ];
  }
  
  // Update endpoints
  if (nameLower.startsWith('update') || method === 'PUT' || method === 'PATCH') {
    return [
      ...base,
      { name: 'body', type: 'object', description: 'Updated resource data' },
    ];
  }
  
  // Get/retrieve single resource
  if (nameLower.startsWith('get') || nameLower.startsWith('retrieve') || nameLower.startsWith('fetch')) {
    return [
      ...base,
      { name: 'body', type: 'object', description: 'Resource data' },
    ];
  }
  
  // Default fallback
  return [
    ...base,
    { name: 'body', type: 'object', description: 'Response body' },
  ];
}

function parseResponseSchema(schema) {
  // Try to parse response schema into output fields
  if (typeof schema === 'object' && schema.properties) {
    return Object.entries(schema.properties).map(([name, prop]) => ({
      name,
      type: normalizeType(prop.type),
      description: prop.description || '',
    }));
  }
  return [
    { name: 'status', type: 'number', description: 'HTTP status code' },
    { name: 'body', type: 'object', description: 'Response body' },
    { name: 'ok', type: 'boolean', description: 'Whether request succeeded (2xx)' },
  ];
}

function log(msg) {
  process.stderr.write(`[generate] ${msg}\n`);
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node generate.mjs <discovery.json> [options]

Options:
  --adapter <type>     Output format: jam-nodes, openai, langchain, n8n, universal (default: universal)
  --output <dir>       Output directory (default: ./generated)
  --base-url <url>     API base URL for the generated nodes
  --service <name>     Service name (auto-detected from URL if not specified)

Examples:
  node generate.mjs test-stripe.json --adapter jam-nodes --base-url https://api.stripe.com
  node generate.mjs test-wordpress.json --adapter openai --service wordpress
  node generate.mjs test-resend.json --adapter langchain --base-url https://api.resend.com
  node generate.mjs test-doordash.json --adapter n8n --service doordash
`);
    process.exit(0);
  }
  
  const inputFile = args[0];
  const adapterIdx = args.indexOf('--adapter');
  const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : 'universal';
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : './generated';
  const baseUrlIdx = args.indexOf('--base-url');
  const baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : '';
  const serviceIdx = args.indexOf('--service');
  
  // Load discovery JSON
  log(`Loading ${inputFile}...`);
  const discovery = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const tools = discovery.tools || [];
  
  if (tools.length === 0) {
    log('No tools found in discovery file');
    process.exit(1);
  }
  
  // Derive service name
  let serviceName;
  if (serviceIdx >= 0) {
    serviceName = args[serviceIdx + 1];
  } else {
    try {
      const host = new URL(discovery.url).hostname;
      serviceName = host.replace(/^(api|developer|docs)\./, '').split('.')[0];
    } catch {
      serviceName = basename(inputFile, '.json').replace('test-', '');
    }
  }
  
  log(`Service: ${serviceName}`);
  log(`Tools: ${tools.length}`);
  log(`Adapter: ${adapter}`);
  
  // Step 1: Convert to universal schema + deduplicate IDs
  const rawNodes = tools.map(t => toUniversalNode(t, serviceName));
  const idCounts = {};
  const universalNodes = rawNodes.map(node => {
    idCounts[node.id] = (idCounts[node.id] || 0) + 1;
    if (idCounts[node.id] > 1) {
      const suffix = `_v${idCounts[node.id]}`;
      return { ...node, id: node.id + suffix, name: node.name + ` V${idCounts[node.id]}` };
    }
    return node;
  });
  
  // Step 2: Apply adapter
  mkdirSync(outputDir, { recursive: true });
  
  switch (adapter) {
    case 'universal': {
      const outFile = join(outputDir, `${sanitizeId(serviceName)}-nodes.json`);
      writeFileSync(outFile, JSON.stringify({ service: serviceName, baseUrl, nodes: universalNodes }, null, 2));
      log(`✅ Wrote ${universalNodes.length} universal nodes to ${outFile}`);
      break;
    }
    
    case 'jam-nodes': {
      const result = toJamNodes(universalNodes, serviceName, baseUrl);
      const sId = sanitizeId(serviceName);
      writeFileSync(join(outputDir, `${sId}-types.ts`), result.typesFile);
      writeFileSync(join(outputDir, `${sId}-client.ts`), result.clientFile);
      writeFileSync(join(outputDir, `${sId}-nodes.ts`), result.nodesFile);
      writeFileSync(join(outputDir, 'index.ts'), result.indexFile);
      log(`✅ Wrote ${result.nodeCount} jam-nodes (3 files: types + client + nodes)`);
      break;
    }
    
    case 'openai': {
      const functions = toOpenAIFunctions(universalNodes);
      const outFile = join(outputDir, `${sanitizeId(serviceName)}-functions.json`);
      writeFileSync(outFile, JSON.stringify(functions, null, 2));
      log(`✅ Wrote ${functions.length} OpenAI function schemas to ${outFile}`);
      break;
    }
    
    case 'langchain': {
      const code = toLangChainTools(universalNodes, serviceName, baseUrl);
      const outFile = join(outputDir, `${sanitizeId(serviceName)}-tools.ts`);
      writeFileSync(outFile, code);
      log(`✅ Wrote ${universalNodes.length} LangChain tools to ${outFile}`);
      break;
    }
    
    case 'n8n': {
      const nodes = toN8nNodes(universalNodes, serviceName);
      const outFile = join(outputDir, `${sanitizeId(serviceName)}-n8n-nodes.json`);
      writeFileSync(outFile, JSON.stringify(nodes, null, 2));
      log(`✅ Wrote ${nodes.length} n8n node definitions to ${outFile}`);
      break;
    }
    
    default:
      log(`Unknown adapter: ${adapter}. Use: universal, jam-nodes, openai, langchain, n8n`);
      process.exit(1);
  }
  
  // Print summary
  log(`\n📊 Summary:`);
  log(`  Service: ${serviceName}`);
  log(`  Nodes generated: ${universalNodes.length}`);
  log(`  Adapter: ${adapter}`);
  log(`  Output: ${outputDir}/`);
  
  const methods = {};
  universalNodes.forEach(n => {
    const m = n.execution.method;
    methods[m] = (methods[m] || 0) + 1;
  });
  log(`  Methods: ${Object.entries(methods).map(([m, c]) => `${m}:${c}`).join(' ')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
