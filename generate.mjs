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
  
  // Build typed inputs
  const inputs = params.map(p => ({
    name: p.name,
    type: normalizeType(p.type),
    required: p.required || false,
    description: p.description || '',
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  }));
  
  // Build outputs — we don't always know the response schema,
  // so provide sensible defaults
  const outputs = tool.responseSchema
    ? parseResponseSchema(tool.responseSchema)
    : [
        { name: 'status', type: 'number', description: 'HTTP status code' },
        { name: 'body', type: 'object', description: 'Response body' },
        { name: 'ok', type: 'boolean', description: 'Whether request succeeded (2xx)' },
      ];
  
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
  const imports = `import { z } from 'zod';
import { defineNode } from '@jam-nodes/core';
import type { NodeExecutionContext } from '@jam-nodes/core';`;

  const credentialType = `
/**
 * Credential configuration for ${serviceName} API.
 * Injected at runtime via context.services.credentials
 */
export interface ${pascalCase(serviceName)}Credentials {
  baseUrl: string;
  ${universalNodes[0]?.auth?.type === 'bearer' ? 'token: string;' : 'apiKey: string;'}
}

function getCredentials(context: NodeExecutionContext): ${pascalCase(serviceName)}Credentials {
  const creds = context.services?.credentials?.['${serviceName}'] as ${pascalCase(serviceName)}Credentials | undefined;
  if (!creds) throw new Error('Missing ${serviceName} credentials. Configure them in your workflow settings.');
  return creds;
}

function buildUrl(creds: ${pascalCase(serviceName)}Credentials, pathTemplate: string, pathParams: Record<string, string> = {}): string {
  let path = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    path = path.replace(\`{\${key}}\`, encodeURIComponent(value));
  }
  return \`\${creds.baseUrl.replace(/\\/$/, '')}\${path}\`;
}

function buildHeaders(creds: ${pascalCase(serviceName)}Credentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ${universalNodes[0]?.auth?.type === 'bearer'
      ? "'Authorization': `Bearer ${creds.token}`,"
      : universalNodes[0]?.auth?.header
        ? `'${universalNodes[0].auth.header}': creds.apiKey,`
        : "'Authorization': `Bearer ${creds.apiKey}`,"}
  };
}
`;

  const nodeDefinitions = universalNodes.map(node => {
    const inputSchemaFields = node.inputs.map(i => {
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

    // Build path params extraction
    const pathParamEntries = node.execution.pathParams.map(p =>
      `    ${safeName(p)}: String(input.${safeName(p)}),`
    ).join('\n');

    // Build query string
    const queryLines = node.execution.queryParams.map(p =>
      `    if (input.${safeName(p)} !== undefined) params.append('${p}', String(input.${safeName(p)}));`
    ).join('\n');

    // Build body
    const bodyFields = node.execution.bodyParams.map(p =>
      `      ${safeName(p)}: input.${safeName(p)},`
    ).join('\n');

    const hasQuery = node.execution.queryParams.length > 0;
    const hasBody = node.execution.bodyParams.length > 0;
    const hasPathParams = node.execution.pathParams.length > 0;

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
  estimatedDuration: 5,
  capabilities: { supportsRerun: true },
  executor: async (input, context) => {
    const creds = getCredentials(context);
    ${hasPathParams ? `const url = buildUrl(creds, '${node.execution.pathTemplate}', {\n${pathParamEntries}\n    });` : `const url = buildUrl(creds, '${node.execution.pathTemplate}');`}
${hasQuery ? `    const params = new URLSearchParams();\n${queryLines}\n    const fullUrl = params.toString() ? \`\${url}?\${params}\` : url;` : '    const fullUrl = url;'}

    try {
      const response = await fetch(fullUrl, {
        method: '${node.execution.method}',
        headers: buildHeaders(creds),
${hasBody ? `        body: JSON.stringify({\n${bodyFields}\n        }),` : ''}
      });

      const body = await response.json().catch(() => ({}));

      return {
        success: response.ok,
        output: {
          status: response.status,
          body,
          ok: response.ok,
        },
        ...(!response.ok ? { error: \`HTTP \${response.status}: \${JSON.stringify(body)}\` } : {}),
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
  const exports = universalNodes.map(n =>
    `export { ${camelCase(n.id)}Node } from './${sanitizeId(serviceName)}-nodes';`
  ).join('\n');

  return {
    nodeFile: `${imports}\n${credentialType}\n${nodeDefinitions}\n`,
    indexFile: exports,
    nodeCount: universalNodes.length,
  };
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
  return field.default !== undefined ? `${zodStr}.default(${JSON.stringify(field.default)})` : zodStr;
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
  
  // Step 1: Convert to universal schema
  const universalNodes = tools.map(t => toUniversalNode(t, serviceName));
  
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
      const nodeFile = join(outputDir, `${sanitizeId(serviceName)}-nodes.ts`);
      const indexFile = join(outputDir, 'index.ts');
      writeFileSync(nodeFile, result.nodeFile);
      writeFileSync(indexFile, result.indexFile);
      log(`✅ Wrote ${result.nodeCount} jam-nodes definitions to ${nodeFile}`);
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
