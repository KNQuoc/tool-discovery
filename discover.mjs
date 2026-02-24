#!/usr/bin/env node
/**
 * Tool Discovery - Extract API tools/endpoints from any docs URL
 * 
 * Usage: node discover.mjs <url> [--output <file>] [--crawl] [--max-pages <n>]
 * 
 * Supports:
 *  - OpenAPI/Swagger specs (JSON/YAML)
 *  - MCP endpoints (tools/list)
 *  - HTML API docs pages (AI extraction)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from script directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ─── Types ───────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   name: string,
 *   method?: string,
 *   path?: string,
 *   description: string,
 *   params: Array<{
 *     name: string,
 *     type: string,
 *     required: boolean,
 *     description: string,
 *     enum?: string[],
 *     default?: any
 *   }>,
 *   responseSchema?: object,
 *   auth?: { type: string, header?: string, in?: string },
 *   sourceUrl: string,
 *   sourceType: 'openapi' | 'mcp' | 'html-ai' | 'html-parsed'
 * }} DiscoveredTool
 */

/**
 * @typedef {{
 *   url: string,
 *   sourceType: string,
 *   discoveredAt: string,
 *   toolCount: number,
 *   tools: DiscoveredTool[]
 * }} DiscoveryResult
 */

// ─── Config ──────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:7842';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const USER_AGENT = 'ToolDiscovery/0.1';
const MAX_CRAWL_PAGES = 20;
const FIRECRAWL_BASE = 'https://api.firecrawl.dev';
const FIRECRAWL_CONCURRENCY = 5; // parallel GPT extractions
const FETCH_TIMEOUT = 15000;

// ─── Utilities ───────────────────────────────────────────────────────

async function fetchUrl(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchText(url) {
  const res = await fetchUrl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function log(msg) {
  console.error(`[discover] ${msg}`);
}

/**
 * Detect if HTML is a SPA shell (mostly empty, JS-rendered)
 */
function isSpaShell(html) {
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Pure SPA shell: barely any text
  if (textContent.length < 500 && html.length > 2000) return true;
  
  // Ratio check: if text is < 1% of HTML, likely SPA with inline JS bundles
  if (html.length > 50000 && textContent.length / html.length < 0.01) return true;
  
  // Check for common SPA root markers with little content
  if (html.includes('__NEXT_DATA__') || html.includes('__nuxt') || html.includes('id="__docusaurus"')) {
    // It's SSR but may still have content — don't flag as SPA
    return false;
  }
  
  return false;
}

/**
 * Fetch rendered page content via a web fetcher that handles JS rendering
 * Falls back to raw HTML if no renderer available
 */
async function fetchRenderedContent(url) {
  // First try raw fetch
  const rawHtml = await fetchText(url);
  
  // If it's not a SPA shell, raw HTML is fine
  if (!isSpaShell(rawHtml)) {
    return { html: rawHtml, rendered: false };
  }
  
  log(`  SPA detected, trying rendered fetch...`);
  
  // Try using a fetch-with-rendering service
  // Option 1: Google web cache / archive.org as fallback
  // Option 2: Jina Reader API (free, renders JS)
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetchUrl(jinaUrl, {
      headers: { 
        'Accept': 'text/html',
        'X-Return-Format': 'html',
      }
    });
    if (res.ok) {
      const rendered = await res.text();
      if (rendered.length > 500) {
        log(`  Got rendered content via Jina (${rendered.length} chars)`);
        return { html: rendered, rendered: true, markdown: true };
      }
    }
  } catch { /* Jina not available */ }
  
  // Fallback: return raw HTML anyway
  log(`  No renderer available, using raw SPA HTML`);
  return { html: rawHtml, rendered: false };
}

// ─── OpenAPI / Swagger Parser ────────────────────────────────────────

function parseOpenApiParam(param) {
  const schema = param.schema || {};
  return {
    name: param.name,
    type: schema.type || param.type || 'string',
    required: param.required || false,
    description: param.description || schema.description || '',
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
  };
}

function resolveRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return {};
  const parts = ref.replace('#/', '').split('/');
  let obj = spec;
  for (const part of parts) {
    obj = obj?.[part];
    if (!obj) return {};
  }
  return obj;
}

function flattenSchemaProperties(spec, schema, prefix = '') {
  const params = [];
  if (!schema) return params;
  
  // Resolve $ref
  if (schema.$ref) {
    schema = resolveRef(spec, schema.$ref);
  }
  
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  
  for (const [name, prop] of Object.entries(properties)) {
    let resolved = prop;
    if (prop.$ref) resolved = resolveRef(spec, prop.$ref);
    
    const fullName = prefix ? `${prefix}.${name}` : name;
    
    if (resolved.type === 'object' && resolved.properties) {
      // Recurse into nested objects
      params.push(...flattenSchemaProperties(spec, resolved, fullName));
    } else {
      params.push({
        name: fullName,
        type: resolved.type || 'string',
        required: required.has(name),
        description: resolved.description || '',
        ...(resolved.enum ? { enum: resolved.enum } : {}),
        ...(resolved.default !== undefined ? { default: resolved.default } : {}),
      });
    }
  }
  
  return params;
}

function extractOpenApiTools(spec) {
  const tools = [];
  const paths = spec.paths || {};
  const baseUrl = spec.servers?.[0]?.url || '';
  
  // Extract auth info
  const securitySchemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
  let authInfo = undefined;
  for (const [, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      authInfo = { type: 'bearer', header: 'Authorization' };
      break;
    }
    if (scheme.type === 'apiKey') {
      authInfo = { type: 'apikey', header: scheme.name, in: scheme.in };
      break;
    }
    if (scheme.type === 'oauth2') {
      authInfo = { type: 'oauth2' };
      break;
    }
  }
  
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].indexOf(method) === -1) continue;
      
      const params = [];
      
      // Path/query/header params
      for (const param of (operation.parameters || [])) {
        let resolved = param;
        if (param.$ref) resolved = resolveRef(spec, param.$ref);
        params.push(parseOpenApiParam(resolved));
      }
      
      // Request body params (OpenAPI 3.x)
      if (operation.requestBody) {
        let reqBody = operation.requestBody;
        if (reqBody.$ref) reqBody = resolveRef(spec, reqBody.$ref);
        
        const content = reqBody.content || {};
        const jsonContent = content['application/json'] || content['*/*'] || Object.values(content)[0];
        if (jsonContent?.schema) {
          params.push(...flattenSchemaProperties(spec, jsonContent.schema));
        }
      }
      
      // Body params (Swagger 2.x)
      const bodyParam = (operation.parameters || []).find(p => p.in === 'body');
      if (bodyParam?.schema) {
        params.push(...flattenSchemaProperties(spec, bodyParam.schema));
      }
      
      // Response schema
      let responseSchema = undefined;
      const successResponse = operation.responses?.['200'] || operation.responses?.['201'] || operation.responses?.['2XX'];
      if (successResponse) {
        let resp = successResponse;
        if (resp.$ref) resp = resolveRef(spec, resp.$ref);
        const respContent = resp.content?.['application/json'];
        if (respContent?.schema) {
          responseSchema = respContent.schema;
          // Resolve top-level ref
          if (responseSchema.$ref) {
            responseSchema = resolveRef(spec, responseSchema.$ref);
          }
        } else if (resp.schema) {
          responseSchema = resp.schema;
        }
      }
      
      // Generate name from operationId or path+method
      const name = operation.operationId || 
        `${method}_${path.replace(/[{}\/]/g, '_').replace(/^_|_$/g, '').replace(/__+/g, '_')}`;
      
      tools.push({
        name,
        method: method.toUpperCase(),
        path: path,
        description: operation.summary || operation.description || '',
        params,
        ...(responseSchema ? { responseSchema } : {}),
        ...(authInfo ? { auth: authInfo } : {}),
        sourceUrl: baseUrl + path,
        sourceType: 'openapi',
      });
    }
  }
  
  return tools;
}

