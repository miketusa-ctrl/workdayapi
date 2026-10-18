# WorkdayAPI

Business-day and public-holiday math for 29 countries: add business days, days between, holidays.

## Live service

- Web app and API: https://workdayapi.mike-tusa.workers.dev/
- Pricing: https://workdayapi.mike-tusa.workers.dev/docs
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

WorkdayAPI is a remote MCP server (Streamable HTTP) at `https://workdayapi.mike-tusa.workers.dev/mcp`. Tools: `get_holidays`, `is_business_day`, `add_business_days`, `business_days_between`, `list_countries`.

Cursor and Windsurf accept this config:

```json
{
  "mcpServers": {
    "workdayapi": {
      "type": "http",
      "url": "https://workdayapi.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Cline (MCP Servers > Remote Servers, or `cline_mcp_settings.json`) needs `"type": "streamableHttp"`:

```json
{
  "mcpServers": {
    "workdayapi": {
      "type": "streamableHttp",
      "url": "https://workdayapi.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://workdayapi.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://workdayapi.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 22+ and a Cloudflare account.

```bash
npm install
npx wrangler@4 dev      # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler@4 deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
