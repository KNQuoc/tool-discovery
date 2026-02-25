#!/usr/bin/env node
/**
 * registry.mjs — File-based node registry for tool-discovery
 * 
 * Stores generated nodes in ~/.tool-discovery/nodes/<service>/<version>/
 * Workflow engines read from here at startup.
 * 
 * Usage:
 *   node registry.mjs store <discovery.json> [--base-url <url>] [--service <name>]
 *   node registry.mjs list
 *   node registry.mjs info <service>
 *   node registry.mjs load <service> [--version <v>] [--adapter jam-nodes|openai|langchain|n8n]
 *   node registry.mjs remove <service> [--version <v>]
 *   node registry.mjs export <service> [--adapter jam-nodes|openai|langchain|n8n] [--output <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const REGISTRY_DIR = join(homedir(), '.tool-discovery', 'nodes');

function log(msg) { process.stderr.write(`[registry] ${msg}\n`); }

// ═══════════════════════════════════════════════════════════════
// Registry operations
// ═══════════════════════════════════════════════════════════════

function getServiceDir(service, version) {
  return join(REGISTRY_DIR, sanitizeId(service), version || 'v1');
}

function listServices() {
  if (!existsSync(REGISTRY_DIR)) return [];
  return readdirSync(REGISTRY_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const serviceDir = join(REGISTRY_DIR, d.name);
      const versions = readdirSync(serviceDir, { withFileTypes: true })
        .filter(v => v.isDirectory())
        .map(v => v.name)
        .sort((a, b) => {
          const na = parseInt(a.replace(/\D/g, '')) || 0;
          const nb = parseInt(b.replace(/\D/g, '')) || 0;
          return na - nb;
        });
      
      // Load metadata from latest version
      const latest = versions[versions.length - 1];
      const metaPath = join(serviceDir, latest, 'metadata.json');
      let meta = {};
      if (existsSync(metaPath)) {
        meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      }
      
      const nodesPath = join(serviceDir, latest, 'nodes.json');
      let nodeCount = 0;
      if (existsSync(nodesPath)) {
        const data = JSON.parse(readFileSync(nodesPath, 'utf-8'));
        nodeCount = data.nodes?.length || 0;
      }
      
      return {
        name: d.name,
        versions,
        latest,
        nodeCount,
        baseUrl: meta.baseUrl || '',
        discoveredFrom: meta.discoveredFrom || '',
        storedAt: meta.storedAt || '',
      };
    });
}

function storeService(discoveryJson, options = {}) {
  const discovery = JSON.parse(readFileSync(discoveryJson, 'utf-8'));
  const tools = discovery.tools || [];
  
  if (tools.length === 0) {
    log('No tools in discovery file');
    return null;
  }
  
  // Derive service name
  let serviceName = options.service;
  if (!serviceName) {
    try {
      const host = new URL(discovery.url).hostname;
      serviceName = host.replace(/^(api|developer|docs)\./, '').split('.')[0];
    } catch {
      serviceName = basename(discoveryJson, '.json').replace('test-', '');
    }
  }
  
  // Determine version
  const serviceBase = join(REGISTRY_DIR, sanitizeId(serviceName));
  let version = options.version || 'v1';
  if (!options.version && existsSync(serviceBase)) {
    const existing = readdirSync(serviceBase, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('v'))
      .map(d => parseInt(d.name.slice(1)))
      .filter(n => !isNaN(n));
    if (existing.length > 0) {
      version = `v${Math.max(...existing) + 1}`;
    }
  }
  
  const dir = getServiceDir(serviceName, version);
  mkdirSync(dir, { recursive: true });
  
  // Convert to universal nodes
  const universalNodes = tools.map(t => toUniversalNode(t, serviceName));
  
  // Store nodes.json (universal schema)
  writeFileSync(join(dir, 'nodes.json'), JSON.stringify({
    service: serviceName,
    baseUrl: options.baseUrl || '',
    nodes: universalNodes,
  }, null, 2));
  
  // Store metadata.json
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
    service: serviceName,
    version,
    baseUrl: options.baseUrl || '',
    discoveredFrom: discovery.url || discoveryJson,
    sourceType: discovery.sourceType || 'unknown',
    toolCount: universalNodes.length,
    storedAt: new Date().toISOString(),
    methods: countMethods(universalNodes),
  }, null, 2));
  
  // Store credentials template
  const authTypes = [...new Set(tools.filter(t => t.auth).map(t => t.auth.type))];
  if (authTypes.length > 0) {
    const credTemplate = {
      service: serviceName,
      baseUrl: options.baseUrl || '<API_BASE_URL>',
    };
    if (authTypes.includes('bearer')) {
      credTemplate.token = '<YOUR_API_TOKEN>';
    }
    if (authTypes.includes('api-key') || authTypes.includes('apiKey')) {
      credTemplate.apiKey = '<YOUR_API_KEY>';
      credTemplate.headerName = tools.find(t => t.auth?.header)?.auth.header || 'X-API-Key';
    }
    writeFileSync(join(dir, 'credentials.template.json'), JSON.stringify(credTemplate, null, 2));
  }
  
  // Store raw discovery for reference
  writeFileSync(join(dir, 'discovery.json'), readFileSync(discoveryJson));
  
  return { service: serviceName, version, nodeCount: universalNodes.length, dir };
}

function getServiceInfo(service) {
  const serviceDir = join(REGISTRY_DIR, sanitizeId(service));
  if (!existsSync(serviceDir)) return null;
  
  const versions = readdirSync(serviceDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const metaPath = join(serviceDir, d.name, 'metadata.json');
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : {};
      
      const nodesPath = join(serviceDir, d.name, 'nodes.json');
      let nodes = [];
      if (existsSync(nodesPath)) {
        const data = JSON.parse(readFileSync(nodesPath, 'utf-8'));
        nodes = data.nodes || [];
      }
      
      return {
        version: d.name,
        nodeCount: nodes.length,
        methods: meta.methods || {},
        storedAt: meta.storedAt || '',
        discoveredFrom: meta.discoveredFrom || '',
      };
    });
  
  return { service, versions };
}

function loadNodes(service, version) {
  const serviceDir = join(REGISTRY_DIR, sanitizeId(service));
  if (!existsSync(serviceDir)) return null;
  
  // Find version
  if (!version) {
    const versions = readdirSync(serviceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, '')) || 0;
        const nb = parseInt(b.replace(/\D/g, '')) || 0;
        return na - nb;
      });
    version = versions[versions.length - 1]; // latest
  }
  
  const nodesPath = join(serviceDir, version, 'nodes.json');
  if (!existsSync(nodesPath)) return null;
  
  return JSON.parse(readFileSync(nodesPath, 'utf-8'));
}

function removeService(service, version) {
  const serviceDir = join(REGISTRY_DIR, sanitizeId(service));
  if (!existsSync(serviceDir)) {
    log(`Service '${service}' not found`);
    return false;
  }
  
  if (version) {
    const vDir = join(serviceDir, version);
    if (!existsSync(vDir)) {
      log(`Version '${version}' not found for ${service}`);
      return false;
    }
    rmSync(vDir, { recursive: true });
    // Remove service dir if empty
    if (readdirSync(serviceDir).length === 0) rmSync(serviceDir);
    return true;
  }
  
  rmSync(serviceDir, { recursive: true });
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Universal node converter (same as generate.mjs)
// ═══════════════════════════════════════════════════════════════

function toUniversalNode(tool, serviceName) {
  const method = (tool.method || 'GET').toUpperCase();
  const path = tool.path || '/';
  const pathParamNames = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  
  const params = tool.params || [];
  const pathParams = [], queryParams = [], bodyParams = [];
  
  for (const p of params) {
    if (pathParamNames.includes(p.name)) pathParams.push(p.name);
    else if (method === 'GET' || method === 'DELETE') queryParams.push(p.name);
    else bodyParams.push(p.name);
  }
  
  const inputs = params.map(p => ({
    name: p.name,
    type: normalizeType(p.type),
    required: p.required || false,
    description: p.description || '',
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  }));
  
  const outputs = [
    { name: 'status', type: 'number', description: 'HTTP status code' },
    { name: 'body', type: 'object', description: 'Response body' },
    { name: 'ok', type: 'boolean', description: 'Whether request succeeded (2xx)' },
  ];
  
  return {
    id: `${sanitizeId(serviceName)}__${sanitizeId(tool.name)}`,
    name: humanize(tool.name),
    description: tool.description || `${method} ${path}`,
    service: serviceName,
    category: 'integration',
    inputs,
    outputs,
    execution: { method, pathTemplate: path, pathParams, queryParams, bodyParams },
    auth: tool.auth || null,
    source: { url: tool.sourceUrl, type: tool.sourceType, discoveredAt: new Date().toISOString() },
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function normalizeType(t) {
  if (!t) return 'string';
  if (typeof t !== 'string') return 'object';
  const lower = t.toLowerCase();
  if (['string', 'str', 'text'].includes(lower)) return 'string';
  if (['number', 'int', 'integer', 'float', 'double'].includes(lower)) return 'number';
  if (['boolean', 'bool'].includes(lower)) return 'boolean';
  if (['array', 'list'].includes(lower)) return 'array';
  if (['object', 'json', 'map'].includes(lower)) return 'object';
  return 'string';
}

function sanitizeId(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function humanize(s) { return s.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function countMethods(nodes) {
  const m = {};
  nodes.forEach(n => { const k = n.execution.method; m[k] = (m[k] || 0) + 1; });
  return m;
}

// ═══════════════════════════════════════════════════════════════
// Programmatic API (for workflow engines to import)
// ═══════════════════════════════════════════════════════════════

export { listServices, storeService, getServiceInfo, loadNodes, removeService, REGISTRY_DIR };

/**
 * Load all nodes from all services (for engine startup)
 * Returns flat array of universal nodes with service context
 */