// ─── MCP Parser ──────────────────────────────────────────────────────

function extractMcpTools(toolsList, sourceUrl) {
  return (toolsList.tools || toolsList).map(tool => {
    const params = [];
    const schema = tool.inputSchema || {};
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    
    for (const [name, prop] of Object.entries(properties)) {
      params.push({
        name,
        type: prop.type || 'string',
        required: required.has(name),
        description: prop.description || '',
        ...(prop.enum ? { enum: prop.enum } : {}),
        ...(prop.default !== undefined ? { default: prop.default } : {}),
      });
    }
    
    return {
      name: tool.name,
      description: tool.description || '',
      params,
      sourceUrl,
      sourceType: 'mcp',
    };
  });
}

// ─── HTML Docs AI Extraction ─────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an API documentation parser. Given HTML content from an API docs page, extract ALL API endpoints/tools you can find.

For each endpoint, extract:
- name: A snake_case function name (e.g., "send_email", "list_users")
- method: HTTP method (GET, POST, PUT, DELETE, PATCH) if applicable
- path: The URL path (e.g., "/v1/emails", "/api/users/{id}")
- description: What this endpoint does (1-2 sentences)
- params: Array of parameters, each with:
  - name: parameter name
  - type: data type (string, number, integer, boolean, array, object)
  - required: true/false
  - description: what this param does
  - enum: possible values if it's an enum (optional)
  - default: default value if mentioned (optional)
- auth: Authentication info if mentioned ({ type: "bearer"|"apikey"|"oauth2", header: "Authorization" })

