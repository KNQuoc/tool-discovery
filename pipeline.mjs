#!/usr/bin/env node
/**
 * pipeline.mjs — End-to-end: describe what you need → get working nodes
 * 
 * "I need to send emails via Resend"
 *   → LLM finds docs URL
 *   → discovers all endpoints
 *   → generates typed workflow nodes
 *   → saves to registry
 * 
 * Usage:
 *   node pipeline.mjs "send emails with Resend"
 *   node pipeline.mjs "manage DoorDash deliveries" --adapter openai
 *   node pipeline.mjs --url https://resend.com/docs/api-reference
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency)
try {
  const envFile = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function log(msg) { process.stderr.write(`[pipeline] ${msg}\n`); }

// ═══════════════════════════════════════════════════════════════
// Step 1: Figure out what API docs to look at
// ═══════════════════════════════════════════════════════════════

async function resolveDocsUrl(description) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY required for natural language resolution. Use --url to provide docs URL directly.');
  }

  log('Asking LLM to find the right API docs...');
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You help find API documentation URLs. Given a description of what someone wants to do, return a JSON object with:
- "service": the service name (lowercase, e.g. "resend", "stripe", "doordash")
- "docsUrl": the best URL to start discovering API endpoints (preferably the API reference page, not the homepage)
- "baseUrl": the API base URL for making requests (e.g. "https://api.resend.com")
- "authType": "bearer" or "api-key" or "oauth" or "none"
- "confidence": 0-1 how confident you are

Return ONLY valid JSON, no explanation.`,
        },
        {
          role: 'user',
          content: description,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content.trim();
  
  // Parse JSON (handle markdown code blocks)
  const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  const result = JSON.parse(jsonStr);
  
  log(`  Service: ${result.service}`);
  log(`  Docs: ${result.docsUrl}`);
  log(`  Base URL: ${result.baseUrl}`);
  log(`  Auth: ${result.authType}`);
  log(`  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Step 2: Discover endpoints
// ═══════════════════════════════════════════════════════════════

function discoverEndpoints(docsUrl, options = {}) {
  log(`\nDiscovering endpoints from ${docsUrl}...`);
  
  const tmpOutput = join(__dirname, '.tmp-pipeline-discovery.json');
  const args = [docsUrl, '--crawl', '--output', tmpOutput];
  
  if (options.maxPages) args.push('--max-pages', String(options.maxPages));
  if (options.firecrawl) args.push('--firecrawl');
  
  try {
    execSync(
      `node "${join(__dirname, 'discover.mjs')}" ${args.map(a => `"${a}"`).join(' ')}`,
      { stdio: 'inherit', timeout: 900000 } // 15 min max
    );
  } catch (error) {
    // discover.mjs exits with code 1 even on success (stderr logging triggers PowerShell error)
    // Check if output was produced regardless
    log(`Discovery process exited (may still have results)...`);
  }
  
  if (!existsSync(tmpOutput)) {
    throw new Error('Discovery produced no output file');
  }
  
  const discovery = JSON.parse(readFileSync(tmpOutput, 'utf-8'));
  return { discovery, tmpFile: tmpOutput };
}

// ═══════════════════════════════════════════════════════════════
// Step 3: Generate nodes
// ═══════════════════════════════════════════════════════════════

function generateNodes(discoveryFile, options = {}) {
  const { service, adapter = 'jam-nodes', baseUrl, outputDir } = options;
  
  const outDir = outputDir || join(__dirname, 'generated', service || 'output');
  log(`\nGenerating ${adapter} nodes...`);
  
  const args = [
    `"${discoveryFile}"`,
    '--adapter', adapter,
    '--output', `"${outDir}"`,
  ];
  if (service) args.push('--service', service);
  if (baseUrl) args.push('--base-url', `"${baseUrl}"`);
  
  try {
    execSync(
      `node "${join(__dirname, 'generate.mjs')}" ${args.join(' ')}`,
      { stdio: 'inherit' }
    );
  } catch {}
  
  return outDir;
}

// ═══════════════════════════════════════════════════════════════
// Step 4: Store in registry
// ═══════════════════════════════════════════════════════════════

function storeInRegistry(discoveryFile, options = {}) {
  const { service, baseUrl } = options;
  log(`\nStoring in registry...`);
  
  const args = ['store', `"${discoveryFile}"`];
  if (service) args.push('--service', service);
  if (baseUrl) args.push('--base-url', `"${baseUrl}"`);
  
  try {
    execSync(
      `node "${join(__dirname, 'registry.mjs')}" ${args.join(' ')}`,
      { stdio: 'inherit' }
    );
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Main pipeline
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node pipeline.mjs <description> [options]
       node pipeline.mjs --url <docs-url> [options]

Options:
  --url <url>          Skip LLM, provide docs URL directly
  --base-url <url>     API base URL (auto-detected if omitted)
  --service <name>     Service name (auto-detected if omitted)
  --adapter <type>     Output: jam-nodes, openai, langchain, n8n (default: jam-nodes)
  --output <dir>       Output directory (default: ./generated/<service>)
  --max-pages <n>      Max pages to crawl (default: 100)
  --firecrawl          Use Firecrawl for faster crawling
  --no-registry        Don't store in registry

Examples:
  node pipeline.mjs "send emails with Resend"
  node pipeline.mjs "manage Stripe subscriptions" --adapter openai
  node pipeline.mjs --url https://developer.wordpress.org/rest-api/ --firecrawl
  node pipeline.mjs "DoorDash deliveries" --firecrawl --adapter jam-nodes
`);
    process.exit(0);
  }
  
  const urlIdx = args.indexOf('--url');
  const baseUrlIdx = args.indexOf('--base-url');
  const serviceIdx = args.indexOf('--service');
  const adapterIdx = args.indexOf('--adapter');
  const outputIdx = args.indexOf('--output');
  const maxPagesIdx = args.indexOf('--max-pages');
  const useFirecrawl = args.includes('--firecrawl');
  const noRegistry = args.includes('--no-registry');
  
  const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : 'jam-nodes';
  const maxPages = maxPagesIdx >= 0 ? parseInt(args[maxPagesIdx + 1]) : 100;
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  
  let docsUrl, baseUrl, service;
  
  const startTime = Date.now();
  log('═══════════════════════════════════════════════');
  log('  tool-discovery pipeline');
  log('═══════════════════════════════════════════════\n');
  
  // Step 1: Resolve docs URL
  if (urlIdx >= 0) {
    docsUrl = args[urlIdx + 1];
    baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : '';
    service = serviceIdx >= 0 ? args[serviceIdx + 1] : undefined;
    log(`Using provided URL: ${docsUrl}`);
  } else {
    // Natural language description — first non-flag arg
    const description = args.filter(a => !a.startsWith('--')).join(' ');
    if (!description) {
      log('Provide a description or --url');
      process.exit(1);
    }
    
    const resolved = await resolveDocsUrl(description);
    docsUrl = resolved.docsUrl;
    baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : resolved.baseUrl;
    service = serviceIdx >= 0 ? args[serviceIdx + 1] : resolved.service;
    
    if (resolved.confidence < 0.5) {
      log(`\n⚠️  Low confidence (${(resolved.confidence * 100).toFixed(0)}%). You may want to provide --url directly.`);
    }
  }
  
  // Step 2: Discover
  const { discovery, tmpFile } = discoverEndpoints(docsUrl, {
    maxPages,
    firecrawl: useFirecrawl,
  });
  
  const toolCount = discovery.tools?.length || 0;
  if (toolCount === 0) {
    log('\n❌ No endpoints discovered. Try a different URL or use --firecrawl.');
    process.exit(1);
  }
  
  log(`\n✅ Discovered ${toolCount} endpoints`);
  
  // Derive service name if not set
  if (!service) {
    try {
      const host = new URL(docsUrl).hostname;
      service = host.replace(/^(api|developer|docs)\./, '').split('.')[0];
    } catch {
      service = 'unknown';
    }
  }
  
  // Step 3: Generate
  const outDir = generateNodes(tmpFile, {
    service,
    adapter,
    baseUrl,
    outputDir,
  });
  
  // Step 4: Registry
  if (!noRegistry) {
    storeInRegistry(tmpFile, { service, baseUrl });
  }
  
  // Cleanup
  try {
    const { unlinkSync } = await import('fs');
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch {}
  
  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  log('\n═══════════════════════════════════════════════');
  log('  Pipeline complete!');
  log('═══════════════════════════════════════════════\n');
  log(`  Service:    ${service}`);
  log(`  Endpoints:  ${toolCount}`);
  log(`  Adapter:    ${adapter}`);
  log(`  Output:     ${outDir}/`);
  if (!noRegistry) log(`  Registry:   ~/.tool-discovery/nodes/${service}/`);
  log(`  Time:       ${elapsed}s`);
  log('');
  
  // Show sample usage
  if (adapter === 'jam-nodes') {
    log('Usage:');
    log(`  import { ${camelCase(service)}Nodes } from '${outDir}/index';`);
    log(`  import { registerCredentials } from '${outDir}/runtime';`);
    log('');
    log(`  registerCredentials('${service}', {`);
    log(`    baseUrl: '${baseUrl || 'https://api.example.com'}',`);
    log(`    token: process.env.${service.toUpperCase()}_API_KEY,`);
    log('  });');
  } else if (adapter === 'openai') {
    log('Usage:');
    log(`  const tools = require('${outDir}/${service}-functions.json');`);
    log("  // Pass to OpenAI: { tools, model: 'gpt-4' }");
  }
}

function camelCase(s) {
  return s.replace(/[_-](\w)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
}

main().catch(err => {
  log(`\n❌ Pipeline failed: ${err.message}`);
  process.exit(1);
});