export function loadAllNodes() {
  const services = listServices();
  const allNodes = [];
  for (const svc of services) {
    const data = loadNodes(svc.name);
    if (data?.nodes) {
      allNodes.push(...data.nodes.map(n => ({ ...n, _baseUrl: data.baseUrl })));
    }
  }
  return allNodes;
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === '--help') {
    console.log(`
Usage: node registry.mjs <command> [options]

Commands:
  store <discovery.json>   Store discovered API as nodes in the registry
    --base-url <url>       API base URL
    --service <name>       Service name (auto-detected if omitted)
    --version <v>          Version (auto-incremented if omitted)

  list                     List all registered services

  info <service>           Show details for a service

  load <service>           Load nodes JSON (pipe to other tools)
    --version <v>          Specific version (default: latest)

  remove <service>         Remove a service from the registry
    --version <v>          Remove specific version only

  export <service>         Export nodes in a specific adapter format
    --adapter <type>       jam-nodes, openai, langchain, n8n (default: universal)
    --output <dir>         Output directory
    --version <v>          Specific version

Registry location: ${REGISTRY_DIR}
`);
    process.exit(0);
  }
  
  switch (command) {
    case 'store': {
      const file = args[1];
      if (!file) { log('Missing discovery JSON file'); process.exit(1); }
      const baseUrlIdx = args.indexOf('--base-url');
      const serviceIdx = args.indexOf('--service');
      const versionIdx = args.indexOf('--version');
      
      const result = storeService(file, {
        baseUrl: baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : '',
        service: serviceIdx >= 0 ? args[serviceIdx + 1] : undefined,
        version: versionIdx >= 0 ? args[versionIdx + 1] : undefined,
      });
      
      if (result) {
        log(`✅ Stored ${result.nodeCount} nodes for ${result.service} (${result.version})`);
        log(`   Location: ${result.dir}`);
      }
      break;
    }
    
    case 'list': {
      const services = listServices();
      if (services.length === 0) {
        log('No services registered yet. Use "store" to add one.');
        break;
      }
      
      console.log('\nRegistered services:\n');
      for (const svc of services) {
        console.log(`  ${svc.name}`);
        console.log(`    Nodes: ${svc.nodeCount} | Versions: ${svc.versions.join(', ')} | Latest: ${svc.latest}`);
        if (svc.baseUrl) console.log(`    Base URL: ${svc.baseUrl}`);
        if (svc.discoveredFrom) console.log(`    Source: ${svc.discoveredFrom}`);
        console.log();
      }
      break;
    }
    
    case 'info': {
      const service = args[1];
      if (!service) { log('Missing service name'); process.exit(1); }
      
      const info = getServiceInfo(service);
      if (!info) { log(`Service '${service}' not found`); process.exit(1); }
      
      console.log(`\nService: ${info.service}\n`);
      for (const v of info.versions) {
        console.log(`  ${v.version}:`);
        console.log(`    Nodes: ${v.nodeCount}`);
        console.log(`    Methods: ${Object.entries(v.methods).map(([m, c]) => `${m}:${c}`).join(' ')}`);
        if (v.discoveredFrom) console.log(`    Source: ${v.discoveredFrom}`);
        if (v.storedAt) console.log(`    Stored: ${v.storedAt}`);
        console.log();
      }
      break;
    }
    
    case 'load': {
      const service = args[1];
      if (!service) { log('Missing service name'); process.exit(1); }
      const versionIdx = args.indexOf('--version');
      const version = versionIdx >= 0 ? args[versionIdx + 1] : undefined;
      
      const data = loadNodes(service, version);
      if (!data) { log(`Service '${service}' not found`); process.exit(1); }
      
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    
    case 'remove': {
      const service = args[1];
      if (!service) { log('Missing service name'); process.exit(1); }
      const versionIdx = args.indexOf('--version');
      const version = versionIdx >= 0 ? args[versionIdx + 1] : undefined;
      
      if (removeService(service, version)) {
        log(`✅ Removed ${service}${version ? ` ${version}` : ''}`);
      }
      break;
    }
    
    case 'export': {
      const service = args[1];
      if (!service) { log('Missing service name'); process.exit(1); }
      const adapterIdx = args.indexOf('--adapter');
      const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : 'universal';
      const outputIdx = args.indexOf('--output');
      const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : './exported';
      const versionIdx = args.indexOf('--version');
      const version = versionIdx >= 0 ? args[versionIdx + 1] : undefined;
      
      // Load from registry, write discovery.json to temp, call generate.mjs
      const data = loadNodes(service, version);
      if (!data) { log(`Service '${service}' not found`); process.exit(1); }
      
      // Write temp discovery file for generate.mjs
      const tmpFile = join(REGISTRY_DIR, '.tmp-export.json');
      const discoveryFormat = {
        url: data.baseUrl || '',
        sourceType: 'registry',
        tools: data.nodes.map(n => ({
          name: n.id.replace(`${sanitizeId(service)}__`, ''),
          method: n.execution.method,
          path: n.execution.pathTemplate,
          description: n.description,
          params: n.inputs,
          auth: n.auth,
          sourceUrl: n.source?.url || '',
          sourceType: n.source?.type || 'registry',
        })),
      };
      writeFileSync(tmpFile, JSON.stringify(discoveryFormat));
      
      try {
        const scriptDir = dirname(fileURLToPath(import.meta.url));
        execSync(
          `node "${join(scriptDir, 'generate.mjs')}" "${tmpFile}" --adapter ${adapter} --service ${service} --base-url "${data.baseUrl || ''}" --output "${outputDir}"`,
          { stdio: 'inherit' }
        );
      } finally {
        if (existsSync(tmpFile)) rmSync(tmpFile);
      }
      break;
    }
    
    default:
      log(`Unknown command: ${command}. Use --help for usage.`);
      process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