Return a JSON array of endpoints. If you find no endpoints, return an empty array [].
Be thorough — extract EVERY endpoint you can find on the page, including nested ones.
Only return valid JSON, no markdown.`;

async function extractToolsFromHtmlAI(html, url) {
  if (!OPENAI_API_KEY) {
    log('WARNING: No OPENAI_API_KEY set — cannot do AI extraction from HTML docs');
    return [];
  }
  
  // Use smart content extraction
  const textContent = extractMainContent(html).slice(0, 60000); // Token limit safety
  
  if (textContent.length < 100) {
    log('Page content too short for extraction');
    return [];
  }
  
  // Quick check: does this even look like API docs?
  if (!looksLikeApiDocs(textContent)) {
    log('Page does not appear to contain API endpoint documentation');
    return [];
  }
  
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  
  // Hard 45s timeout via Promise.race
  const response = await Promise.race([
    openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: `URL: ${url}\n\nPage content:\n${textContent}` },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out.')), 45000)),
  ]);
  
  const content = response.choices[0]?.message?.content;
  if (!content) return [];
  
  try {
    const parsed = JSON.parse(content);
    const tools = Array.isArray(parsed) ? parsed : (parsed.endpoints || parsed.tools || []);
    return tools.map(t => ({
      ...t,
      params: t.params || [],
      sourceUrl: url,
      sourceType: 'html-ai',
    }));
  } catch {
    log('Failed to parse AI extraction result');
    return [];
  }
}

// ─── Docs Framework Detection ────────────────────────────────────────

/**
 * Detect which docs framework a page is built with
 */
function detectDocsFramework(html) {
  const lower = html.toLowerCase();
  
  if (lower.includes('mintlify') || lower.includes('_next/static') && lower.includes('mintlify')) 
    return 'mintlify';
  if (lower.includes('readme-io') || lower.includes('readme.com') || lower.includes('readme-ow'))
    return 'readme';
  if (lower.includes('gitbook') || lower.includes('gitbook.io'))
    return 'gitbook';
  if (lower.includes('docusaurus') || lower.includes('docusaurus_'))
    return 'docusaurus';
  if (lower.includes('redoc') || lower.includes('redocly'))
    return 'redoc';
  if (lower.includes('swagger-ui') || lower.includes('swagger_ui'))
    return 'swagger-ui';
  if (lower.includes('stoplight') || lower.includes('stoplight.io'))
    return 'stoplight';
  if (lower.includes('scalar') || lower.includes('cdn.scalar'))
    return 'scalar';
  
  return 'unknown';
}

// ─── Sitemap Parser ──────────────────────────────────────────────────

async function fetchSitemapUrls(baseOrigin) {
  const sitemapPaths = ['/sitemap.xml', '/sitemap-0.xml', '/docs/sitemap.xml', '/api/sitemap.xml'];
  
  for (const path of sitemapPaths) {
    try {
      const text = await fetchText(baseOrigin + path);
      if (!text.includes('<urlset') && !text.includes('<sitemapindex')) continue;
      
      const urls = [];
      const locRegex = /<loc>([^<]+)<\/loc>/gi;
      let match;
      while ((match = locRegex.exec(text)) !== null) {
        urls.push(match[1].trim());
      }
      
      if (urls.length > 0) {
        log(`Found sitemap at ${path} with ${urls.length} URLs`);
        return urls;
      }
    } catch { /* not found */ }
  }
  
  return [];
}

// ─── Smart Link Extraction ───────────────────────────────────────────

/**
 * Extract doc page links with priority scoring
 */
function extractDocLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const links = new Map(); // url -> score
  
  // ─── 1. Sidebar / Nav links (highest priority) ───
  // Extract links from nav, sidebar, toc elements
  const navPatterns = [
    /<nav[^>]*>([\s\S]*?)<\/nav>/gi,
    /<aside[^>]*>([\s\S]*?)<\/aside>/gi,
    /<div[^>]*(?:sidebar|side-nav|toc|table-of-contents|nav-menu|doc-menu|api-nav)[^>]*>([\s\S]*?)<\/div>/gi,
    /<ul[^>]*(?:sidebar|nav|menu|toc)[^>]*>([\s\S]*?)<\/ul>/gi,
  ];
  
  for (const pattern of navPatterns) {
    let navMatch;
    while ((navMatch = pattern.exec(html)) !== null) {
      const navHtml = navMatch[1] || navMatch[0];
      const hrefRegex = /href=["']([^"'#][^"']*)["']/gi;
      let hrefMatch;
      while ((hrefMatch = hrefRegex.exec(navHtml)) !== null) {
        try {
          const resolved = new URL(hrefMatch[1], baseUrl).href.split('#')[0];
          if (new URL(resolved).origin === origin) {
            links.set(resolved, (links.get(resolved) || 0) + 10); // High priority
          }
        } catch { /* invalid URL */ }
      }
    }
  }
  
  // ─── 2. All links with API-related paths ───
  const allHrefRegex = /href=["']([^"'#][^"']*)["']/gi;
  let match;
  while ((match = allHrefRegex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href.split('#')[0];
      if (new URL(resolved).origin !== origin) continue;
      
      const path = new URL(resolved).pathname.toLowerCase();
      
      // Skip obvious non-doc pages
      if (path.match(/\.(css|js|png|jpg|svg|ico|woff|ttf|eot)$/)) continue;
      if (path.match(/\/(blog|pricing|about|contact|login|signup|changelog|status)\b/)) continue;
      
      // Score based on path relevance
      let score = 0;
      if (path.match(/\/api[-/]ref/)) score += 8;
      if (path.match(/\/reference\//)) score += 8;
      if (path.match(/\/api\//)) score += 6;
      if (path.match(/\/endpoint/)) score += 6;
      if (path.match(/\/docs\//)) score += 4;
      if (path.match(/\/method/)) score += 4;
      if (path.match(/\/resource/)) score += 4;
      if (path.match(/\/rest\//)) score += 5;
      if (path.match(/\/graphql/)) score += 3;
      if (path.match(/\/(get|post|put|delete|patch|list|create|update|send|fetch)\b/)) score += 3;
      
      // Boost if path is a subpath of the starting URL
      const startPath = new URL(baseUrl).pathname;
      if (path.startsWith(startPath) && path !== startPath) score += 5;
      
      if (score > 0) {
        links.set(resolved, (links.get(resolved) || 0) + score);
      }
    } catch { /* invalid URL */ }
  }
  
  // Sort by score (highest first), return URLs
  return [...links.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

// ─── Content Extractor (framework-aware) ─────────────────────────────

/**
 * Extract the main content area from HTML, stripping navigation/chrome
 */
function extractMainContent(html) {
  // Remove script, style, nav, header, footer — the chrome
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')  // SVG icons
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  
  // Note: we intentionally DON'T strip <nav>, <header>, <aside> etc. here
  // because Mintlify/React docs often nest content inside these or use
  // lazy regex matching that captures wrong fragments with nested divs.
  // Instead, we strip tags and rely on looksLikeApiDocs to judge content quality.
  
  // Strip all HTML tags, decode entities, normalize whitespace
  return cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if page content looks like it has API endpoint documentation
 */
function looksLikeApiDocs(text) {
  const signals = [
    [/\b(GET|POST|PUT|PATCH|DELETE)\s+\//i, 2],
    [/\b(GET|POST|PUT|PATCH|DEL)\s+\w/i, 1],
    [/\bcurl\s/i, 2],
    [/\bauthorization:\s*bearer/i, 1],
    [/\brequest\s+body/i, 2],
    [/\bresponse\s*(body|code|status|example)/i, 1],
    [/\bparameters?\b/i, 1],
    [/\bbody\s*parameters?\b/i, 2],
    [/\bquery\s*parameters?\b/i, 2],
    [/\bpath\s*parameters?\b/i, 2],
    [/\bendpoint\b/i, 1],
    [/\bapi[_-]?key\b/i, 1],
    [/\bheaders?\b.*content-type/i, 1],
    [/\b(required|optional)\b/i, 1],
    [/\b(string|integer|boolean|array|object)\b.*\b(required|optional)\b/i, 2],
    [/\bapplication\/json\b/i, 1],
    [/\b[245]\d{2}\b/i, 1], // HTTP status codes
    [/\bsend\s+email\b/i, 1],
    [/\b(api|sdk)\s+reference\b/i, 2],
    [/\breturn[s]?\s+(a|an|the)\s+\w+\s+object/i, 1],
    [/["']\w+["']\s*:\s*["']/i, 1], // JSON-like key-value
    [/\bbase\s*url\b/i, 1],
  ];
  
  let score = 0;
  for (const [pattern, weight] of signals) {
    if (pattern.test(text)) score += weight;
  }
  return score >= 3;
}

// ─── Docs Crawler ────────────────────────────────────────────────────

const CRAWL_DELAY_MS = 500; // Polite delay between requests

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Firecrawl-Powered Crawl ─────────────────────────────────────────

/**
 * Crawl a docs site using Firecrawl API, then extract endpoints with GPT.
 * Much faster than manual crawling — handles SPAs, JS rendering, rate limits.
 */
async function firecrawlCrawlAndExtract(startUrl, maxPages = 100) {
  if (!FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY not set — add it to .env');
  }
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — needed for endpoint extraction');
  }
  
  // Step 1: Discover URLs via multiple methods
  log('Discovering site URLs...');
  let docUrls = [];
  
  // Method A: Firecrawl map
  try {
    const mapRes = await fetch(`${FIRECRAWL_BASE}/v2/map`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: startUrl }),
    });
    
    if (mapRes.ok) {
      const mapData = await mapRes.json();
      const mapLinks = (mapData.links || []).map(l => typeof l === 'string' ? l : l.url).filter(Boolean);
      log(`  Firecrawl map: ${mapLinks.length} URLs`);
      docUrls.push(...mapLinks);
    }
  } catch { /* map failed */ }
  
  // Method B: Sitemap.xml (our own fetcher — more reliable for some sites)
  try {
    const origin = new URL(startUrl).origin;
    const sitemapText = await fetchText(`${origin}/sitemap.xml`);
    const sitemapUrls = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    if (sitemapUrls.length > 0) {
      log(`  Sitemap: ${sitemapUrls.length} URLs`);
      docUrls.push(...sitemapUrls);
    }
  } catch { /* no sitemap */ }
  
  // Method C: Starting page links (our own fetcher)
  try {
    const html = await fetchText(startUrl);
    const origin = new URL(startUrl).origin;
    const linkMatches = [...html.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]);
    const absLinks = linkMatches
      .map(l => { try { return new URL(l, startUrl).href; } catch { return null; } })
      .filter(l => l && l.startsWith(origin) && !l.includes('#'));
    if (absLinks.length > 0) {
      log(`  Page links: ${absLinks.length} URLs`);
      docUrls.push(...absLinks);
    }
  } catch { /* fetch failed */ }
  
  // Normalize URLs: strip trailing slashes, fragments, and sort params for consistent dedup
  function normalizeUrl(u) {
    try {
      const parsed = new URL(u);
      parsed.hash = '';
      // Remove trailing slash unless it's just the origin
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      return parsed.href;
    } catch { return u; }
  }
  
  // Deduplicate and filter to doc/API pages
  docUrls = [...new Set(docUrls.map(normalizeUrl))]
    .filter(u => /\/(docs|reference|api|endpoint|tutorial|how.to)/i.test(u))
    .filter(u => !u.match(/\.(css|js|png|jpg|svg|woff|ico|json|xml)(\?|$)/))
    .slice(0, maxPages);
  
  log(`${docUrls.length} unique doc URLs after filtering (max ${maxPages})\n`);
  
  if (docUrls.length === 0) {
    log('No doc URLs discovered');
    return [];
  }
  
  // Step 2: Batch scrape all doc URLs
  log(`\nBatch scraping ${docUrls.length} pages...`);
  const batchRes = await fetch(`${FIRECRAWL_BASE}/v2/batch/scrape`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      urls: docUrls,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
  });
  
  if (!batchRes.ok) {
    const err = await batchRes.text();
    throw new Error(`Firecrawl batch scrape failed: ${batchRes.status} ${err}`);
  }
  
  const batchData = await batchRes.json();
  const batchId = batchData.id;
  log(`Batch job started: ${batchId}`);
  
  // Step 3: Poll for completion
  log('Waiting for batch scrape to complete...');
  let pages = [];
  let pollCount = 0;
  const maxPolls = 120; // 10 min max
  
  while (pollCount < maxPolls) {
    await new Promise(r => setTimeout(r, 5000));
    pollCount++;
    
    const statusRes = await fetch(`${FIRECRAWL_BASE}/v2/batch/scrape/${batchId}`, {
      headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}` },
    });
    
    if (!statusRes.ok) {
      log(`  Poll error: ${statusRes.status}`);
      continue;
    }
    
    const statusData = await statusRes.json();
    
    if (statusData.status === 'completed') {
      pages = statusData.data || [];
      log(`Batch scrape complete: ${pages.length} pages retrieved`);
      break;
    } else if (statusData.status === 'failed') {
      throw new Error(`Batch scrape failed: ${statusData.error || 'unknown'}`);
    } else {
      const progress = statusData.completed || 0;
      const total = statusData.total || '?';
      if (pollCount % 3 === 0) {
        log(`  Scraping... ${progress}/${total} pages`);
      }
    }
  }
  
  if (pages.length === 0) {
    log('No pages retrieved from batch scrape');
    return [];
  }
  
  // Step 3: Filter pages that look like API docs
  const apiPages = pages.filter(p => {
    const md = p.markdown || '';
    if (md.length < 100) return false;
    return looksLikeApiDocs(md);
  });
  
  log(`${apiPages.length}/${pages.length} pages look like API docs`);
  
  if (apiPages.length === 0) {
    log('No API documentation pages found');
    return [];
  }
  
  // Step 4: Extract endpoints in parallel
  log(`\nExtracting endpoints from ${apiPages.length} pages (${FIRECRAWL_CONCURRENCY} concurrent)...\n`);
  const allTools = [];
  let processed = 0;
  let pagesWithEndpoints = 0;
  
  // Process in batches of FIRECRAWL_CONCURRENCY
  for (let i = 0; i < apiPages.length; i += FIRECRAWL_CONCURRENCY) {
    const batch = apiPages.slice(i, i + FIRECRAWL_CONCURRENCY);
    
    const results = await Promise.allSettled(
      batch.map(async (page) => {
        const url = page.metadata?.sourceURL || page.url || 'unknown';
        const md = page.markdown || '';
        
        try {
          const tools = await extractToolsFromHtmlAI(`<pre>${md}</pre>`, url);
          processed++;
          if (tools.length > 0) {
            pagesWithEndpoints++;
            log(`  ✓ ${url} — ${tools.length} endpoints`);
          } else {
            log(`  ✗ ${url} — no endpoints`);
          }
          return tools;
        } catch (err) {
          processed++;
          log(`  ✗ ${url} — error: ${err.message}`);
          return [];
        }
      })
    );
    
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allTools.push(...r.value);
      }
    }
    
    log(`  Progress: ${processed}/${apiPages.length} pages, ${allTools.length} endpoints found`);
  }
  
  log(`\nFirecrawl extraction complete: ${pagesWithEndpoints}/${apiPages.length} pages had endpoints`);
  
  // Deduplicate
  const seen = new Set();
  const deduped = allTools.filter(t => {
    const key = `${t.name}|${t.method || ''}|${t.path || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  return deduped;
}

// ─── Manual Crawl (fallback) ─────────────────────────────────────────

async function crawlAndExtract(startUrl, maxPages = MAX_CRAWL_PAGES) {
  const origin = new URL(startUrl).origin;
  const visited = new Set();
  const allTools = [];
  let pagesWithEndpoints = 0;
  
  // ─── Phase 1: Discover all doc page URLs ───
  log('Phase 1: Discovering doc pages...');
  
  let candidateUrls = [];
  
  // 1a. Try sitemap first
  const sitemapUrls = await fetchSitemapUrls(origin);
  if (sitemapUrls.length > 0) {
    // Filter sitemap for API-related paths
    const startPath = new URL(startUrl).pathname.toLowerCase().replace(/\/[^/]*$/, '');
    const apiUrls = sitemapUrls.filter(u => {
      const path = new URL(u).pathname.toLowerCase();
      // Match paths under the starting URL's directory, or common API doc paths
      return path.startsWith(startPath) || 
        path.match(/\/(api[-/]ref|api-reference|reference|endpoint|rest\/|docs\/api)/);
    });
    log(`Sitemap: ${apiUrls.length} API-related URLs (from ${sitemapUrls.length} total)`);
    candidateUrls.push(...apiUrls);
  }
  
  // 1b. Fetch starting page and extract sidebar/nav links
  try {
    const startHtml = await fetchText(startUrl);
    const framework = detectDocsFramework(startHtml);
    log(`Docs framework: ${framework}`);
    
    // Extract links from raw HTML (even SPA shells have nav links)
    const docLinks = extractDocLinks(startHtml, startUrl);
    log(`Starting page links: ${docLinks.length} relevant URLs found`);
    candidateUrls.push(...docLinks);
    
    // Check if starting page has content (may need rendering)
    const isSpa = isSpaShell(startHtml);
    if (isSpa) {
      log('Starting page is a SPA shell — will use rendered fetch for content extraction');
    }
    
    // Always add starting page as first candidate
    candidateUrls.unshift(startUrl);
  } catch (err) {
    log(`Failed to fetch starting page: ${err.message}`);
  }
  
  // Deduplicate and limit candidates
  candidateUrls = [...new Set(candidateUrls)].slice(0, maxPages * 2);
  log(`Total candidate URLs: ${candidateUrls.length}`);
  
  // ─── Phase 2: Visit pages and extract endpoints ───
  log('\nPhase 2: Extracting endpoints...');
  
  for (const url of candidateUrls) {
    if (visited.has(url)) continue;
    if (visited.size >= maxPages) break;
    visited.add(url);
    
    try {
      await sleep(CRAWL_DELAY_MS);
      const { html, rendered, markdown } = await fetchRenderedContent(url);
      
      // For rendered/markdown content, use it directly; for raw HTML, extract main content
      const content = markdown ? html : extractMainContent(html);
      
      // Skip if page doesn't look like API docs
      if (!looksLikeApiDocs(content)) {
        log(`  Skip (no API content, ${content.length} chars): ${url}`);
        continue;
      }
      
      log(`  Extracting (${visited.size}/${maxPages}): ${url}`);
      
      // Pass the best content we have to AI
      const tools = await extractToolsFromHtmlAI(markdown ? `<pre>${html}</pre>` : html, url);
      if (tools.length > 0) {
        log(`  ✓ Found ${tools.length} endpoints`);
        allTools.push(...tools);
        pagesWithEndpoints++;
      } else {
        log(`  ✗ No endpoints extracted`);
      }
      
      // Discover more links from this page (only from raw HTML, not rendered markdown)
      if (!markdown && visited.size < maxPages) {
        const moreLinks = extractDocLinks(html, url);
        for (const link of moreLinks) {
          if (!visited.has(link) && !candidateUrls.includes(link)) {
            candidateUrls.push(link);
          }
        }
      }
    } catch (err) {
      log(`  Error on ${url}: ${err.message}`);
    }
  }
  
  log(`\nCrawl complete: visited ${visited.size} pages, ${pagesWithEndpoints} had endpoints`);
  
  // Deduplicate by name+method+path
  const seen = new Set();
  const deduped = allTools.filter(t => {
    const key = `${t.name}|${t.method || ''}|${t.path || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  return deduped;
}

// ─── Format Detection & Main Discovery ───────────────────────────────

async function tryOpenApiSpec(url) {
  // Try the URL directly as a spec
  try {
    const text = await fetchText(url);
    
    // Try JSON
    try {
      const json = JSON.parse(text);
      if (json.openapi || json.swagger || json.paths) {
        log('Detected: OpenAPI/Swagger JSON spec');
        return { type: 'openapi', spec: json };
      }
    } catch { /* not JSON */ }
    
    // Try YAML (basic detection)
    if (text.includes('openapi:') || text.includes('swagger:') || text.includes('paths:')) {
      log('Detected: Possible YAML spec (basic parsing — skipped, needs YAML dep)');
    }
    
    // Check if HTML page embeds or links to an OpenAPI spec
    if (text.includes('<html') || text.includes('<!DOCTYPE')) {
      // Look for spec URL in the page
      const specUrlPatterns = [
        /["'](https?:\/\/[^"']*openapi[^"']*\.(?:json|yaml|yml))["']/gi,
        /["'](https?:\/\/[^"']*swagger[^"']*\.(?:json|yaml|yml))["']/gi,
        /spec[_-]?[Uu]rl["':\s]*=?\s*["'](https?:\/\/[^"']+)["']/gi,
        /["'](\/[^"']*openapi[^"']*\.json)["']/gi,
        /["'](\/[^"']*swagger[^"']*\.json)["']/gi,
      ];
      
      for (const pattern of specUrlPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          try {
            const specUrl = new URL(match[1], url).href;
            log(`Found embedded spec URL: ${specUrl}`);
            const specJson = await fetchJson(specUrl);
            if (specJson.openapi || specJson.swagger || specJson.paths) {
              log('Successfully loaded embedded OpenAPI spec');
              return { type: 'openapi', spec: specJson, specUrl };
            }
          } catch { /* couldn't load */ }
        }
      }
      
      // Look for inline JSON spec in script tags
      const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let scriptMatch;
      while ((scriptMatch = scriptRegex.exec(text)) !== null) {
        const scriptContent = scriptMatch[1];
        // Look for OpenAPI-like JSON objects
        if (scriptContent.includes('"openapi"') || scriptContent.includes('"swagger"') || scriptContent.includes('"paths"')) {
          // Try to extract the JSON object
          const jsonRegex = /(\{[\s\S]*?"(?:openapi|swagger)"[\s\S]*?"paths"[\s\S]*?\})\s*[;,)]/;
          const jsonMatch = scriptContent.match(jsonRegex);
          if (jsonMatch) {
            try {
              const spec = JSON.parse(jsonMatch[1]);
              if (spec.paths && Object.keys(spec.paths).length > 0) {
                log('Found inline OpenAPI spec in script tag');
                return { type: 'openapi', spec };
              }
            } catch { /* not valid JSON */ }
          }
        }
      }
    }
  } catch { /* fetch failed */ }
  
  // Try well-known spec URLs
  const base = new URL(url).origin;
  const urlPath = new URL(url).pathname;
  
  // Build spec paths — include paths relative to the docs URL too
  const basePaths = [
    '/openapi.json', '/swagger.json', '/api-docs', '/v1/openapi.json',
    '/v2/openapi.json', '/v3/openapi.json', '/.well-known/openapi.json',
    '/api/openapi.json', '/docs/openapi.json', '/api/v1/openapi.json',
    '/api/swagger.json', '/swagger/v1/swagger.json',
  ];
  
  // Also try relative to the docs URL path
  const docDir = urlPath.replace(/\/[^/]*$/, '');
  const specPaths = [
    ...basePaths,
    ...(docDir ? [`${docDir}/openapi.json`, `${docDir}/swagger.json`, `${docDir}/spec.json`] : []),
  ];
  
  for (const specPath of specPaths) {
    try {
      const specUrl = base + specPath;
      log(`Trying: ${specUrl}`);
      const json = await fetchJson(specUrl);
      if (json.openapi || json.swagger || json.paths) {
        log(`Found OpenAPI spec at: ${specUrl}`);
        return { type: 'openapi', spec: json, specUrl };
      }
    } catch { /* not found */ }
  }
  
  return null;
}

