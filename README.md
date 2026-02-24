# tool-discovery

Extract API tools/endpoints from any docs URL. Point it at an API docs page and get back structured tool definitions with params, types, and auth info.

## Supports

- **OpenAPI/Swagger specs** — auto-detected, parsed directly (no AI needed)
- **MCP endpoints** — standard `tools/list` protocol
- **HTML docs pages** — AI-powered extraction (needs OpenAI key)

## Install

```bash
npm install
cp .env.example .env
# Add your OPENAI_API_KEY to .env
```

## Usage

```bash
# OpenAPI spec (auto-detected)
node discover.mjs https://petstore3.swagger.io/api/v3/openapi.json

# HTML docs - single page
node discover.mjs https://resend.com/docs/api-reference/emails/send-email

# HTML docs - crawl entire docs site
node discover.mjs https://resend.com/docs/api-reference/emails/send-email --crawl

# Save output
node discover.mjs <url> --output tools.json

# Control crawl depth
node discover.mjs <url> --crawl --max-pages 30
```

## How It Works

1. **Detect format** — tries the URL as OpenAPI spec, probes well-known spec paths, checks for embedded specs in HTML, tries MCP
2. **If OpenAPI/Swagger** — parses the spec directly. Gets every endpoint with full param schemas, auth info, response types
3. **If MCP** — calls `tools/list` for structured tool definitions
4. **If HTML docs** — smart crawler:
   - Detects docs framework (Mintlify, ReadMe, GitBook, Docusaurus, Redoc, etc.)
   - Checks sitemap.xml for URL discovery
   - Extracts sidebar/nav links with priority scoring
   - Detects SPA shells and uses Jina Reader for JS rendering
   - Filters pages for API-like content before extraction
   - AI extracts endpoint definitions from page content
   - Deduplicates results

## Output Format

```json
{
  "url": "https://api.example.com/openapi.json",
  "sourceType": "openapi",
  "discoveredAt": "2026-02-24T03:15:19.343Z",
  "toolCount": 19,
  "tools": [
    {
      "name": "send_email",
      "method": "POST",
      "path": "/v1/emails",
      "description": "Send an email to a recipient",
      "params": [
        { "name": "to", "type": "string", "required": true, "description": "Recipient email" },
        { "name": "subject", "type": "string", "required": true, "description": "Email subject" },
        { "name": "body", "type": "string", "required": true, "description": "Email body" }
      ],
      "auth": { "type": "bearer", "header": "Authorization" },
      "sourceUrl": "https://api.example.com/v1/emails",
      "sourceType": "openapi"
    }
  ]
}
```

## Tested On

- **Swagger Petstore** — 19 endpoints extracted
- **GitHub REST API** — 1,080 endpoints extracted
- **Resend docs** (Mintlify) — framework detected, pages crawled, ready for AI extraction
