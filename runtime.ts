/**
 * runtime.ts — Shared runtime for generated workflow nodes
 * 
 * Handles credentials, HTTP execution, retries, rate limiting,
 * pagination, and structured error parsing.
 * 
 * All generated nodes import from this module instead of
 * reimplementing HTTP logic per-node.
 */

import type { NodeExecutionContext } from '@jam-nodes/core';

// ═══════════════════════════════════════════════════════════════
// Credentials
// ═══════════════════════════════════════════════════════════════

export interface ServiceCredentials {
  baseUrl: string;
  token?: string;
  apiKey?: string;
  headerName?: string;  // custom header for API key (default: Authorization)
  scheme?: string;      // auth scheme (default: Bearer)
}

const credentialCache = new Map<string, ServiceCredentials>();

/**
 * Get credentials for a service. Checks context.services.credentials first,
 * falls back to environment variables, then cached values.
 */
export function getCredentials(service: string, context: NodeExecutionContext): ServiceCredentials {
  // 1. From workflow context (highest priority)
  const ctxCreds = (context.services as any)?.credentials?.[service] as ServiceCredentials | undefined;
  if (ctxCreds) {
    credentialCache.set(service, ctxCreds);
    return ctxCreds;
  }

  // 2. From cache
  const cached = credentialCache.get(service);
  if (cached) return cached;

  throw new Error(
    `Missing credentials for "${service}". ` +
    `Set them via context.services.credentials["${service}"] = { baseUrl, token/apiKey }.`
  );
}

/**
 * Pre-register credentials (e.g. at engine startup from config file).
 */
export function registerCredentials(service: string, creds: ServiceCredentials): void {
  credentialCache.set(service, creds);
}

// ═══════════════════════════════════════════════════════════════
// HTTP Client with retries + rate limiting
// ═══════════════════════════════════════════════════════════════

export interface HttpRequestConfig {
  service: string;
  method: string;
  pathTemplate: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  context: NodeExecutionContext;
  /** Override timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retries on transient errors (default: 3) */
  maxRetries?: number;
  /** Whether to follow pagination (default: false) */
  paginate?: boolean;
  /** Max pages to fetch when paginating (default: 10) */
  maxPages?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  ok: boolean;
  durationMs: number;
  retries: number;
  /** If paginated, all pages concatenated */
  pages?: number;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
}

// Rate limit state per service
const rateLimitState = new Map<string, { resetAt: number; remaining: number }>();

/**
 * Execute an HTTP request with retry logic, rate limiting, and error parsing.
 */
export async function executeRequest<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
  const creds = getCredentials(config.service, config.context);
  const maxRetries = config.maxRetries ?? 3;
  const timeout = config.timeout ?? 30000;
  
  // Build URL
  let path = config.pathTemplate;
  if (config.pathParams) {
    for (const [key, value] of Object.entries(config.pathParams)) {
      path = path.replace(`{${key}}`, encodeURIComponent(value));
    }
  }
  
  let url = `${creds.baseUrl.replace(/\/$/, '')}${path}`;
  
  // Add query params
  if (config.queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(config.queryParams)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  
  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  
  if (creds.token) {
    const scheme = creds.scheme || 'Bearer';
    headers['Authorization'] = `${scheme} ${creds.token}`;
  } else if (creds.apiKey) {
    const headerName = creds.headerName || 'Authorization';
    if (headerName === 'Authorization') {
      headers['Authorization'] = `Bearer ${creds.apiKey}`;
    } else {
      headers[headerName] = creds.apiKey;
    }
  }
  
  // Build body
  const bodyStr = config.body && ['POST', 'PUT', 'PATCH'].includes(config.method.toUpperCase())
    ? JSON.stringify(config.body)
    : undefined;
  
  // Execute with retries
  let lastError: ApiError | null = null;
  let retries = 0;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check rate limit
    const rl = rateLimitState.get(config.service);
    if (rl && rl.remaining <= 0 && Date.now() < rl.resetAt) {
      const waitMs = rl.resetAt - Date.now();
      if (waitMs > 0 && waitMs < 60000) {
        await sleep(waitMs);
      }
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();
    
    try {
      const response = await fetch(url, {
        method: config.method.toUpperCase(),
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      const durationMs = Date.now() - start;
      
      // Update rate limit state from headers
      updateRateLimit(config.service, response.headers);
      
      // Parse response body
      const contentType = response.headers.get('content-type') || '';
      let body: any;
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        const text = await response.text();
        try { body = JSON.parse(text); } catch { body = text; }
      }
      
      // Convert headers
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });
      
      // Handle errors
      if (!response.ok) {
        const apiError = parseApiError(response.status, body, respHeaders);
        
        // Retry on transient errors
        if (apiError.retryable && attempt < maxRetries) {
          lastError = apiError;
          retries++;
          const delay = apiError.retryAfterMs || getBackoffMs(attempt);
          await sleep(delay);
          continue;
        }
        
        return {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
          body,
          ok: false,
          durationMs,
          retries,
        };
      }
      
      return {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
        body: body as T,
        ok: true,
        durationMs,
        retries,
      };
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        if (attempt < maxRetries) {
          retries++;
          await sleep(getBackoffMs(attempt));
          continue;
        }
        throw new NodeExecutionError('timeout', `Request timed out after ${timeout}ms`, true);
      }
      
      // Network errors are retryable
      if (attempt < maxRetries) {
        retries++;
        await sleep(getBackoffMs(attempt));
        continue;
      }
      
      throw new NodeExecutionError(
        'network',
        error instanceof Error ? error.message : 'Network request failed',
        false
      );
    }
  }
  
  // Should not reach here, but just in case
  throw new NodeExecutionError(
    lastError?.code || 'unknown',
    lastError?.message || 'Request failed after all retries',
    false
  );
}