async function tryMcpEndpoint(url) {
  try {
    // Try SSE-based MCP
    const res = await fetchUrl(url, {
      headers: { 'Accept': 'application/json' }
    });
    const json = await res.json();
    
    // Check if it looks like MCP tools list
    if (Array.isArray(json) && json[0]?.name && json[0]?.inputSchema) {
      log('Detected: MCP tools list (array)');
      return { type: 'mcp', tools: json };
    }
    if (json.tools && Array.isArray(json.tools)) {
      log('Detected: MCP tools list (object)');
      return { type: 'mcp', tools: json };
    }
  } catch { /* not MCP */ }
  
  return null;
}

async function discover(url, options = {}) {
  const { crawl = false, maxPages = MAX_CRAWL_PAGES, useFirecrawl = false } = options;
  
  log(`Starting discovery for: ${url}`);
  
  // 1. Try OpenAPI spec
  const openApiResult = await tryOpenApiSpec(url);
  if (openApiResult) {
    const tools = extractOpenApiTools(openApiResult.spec);
    log(`Extracted ${tools.length} endpoints from OpenAPI spec`);
    return {
      url: openApiResult.specUrl || url,
      sourceType: 'openapi',
      discoveredAt: new Date().toISOString(),
      toolCount: tools.length,
      tools,
    };
  }
  
  // 2. Try MCP
  const mcpResult = await tryMcpEndpoint(url);
  if (mcpResult) {
    const tools = extractMcpTools(mcpResult.tools, url);
    log(`Extracted ${tools.length} tools from MCP endpoint`);
    return {
      url,
      sourceType: 'mcp',
      discoveredAt: new Date().toISOString(),
      toolCount: tools.length,
      tools,
    };
  }
  
  // 3. Fall back to HTML docs scraping
  log('No spec found — falling back to HTML docs extraction');
  
  let tools;
  if (crawl && useFirecrawl && FIRECRAWL_API_KEY) {
    log(`Crawling with Firecrawl (max ${maxPages} pages)...`);
    tools = await firecrawlCrawlAndExtract(url, maxPages);
  } else if (crawl) {
    log(`Crawling docs site (max ${maxPages} pages)...`);
    tools = await crawlAndExtract(url, maxPages);
  } else {
    log('Extracting from single page (use --crawl for multi-page)');
    const { html, markdown } = await fetchRenderedContent(url);
    tools = await extractToolsFromHtmlAI(markdown ? `<pre>${html}</pre>` : html, url);
  }
  
  log(`Extracted ${tools.length} endpoints total`);
  
  return {
    url,
    sourceType: 'html-ai',
    discoveredAt: new Date().toISOString(),
    toolCount: tools.length,
    tools,
  };
}

