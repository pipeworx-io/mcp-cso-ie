# mcp-cso-ie

Ireland Central Statistics Office (CSO) PxStat MCP.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `list_datasets` | Search the CSO catalog of ~12,600 Irish statistics tables. Returns matching tables with their matrix code (e.g. "CPM01"), label, dimensions, and last-updated date. The full catalog is large, so always pass a keyword query to narrow it. |
| `dataset_metadata` | Get the structure of one CSO table by matrix code: its dimensions, the category codes + human labels for each dimension, size, and last-updated date. Use this to discover valid dimension codes before calling get_dataset with filters. |
| `get_dataset` | Read a full CSO table as JSON-stat 2.0 (dimensions + flat value array). Some tables are large (the CPI table is ~60k values); use dataset_metadata first to gauge size, or use query_dataset to fetch a filtered slice instead. |
| `query_dataset` | Read a FILTERED slice of a CSO table via JSON-RPC. Pass a map of dimension code -> array of category index values to keep (get the dimension codes and category index values from dataset_metadata). Returns JSON-stat 2.0 covering only the selected cells — far smaller than get_dataset. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cso-ie": {
      "url": "https://gateway.pipeworx.io/cso-ie/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cso-ie/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cso Ie data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