// ═══════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════

export interface PaginationConfig {
  /** Strategy: 'cursor' | 'offset' | 'link' | 'page' */
  strategy: 'cursor' | 'offset' | 'link' | 'page';
  /** Field in response containing next cursor/page token */
  cursorField?: string;
  /** Query param name for cursor/offset/page (default: varies by strategy) */
  paramName?: string;
  /** Field in response containing the items array */
  dataField?: string;
  /** Max pages to fetch (default: 10) */
  maxPages?: number;
  /** Items per page (for offset strategy) */
  pageSize?: number;
}

/**
 * Execute a paginated request, collecting all items across pages.
 */
export async function executePaginated<T = unknown>(
  config: HttpRequestConfig,
  pagination: PaginationConfig
): Promise<{ items: T[]; pages: number; totalItems: number }> {
  const maxPages = pagination.maxPages ?? 10;
  const allItems: T[] = [];
  let page = 0;
  let cursor: string | number | undefined;
  
  for (let i = 0; i < maxPages; i++) {
    // Add pagination params
    const queryParams = { ...config.queryParams };
    
    switch (pagination.strategy) {
      case 'cursor':
        if (cursor) queryParams[pagination.paramName || 'cursor'] = cursor as string;
        break;
      case 'offset':
        queryParams[pagination.paramName || 'offset'] = String(i * (pagination.pageSize || 20));
        if (pagination.pageSize) queryParams['limit'] = String(pagination.pageSize);
        break;
      case 'page':
        queryParams[pagination.paramName || 'page'] = String(i + 1);
        break;
      // 'link' handled via response headers
    }
    
    const response = await executeRequest<any>({ ...config, queryParams });
    
    if (!response.ok) break;
    
    // Extract items
    const body = response.body;
    const items = pagination.dataField ? getNestedField(body, pagination.dataField) : body;
    
    if (Array.isArray(items)) {
      allItems.push(...items);
      if (items.length === 0) break; // empty page = done
    } else if (items && typeof items === 'object') {
      allItems.push(items as T);
    } else {
      break;
    }
    
    page++;
    
    // Get next cursor/page
    if (pagination.strategy === 'cursor') {
      const nextCursor = pagination.cursorField ? getNestedField(body, pagination.cursorField) : null;
      if (!nextCursor) break;
      cursor = nextCursor as string;
    } else if (pagination.strategy === 'link') {
      const linkHeader = response.headers['link'];
      const nextUrl = parseLinkHeader(linkHeader);
      if (!nextUrl) break;
      // For link-based, we'd need to override the URL — simplified here
      break;
    }
  }
  
  return { items: allItems, pages: page, totalItems: allItems.length };
}

// ═══════════════════════════════════════════════════════════════
// Error Parsing
// ═══════════════════════════════════════════════════════════════

export class NodeExecutionError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public field?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'NodeExecutionError';
  }
}

/**
 * Parse raw API error responses into structured ApiError objects.
 * Handles common error formats: REST standard, Stripe-style, AWS-style, etc.
 */