// ─── Error-Driven Probe Discovery ────────────────────────────────────

/**
 * Discover API params by hitting endpoints and reading error responses.
 * No docs needed — just endpoint URLs.
 */
async function probeEndpoint(baseUrl, method, path, headers = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const discovered = { name: '', method, path, description: '', params: [], auth: null, sourceUrl: url, sourceType: 'probe' };
  
  // Generate a name from method + path
  discovered.name = `${method.toLowerCase()}_${path.replace(/^\//, '').replace(/[\/\{\}]/g, '_').replace(/_+/g, '_').replace(/_$/, '')}`;
  
  const knownParams = new Map(); // name -> { type, required, description }
  let maxRounds = 6;
  let body = {};
  
  for (let round = 0; round < maxRounds; round++) {
    try {
      const fetchOpts = {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
      };
      
      if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && Object.keys(body).length > 0) {
        fetchOpts.body = JSON.stringify(body);
      }
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      fetchOpts.signal = controller.signal;
      
      const res = await fetch(url, fetchOpts);
      clearTimeout(timeout);
      
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      
      if (res.ok) {
        // Success! We have enough params (or endpoint needs none)
        log(`    Round ${round + 1}: ✓ ${res.status} OK`);
        break;
      }
      
      // Auth errors
      if (res.status === 401 || res.status === 403) {
        discovered.auth = { type: 'required', detail: json?.message || json?.error || res.statusText };
        log(`    Round ${round + 1}: 🔒 ${res.status} — auth required`);
        break;
      }
      
      // Rate limit
      if (res.status === 429) {
        log(`    Round ${round + 1}: ⏳ Rate limited, stopping`);
        break;
      }
      
      // Parse error details
      const errorText = json
        ? JSON.stringify(json)
        : text.slice(0, 2000);
      
      log(`    Round ${round + 1}: ${res.status} — ${errorText.slice(0, 200)}`);
      
      // Extract param hints from error
      const newParams = extractParamsFromError(json || text, res.status);
      
      let foundNew = false;
      for (const p of newParams) {
        if (!knownParams.has(p.name)) {
          knownParams.set(p.name, p);
          foundNew = true;
          
          // Add a dummy value to body for next round
          body[p.name] = getDummyValue(p.type, p.name);
        }
      }
      
      if (!foundNew && round > 0) {
        log(`    No new params discovered, stopping`);
        break;
      }
      
    } catch (err) {
      log(`    Round ${round + 1}: Error — ${err.message}`);
      break;
    }
  }
  
  discovered.params = Array.from(knownParams.values());
  return discovered;
}

/**
 * Extract parameter info from error responses
 */
function extractParamsFromError(error, status) {
  const params = [];
  const text = typeof error === 'string' ? error : JSON.stringify(error);
  
  // Common patterns:
  // "missing required field: fieldName"
  // "field 'fieldName' is required"
  // "required: ['field1', 'field2']"
  // "Missing required parameter: fieldName"
  // "validation error: fieldName must be ..."
  // { "errors": { "fieldName": ["is required"] } }
  // { "error": { "param": "fieldName", "message": "..." } }
  
  // Pattern: "missing required field: X" / "Missing required parameter: X"
  const missingField = text.matchAll(/(?:missing|required)\s+(?:required\s+)?(?:field|parameter|param|property)[:\s]+['"]*(\w+)['""]*/gi);
  for (const m of missingField) {
    params.push({ name: m[1], type: 'string', required: true, description: `Required (from error)` });
  }
  
  // Pattern: "field 'X' is required" / "'X' is required"
  const fieldRequired = text.matchAll(/['"](\w+)['"]\s+is\s+required/gi);
  for (const m of fieldRequired) {
    params.push({ name: m[1], type: 'string', required: true, description: 'Required (from error)' });
  }
  
  // Pattern: required array in JSON - "required":["field1","field2"]
  const requiredArray = text.matchAll(/"required"\s*:\s*\[([^\]]+)\]/g);
  for (const m of requiredArray) {
    const fields = m[1].matchAll(/"(\w+)"/g);
    for (const f of fields) {
      params.push({ name: f[1], type: 'string', required: true, description: 'Required (from error)' });
    }
  }
  
  // Pattern: validation errors object - "errors":{"field":["message"]}
  if (typeof error === 'object' && error !== null) {
    const errObj = error.errors || error.error?.errors || error.detail;
    if (typeof errObj === 'object' && errObj !== null && !Array.isArray(errObj)) {
      for (const [key, val] of Object.entries(errObj)) {
        const msg = Array.isArray(val) ? val[0] : (typeof val === 'string' ? val : JSON.stringify(val));
        const required = /required|missing|blank|empty|null/i.test(msg);
        params.push({ name: key, type: guessTypeFromError(msg, key), required, description: msg });
      }
    }
    // Array of errors with param/field
    const errArray = error.errors || error.detail || error.details;
    if (Array.isArray(errArray)) {
      for (const e of errArray) {
        // Zod-style: { path: ["fieldName"], expected: "string", code: "invalid_type", message: "..." }
        if (e.path && Array.isArray(e.path) && e.path.length > 0) {
          const name = e.path[e.path.length - 1];
          if (name && typeof name === 'string') {
            const type = e.expected ? normalizeType(e.expected) : guessTypeFromError(e.message || '', name);
            params.push({ name, type, required: true, description: e.message || 'Required (from error)' });
          }
        }
        // Express/other: { param: "x", field: "x", loc: [...] }
        else if (e.param || e.field || e.loc) {
          const name = e.param || e.field || (Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : null);
          if (name && typeof name === 'string') {
            params.push({ name, type: guessTypeFromError(e.msg || e.message || '', name), required: true, description: e.msg || e.message || 'Required (from error)' });
          }
        }
      }
    }
  }
  
  // Pattern: "must be a(n) X" / "expected X" / "should be X" — type hints
  const typeHints = text.matchAll(/['"](\w+)['"]\s+(?:must be|should be|expected)\s+(?:a(?:n)?\s+)?(\w+)/gi);
  for (const m of typeHints) {
    const existing = params.find(p => p.name === m[1]);
    if (existing) {
      existing.type = normalizeType(m[2]);
    } else {
      params.push({ name: m[1], type: normalizeType(m[2]), required: false, description: `Must be ${m[2]} (from error)` });
    }
  }
  
  // Pattern: enum hints - "must be one of: X, Y, Z" / "valid values: X, Y, Z"
  const enumHints = text.matchAll(/['"](\w+)['"]\s+(?:must be one of|valid values|allowed values|expected one of)[:\s]+([^"}\]]+)/gi);
  for (const m of enumHints) {
    const values = m[2].split(/[,|]/).map(v => v.trim().replace(/['"]/g, '')).filter(Boolean);
    const existing = params.find(p => p.name === m[1]);
    if (existing) {
      existing.enum = values;
    } else {
      params.push({ name: m[1], type: 'string', required: false, description: `Enum (from error)`, enum: values });
    }
  }
  
  // Deduplicate by name
  const seen = new Set();
  return params.filter(p => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

function guessTypeFromError(msg, name) {
  if (/integer|int\b/i.test(msg)) return 'integer';
  if (/number|numeric|float|decimal/i.test(msg)) return 'number';
  if (/boolean|bool/i.test(msg)) return 'boolean';
  if (/array|list/i.test(msg)) return 'array';
  if (/object|map|hash/i.test(msg)) return 'object';
  // Guess from name
  if (/id$|_id$/i.test(name)) return 'string';
  if (/count|amount|quantity|limit|offset|page/i.test(name)) return 'integer';
  if (/enabled|active|is_/i.test(name)) return 'boolean';
  return 'string';
}

function normalizeType(t) {
  const lower = t.toLowerCase();
  if (['integer', 'int', 'long'].includes(lower)) return 'integer';
  if (['number', 'float', 'double', 'decimal'].includes(lower)) return 'number';
  if (['boolean', 'bool'].includes(lower)) return 'boolean';
  if (['array', 'list'].includes(lower)) return 'array';
  if (['object', 'map', 'hash', 'dict'].includes(lower)) return 'object';
  return 'string';
}

function getDummyValue(type, name) {
  switch (type) {
    case 'integer': return 1;
    case 'number': return 1.0;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': return {};
    default:
      // Smart defaults based on name
      if (/email/i.test(name)) return 'test@example.com';
      if (/url/i.test(name)) return 'https://example.com';
      if (/name/i.test(name)) return 'test';
      if (/id/i.test(name)) return '1';
      return 'test';
  }
}

/**
 * Probe a list of endpoints on a base URL
 */
async function probeApi(baseUrl, endpoints, headers = {}) {
  log(`Probing ${endpoints.length} endpoints on ${baseUrl}...`);
  
  const tools = [];
  for (const ep of endpoints) {
    const { method, path } = ep;
    // Skip path-param endpoints for now (need real IDs)
    if (path.includes('{') || path.includes(':')) {
      log(`  Probing ${method} ${path} (skipping — has path params)`);
      const tool = { name: ep.name || `${method.toLowerCase()}_${path.replace(/[\/\{\}:]/g, '_')}`, method, path, params: [], description: 'Skipped (path params)', sourceUrl: baseUrl + path, sourceType: 'probe-skipped' };
      tools.push(tool);
      continue;
    }
    
    log(`  Probing ${method} ${path}...`);
    const tool = await probeEndpoint(baseUrl, method, path, headers);
    tools.push(tool);
    
    // Small delay between endpoints
    await new Promise(r => setTimeout(r, 500));
  }
  
  return {
    url: baseUrl,
    sourceType: 'probe',
    discoveredAt: new Date().toISOString(),
    toolCount: tools.length,
    tools,
  };
}

/**
 * Auto-discover endpoints by trying common REST patterns
 */
async function probeDiscover(baseUrl, resourceNames, headers = {}) {
  const endpoints = [];
  
  for (const resource of resourceNames) {
    // Standard REST: GET /resource, POST /resource, GET /resource/:id, PUT /resource/:id, DELETE /resource/:id
    endpoints.push({ method: 'GET', path: `/${resource}`, name: `list_${resource}` });
    endpoints.push({ method: 'POST', path: `/${resource}`, name: `create_${resource.replace(/s$/, '')}` });
    endpoints.push({ method: 'GET', path: `/${resource}/1`, name: `get_${resource.replace(/s$/, '')}` });
    endpoints.push({ method: 'PUT', path: `/${resource}/1`, name: `update_${resource.replace(/s$/, '')}` });
    endpoints.push({ method: 'DELETE', path: `/${resource}/1`, name: `delete_${resource.replace(/s$/, '')}` });
  }
  
  return probeApi(baseUrl, endpoints, headers);
}

// ─── Blind Endpoint Enumeration ──────────────────────────────────────

// Common API resource names to try
const COMMON_RESOURCES = [
  // Auth & users
  'auth', 'login', 'logout', 'register', 'signup', 'signin', 'token', 'tokens', 'refresh',
  'session', 'sessions', 'oauth', 'sso', 'verify', 'reset-password', 'forgot-password',
  'users', 'user', 'me', 'profile', 'account', 'accounts',
  // Core CRUD
  'items', 'products', 'orders', 'payments', 'invoices', 'subscriptions',
  'posts', 'comments', 'messages', 'notifications', 'alerts',
  'files', 'uploads', 'images', 'media', 'documents', 'attachments',
  'tags', 'categories', 'labels', 'groups', 'teams', 'roles', 'permissions',
  // API meta
  'health', 'healthz', 'ping', 'status', 'info', 'version', 'config',
  'metrics', 'stats', 'analytics', 'logs', 'events', 'audit',
  // Common features
  'search', 'query', 'filter', 'export', 'import', 'sync', 'batch',
  'webhooks', 'hooks', 'callbacks', 'triggers',
  'jobs', 'tasks', 'queue', 'workers', 'workflows', 'pipelines', 'runs',
  'keys', 'api-keys', 'apikeys', 'secrets',
  'domains', 'projects', 'workspaces', 'organizations', 'orgs',
  // AI/ML
  'completions', 'chat', 'embeddings', 'models', 'agents', 'prompts',
  'scrape', 'crawl', 'extract', 'map', 'transform',
  // Comms
  'emails', 'email', 'sms', 'send', 'contacts', 'lists', 'audiences', 'broadcasts', 'campaigns',
  'templates', 'channels', 'conversations', 'threads',
];

// Common API path prefixes
const API_PREFIXES = ['', '/api', '/api/v1', '/api/v2', '/api/v3', '/v1', '/v2', '/v3'];

/**
 * Quickly check if a path+method exists (returns status code)
 */
async function quickProbe(baseUrl, method, path, headers = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const opts = {
      method,
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
      signal: controller.signal,
    };
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      opts.body = JSON.stringify({});
    }
    const res = await fetch(url, opts);
    clearTimeout(timeout);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: text.slice(0, 500) };
  } catch {
    return { status: 0 };
  }
}

/**
 * Check if a response indicates the endpoint exists (even if the request is invalid)
 */
function endpointExists(status, text) {
  // 200-299: exists and works
  if (status >= 200 && status < 300) return true;
  // 400, 422: exists but bad request (validation error = endpoint is real)
  if (status === 400 || status === 422) return true;
  // 401, 403: exists but needs auth
  if (status === 401 || status === 403) return true;
  // 405: method not allowed (path exists, wrong method)
  if (status === 405) return 'wrong-method';
  // 404, 0, 500+: doesn't exist or broken
  return false;
}

/**
 * Blind endpoint enumeration — discovers what endpoints an API has
 */
async function enumerateEndpoints(baseUrl, headers = {}) {
  log(`Enumerating endpoints on ${baseUrl}...`);
  
  // Step 1: Detect which API prefixes are active
  log('\nPhase 1: Detecting API prefixes...');
  const activePrefixes = [];
  for (const prefix of API_PREFIXES) {
    // Try a known health/status endpoint
    const { status } = await quickProbe(baseUrl, 'GET', `${prefix}/health`, headers);
    if (status > 0 && status < 500 && status !== 404) {
      activePrefixes.push(prefix);
      log(`  Active prefix: ${prefix || '(root)'} (health → ${status})`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  if (activePrefixes.length === 0) {
    activePrefixes.push(''); // fallback to root
    log('  No prefix detected, will try all');
    // Try all prefixes since we couldn't narrow down
    activePrefixes.push(...API_PREFIXES.filter(p => p !== ''));
  }
  const uniquePrefixes = [...new Set(activePrefixes)];
  
  // Step 2: Enumerate resources under each prefix
  const totalChecks = COMMON_RESOURCES.length * uniquePrefixes.length;
  log(`\nPhase 2: Probing ${COMMON_RESOURCES.length} resources × ${uniquePrefixes.length} prefixes (${totalChecks} combos)...`);
  const found = []; // { method, path, status }
  const methods = ['GET', 'POST'];
  let checked = 0;
  
  for (const prefix of uniquePrefixes) {
  for (const resource of COMMON_RESOURCES) {
    const path = `${prefix}/${resource}`;
    
    for (const method of methods) {
      checked++;
      const { status, text } = await quickProbe(baseUrl, method, path, headers);
      const exists = endpointExists(status, text);
      
      if (exists === true) {
        log(`  ✓ ${method} ${path} → ${status}`);
        found.push({ method, path, status });
      } else if (exists === 'wrong-method') {
        // 405 on this method, but path exists — try others
        const otherMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter(m => m !== method);
        for (const alt of otherMethods) {
          const { status: altStatus } = await quickProbe(baseUrl, alt, path, headers);
          const altExists = endpointExists(altStatus);
          if (altExists === true) {
            log(`  ✓ ${alt} ${path} → ${altStatus} (found via 405)`);
            found.push({ method: alt, path, status: altStatus });
          }
        }
      }
      
      // Small delay to be polite
      await new Promise(r => setTimeout(r, 100));
    }
    
    // Progress every 20 resources
    if (checked % 40 === 0) {
      log(`  ... checked ${checked}/${totalChecks * 2} probes, found ${found.length} endpoints`);
    }
  }
  } // end prefix loop
  
  // Step 3: For found paths, try all CRUD methods
  log(`\nPhase 3: Testing CRUD methods on ${found.length} discovered paths...`);
  const allEndpoints = new Map(); // "METHOD /path" -> { method, path, status }
  
  for (const f of found) {
    allEndpoints.set(`${f.method} ${f.path}`, f);
  }
  
  const uniquePaths = [...new Set(found.map(f => f.path))];
  for (const path of uniquePaths) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const key = `${method} ${path}`;
      if (allEndpoints.has(key)) continue;
      
      const { status } = await quickProbe(baseUrl, method, path, headers);
      if (endpointExists(status) === true) {
        log(`  ✓ ${method} ${path} → ${status}`);
        allEndpoints.set(key, { method, path, status });
      }
      await new Promise(r => setTimeout(r, 50));
    }
    
    // Also try /path/:id pattern
    const idPath = `${path}/1`;
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const key = `${method} ${idPath}`;
      if (allEndpoints.has(key)) continue;
      
      const { status } = await quickProbe(baseUrl, method, idPath, headers);
      if (endpointExists(status) === true) {
        log(`  ✓ ${method} ${idPath} → ${status}`);
        allEndpoints.set(key, { method, path: idPath, status });
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }
  
  const endpoints = Array.from(allEndpoints.values());
  log(`\nEnumeration complete: found ${endpoints.length} live endpoints`);
  
  return endpoints;
}

/**
 * Full blind probe: enumerate endpoints then probe each for params
 */
async function blindProbe(baseUrl, headers = {}) {
  const endpoints = await enumerateEndpoints(baseUrl, headers);
  
  if (endpoints.length === 0) {
    log('No endpoints found');
    return { url: baseUrl, sourceType: 'probe', discoveredAt: new Date().toISOString(), toolCount: 0, tools: [] };
  }
  
  log(`\nPhase 4: Probing ${endpoints.length} endpoints for parameters...`);
  const tools = [];
  
  for (const ep of endpoints) {
    log(`  Probing ${ep.method} ${ep.path}...`);
    const tool = await probeEndpoint(baseUrl, ep.method, ep.path, headers);
    tools.push(tool);
    await new Promise(r => setTimeout(r, 300));
  }
  
  return {
    url: baseUrl,
    sourceType: 'probe',
    discoveredAt: new Date().toISOString(),
    toolCount: tools.length,
    tools,
  };
}

// ─── Merge: Docs + Probe ─────────────────────────────────────────────

/**
 * Merge docs-discovered tools with probe-verified data.
 * Docs provide full param lists; probe confirms which are truly required
 * and discovers any the docs missed.
 */
function mergeDocsAndProbe(docTools, probeTools) {
  const probeMap = new Map();
  for (const pt of probeTools) {
    const key = `${pt.method} ${pt.path}`;
    probeMap.set(key, pt);
  }
  
  const merged = [];
  for (const dt of docTools) {
    const key = `${dt.method} ${dt.path}`;
    const pt = probeMap.get(key);
    
    if (!pt) {
      // No probe data — keep docs version, mark unverified
      merged.push({ ...dt, verified: false });
      continue;
    }
    
    // Merge params: docs params enriched with probe confirmation
    const probeParamMap = new Map();
    for (const pp of pt.params) {
      probeParamMap.set(pp.name, pp);
    }
    
    const mergedParams = dt.params.map(dp => {
      const pp = probeParamMap.get(dp.name);
      if (pp) {
        return {
          ...dp,
          required: pp.required, // probe-confirmed required status
          confirmedByProbe: true,
          probeDescription: pp.description,
        };
      }
      return { ...dp, confirmedByProbe: false };
    });
    
    // Add any probe-only params not in docs
    for (const pp of pt.params) {
      if (!dt.params.find(dp => dp.name === pp.name)) {
        mergedParams.push({ ...pp, source: 'probe-only', confirmedByProbe: true });
      }
    }
    
    // Determine probe status
    let probeStatus = 'unknown';
    if (pt.auth?.type === 'required') probeStatus = 'needs-auth';
    else if (pt.params.length > 0 || pt.description !== '') probeStatus = 'verified';
    else probeStatus = 'exists';
    
    merged.push({
      ...dt,
      params: mergedParams,
      verified: true,
      probeStatus,
      auth: pt.auth || dt.auth,
    });
    
    probeMap.delete(key);
  }
  
  // Add any probe-only endpoints not in docs
  for (const [, pt] of probeMap) {
    merged.push({ ...pt, source: 'probe-only', verified: true });
  }
  
  return merged;
}

/**
 * Full pipeline: crawl docs → probe endpoints → merge
 */
async function discoverAndVerify(docsUrl, apiBaseUrl, options = {}) {
  const { crawl = true, maxPages, headers = {}, useFirecrawl = false } = options;
  
  // Phase 1: Discover from docs
  log('═══ Phase 1: Discovering endpoints from docs ═══\n');
  const docsResult = await discover(docsUrl, { crawl, maxPages, useFirecrawl });
  log(`\nDocs found ${docsResult.toolCount} endpoints via ${docsResult.sourceType}\n`);
  
  if (docsResult.toolCount === 0) {
    return docsResult;
  }
  
  // Skip probing if we got structured spec data (OpenAPI/MCP) — already high confidence
  if (docsResult.sourceType === 'openapi' || docsResult.sourceType === 'mcp') {
    log('Skipping probe — structured spec already provides reliable schema\n');
    return docsResult;
  }
  
  // Phase 2: Probe each endpoint
  log('═══ Phase 2: Probing endpoints for verification ═══\n');
  const endpoints = docsResult.tools
    .filter(t => t.method && t.path)
    .map(t => ({ method: t.method, path: t.path, name: t.name }));
  
  const probeResult = await probeApi(apiBaseUrl, endpoints, headers);
  log(`\nProbe verified ${probeResult.tools.filter(t => t.params.length > 0).length} endpoints with params\n`);
  
  // Phase 3: Merge
  log('═══ Phase 3: Merging results ═══\n');
  const mergedTools = mergeDocsAndProbe(docsResult.tools, probeResult.tools);
  
  const verified = mergedTools.filter(t => t.verified).length;
  const withProbeParams = mergedTools.filter(t => t.params?.some(p => p.confirmedByProbe)).length;
  log(`Merged: ${mergedTools.length} total, ${verified} verified, ${withProbeParams} with probe-confirmed params`);
  
  return {
    url: docsUrl,
    apiBaseUrl,
    sourceType: 'docs+probe',
    discoveredAt: new Date().toISOString(),
    toolCount: mergedTools.length,
    tools: mergedTools,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Tool Discovery - Extract API tools from any docs URL

Usage:
  node discover.mjs <url>                          Extract from single URL
  node discover.mjs <url> --crawl                  Crawl docs site for all endpoints
  node discover.mjs <url> --max-pages 30           Set max pages to crawl (default: 20)
  node discover.mjs <url> --probe <resources...>   Probe API via error responses
  node discover.mjs <url> --crawl --verify <api-base>  Crawl docs + probe API
  node discover.mjs <url> --output tools.json      Save to file

Probe mode:
  Discovers params by hitting endpoints and reading error responses.
  Provide resource names (plural) as space-separated args after --probe.
  Example: node discover.mjs https://petstore.swagger.io/v2 --probe pets users store

Environment:
  OPENAI_API_KEY    Required for HTML docs AI extraction

Examples:
  node discover.mjs https://api.stripe.com/openapi.json
  node discover.mjs https://docs.github.com/en/rest --crawl
  node discover.mjs https://petstore.swagger.io/v2 --probe pet store user
`);
    process.exit(0);
  }
  
  const url = args.find(a => a.startsWith('http'));
  if (!url) {
    console.error('Error: Please provide a URL');
    process.exit(1);
  }
  
  const crawl = args.includes('--crawl');
  const useFirecrawl = args.includes('--firecrawl');
  const probe = args.includes('--probe');
  const maxPagesIdx = args.indexOf('--max-pages');
  const maxPages = maxPagesIdx >= 0 ? parseInt(args[maxPagesIdx + 1]) : MAX_CRAWL_PAGES;
  const outputIdx = args.indexOf('--output') >= 0 ? args.indexOf('--output') : args.indexOf('-o');
  const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;
  
  // Extract probe resources (everything after --probe that isn't a flag)
  let probeResources = [];
  if (probe) {
    const probeIdx = args.indexOf('--probe');
    for (let i = probeIdx + 1; i < args.length; i++) {
      if (args[i].startsWith('--')) break;
      probeResources.push(args[i]);
    }
  }
  const probeFromIdx = args.indexOf('--probe-from');
  const probeFromFile = probeFromIdx >= 0 ? args[probeFromIdx + 1] : null;
  const verifyIdx = args.indexOf('--verify');
  const verifyBaseUrl = verifyIdx >= 0 ? args[verifyIdx + 1] : null;
  const headerIdx = args.indexOf('--header');
  const probeHeaders = {};
  if (headerIdx >= 0) {
    const hVal = args[headerIdx + 1];
    const [k, ...v] = hVal.split(':');
    probeHeaders[k.trim()] = v.join(':').trim();
  }
  
  try {
    let result;
    if (verifyBaseUrl) {
      // Full pipeline: docs crawl + probe verification
      result = await discoverAndVerify(url, verifyBaseUrl, { crawl, maxPages, headers: probeHeaders, useFirecrawl });
    } else if (probe || probeFromFile) {
      if (probeFromFile) {
        // Load endpoints from a previous discovery file
        const prev = JSON.parse(readFileSync(resolve(probeFromFile), 'utf8'));
        const endpoints = prev.tools.map(t => ({ method: t.method || 'GET', path: t.path, name: t.name }));
        result = await probeApi(url, endpoints, probeHeaders);
      } else if (probeResources.length > 0) {
        result = await probeDiscover(url, probeResources, probeHeaders);
      } else {
        // Blind enumeration mode — no resources specified, discover everything
        result = await blindProbe(url, probeHeaders);
      }
    } else {
      result = await discover(url, { crawl, maxPages, useFirecrawl });
    }
    
    const output = JSON.stringify(result, null, 2);
    
    if (outputFile) {
      writeFileSync(resolve(outputFile), output);
      log(`Saved to ${outputFile}`);
    } else {
      console.log(output);
    }
    
    // Summary to stderr
    log(`\n✅ Done! Found ${result.toolCount} tools via ${result.sourceType}`);
    if (result.tools.length > 0) {
      log('Tools found:');
      for (const tool of result.tools.slice(0, 15)) {
        const method = tool.method ? `${tool.method} ` : '';
        const path = tool.path ? `${tool.path} ` : '';
        log(`  - ${tool.name} ${method}${path}(${tool.params.length} params)`);
      }
      if (result.tools.length > 15) {
        log(`  ... and ${result.tools.length - 15} more`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Export for programmatic use
export { discover, extractOpenApiTools, extractMcpTools, extractToolsFromHtmlAI };

main();