function parseApiError(status: number, body: any, headers: Record<string, string>): ApiError {
  const retryable = status === 429 || status === 502 || status === 503 || status === 504;
  
  // Parse retry-after header
  let retryAfterMs: number | undefined;
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter);
    if (!isNaN(seconds)) {
      retryAfterMs = seconds * 1000;
    } else {
      // HTTP date format
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        retryAfterMs = Math.max(0, date.getTime() - Date.now());
      }
    }
  }
  
  // Rate limit: default 1s wait if no retry-after
  if (status === 429 && !retryAfterMs) {
    retryAfterMs = 1000;
  }
  
  // Try to extract structured error info from body
  if (body && typeof body === 'object') {
    // Standard { error: { message, code } } (Stripe, many APIs)
    if (body.error && typeof body.error === 'object') {
      return {
        status,
        code: body.error.code || body.error.type || statusToCode(status),
        message: body.error.message || body.error.description || JSON.stringify(body.error),
        field: body.error.param || body.error.field,
        details: body.error,
        retryable,
        retryAfterMs,
      };
    }
    
    // { error: "string message" }
    if (typeof body.error === 'string') {
      return {
        status,
        code: statusToCode(status),
        message: body.error,
        retryable,
        retryAfterMs,
      };
    }
    
    // { message: "..." } (many REST APIs)
    if (body.message) {
      return {
        status,
        code: body.code || body.error_code || statusToCode(status),
        message: body.message,
        field: body.field || body.param,
        details: body.details || body.errors,
        retryable,
        retryAfterMs,
      };
    }
    
    // { errors: [...] } (JSON:API, GraphQL-style)
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      return {
        status,
        code: first.code || statusToCode(status),
        message: first.message || first.title || first.detail || JSON.stringify(first),
        field: first.source?.pointer || first.field,
        details: body.errors,
        retryable,
        retryAfterMs,
      };
    }
    
    // Validation errors: { detail: [...] } (FastAPI/Pydantic)
    if (Array.isArray(body.detail)) {
      const msgs = body.detail.map((d: any) =>
        `${(d.loc || []).join('.')}: ${d.msg || d.message || JSON.stringify(d)}`
      );
      return {
        status,
        code: 'validation_error',
        message: msgs.join('; '),
        details: body.detail,
        retryable: false,
        retryAfterMs,
      };
    }
  }
  
  // Fallback
  return {
    status,
    code: statusToCode(status),
    message: typeof body === 'string' ? body : JSON.stringify(body) || `HTTP ${status}`,
    retryable,
    retryAfterMs,
  };
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 422: return 'validation_error';
    case 429: return 'rate_limited';
    case 500: return 'internal_error';
    case 502: return 'bad_gateway';
    case 503: return 'service_unavailable';
    case 504: return 'gateway_timeout';
    default: return `http_${status}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function updateRateLimit(service: string, headers: Headers): void {
  const remaining = headers.get('x-ratelimit-remaining') || headers.get('ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset') || headers.get('ratelimit-reset');
  
  if (remaining !== null) {
    const resetAt = reset
      ? (parseInt(reset) > 1e10 ? parseInt(reset) : parseInt(reset) * 1000) // unix ms or seconds
      : Date.now() + 60000; // default 1 min window
    
    rateLimitState.set(service, {
      remaining: parseInt(remaining) || 0,
      resetAt,
    });
  }
}

function getBackoffMs(attempt: number): number {
  // Exponential backoff with jitter: 1s, 2s, 4s, 8s...
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  const jitter = Math.random() * base * 0.3;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNestedField(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function parseLinkHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════════
// Response Schema Helpers (for typed outputs)
// ═══════════════════════════════════════════════════════════════

/**
 * Extract specific fields from a response body based on a field map.
 * Used by generated nodes to map raw API responses to typed outputs.
 */
export function mapResponse<T extends Record<string, unknown>>(
  body: unknown,
  fieldMap: Record<string, string | ((body: any) => unknown)>
): T {
  const result: Record<string, unknown> = {};
  
  for (const [outputField, source] of Object.entries(fieldMap)) {
    if (typeof source === 'function') {
      result[outputField] = source(body);
    } else if (source.includes('.')) {
      result[outputField] = getNestedField(body, source);
    } else {
      result[outputField] = (body as any)?.[source];
    }
  }
  
  return result as T;
}
