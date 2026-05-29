interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Ireland Central Statistics Office (CSO) PxStat MCP.
 *
 * CSO publishes ~12,600 official Irish statistics tables (population, CPI,
 * labour force, housing, trade, etc.) as JSON-stat 2.0 via the keyless PxStat
 * API. Each table is identified by a "matrix code" (e.g. "CPM01" = Consumer
 * Price Index, "QLF18" = labour force). The full catalog is large (~40MB), so
 * list_datasets searches/limits it client-side.
 */


const REST = 'https://ws.cso.ie/public/api.restful';
const RPC = 'https://ws.cso.ie/public/api.jsonrpc';
const UA = 'pipeworx-mcp-cso-ie/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'list_datasets',
    description:
      'Search the CSO catalog of ~12,600 Irish statistics tables. Returns matching tables with their matrix code (e.g. "CPM01"), label, dimensions, and last-updated date. The full catalog is large, so always pass a keyword query to narrow it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s) matched against table label and matrix code, e.g. "consumer price", "population", "QLF". Case-insensitive.' },
        limit: { type: 'number', description: 'Max results to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'dataset_metadata',
    description:
      'Get the structure of one CSO table by matrix code: its dimensions, the category codes + human labels for each dimension, size, and last-updated date. Use this to discover valid dimension codes before calling get_dataset with filters.',
    inputSchema: {
      type: 'object',
      properties: {
        matrix: { type: 'string', description: 'Matrix code, e.g. "CPM01" (Consumer Price Index) or "QLF18" (labour force).' },
      },
      required: ['matrix'],
    },
  },
  {
    name: 'get_dataset',
    description:
      'Read a full CSO table as JSON-stat 2.0 (dimensions + flat value array). Some tables are large (the CPI table is ~60k values); use dataset_metadata first to gauge size, or use query_dataset to fetch a filtered slice instead.',
    inputSchema: {
      type: 'object',
      properties: {
        matrix: { type: 'string', description: 'Matrix code, e.g. "CPM01".' },
      },
      required: ['matrix'],
    },
  },
  {
    name: 'query_dataset',
    description:
      'Read a FILTERED slice of a CSO table via JSON-RPC. Pass a map of dimension code -> array of category index values to keep (get the dimension codes and category index values from dataset_metadata). Returns JSON-stat 2.0 covering only the selected cells — far smaller than get_dataset.',
    inputSchema: {
      type: 'object',
      properties: {
        matrix: { type: 'string', description: 'Matrix code, e.g. "CPM01".' },
        filters: {
          type: 'object',
          description:
            'Map of dimension code to an array of category index values to keep, e.g. {"STATISTIC":["CPM01C08"],"TLIST(M1)":["202512"]}. Dimensions you omit are returned in full. Time dimensions like TLIST(M1) use YYYYMM index values (e.g. "202512").',
        },
      },
      required: ['matrix', 'filters'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_datasets': {
      const query = (args.query as string | undefined)?.trim().toLowerCase() ?? '';
      const limit = clampLimit(args.limit, 50, 200);
      const collection = (await csoGet(
        `${REST}/PxStat.Data.Cube_API.ReadCollection`,
      )) as Collection;
      const items = collection?.link?.item ?? [];
      const matched = items.filter((it) => {
        if (!query) return true;
        const label = (it.label ?? '').toLowerCase();
        const matrix = (it.extension?.matrix ?? '').toLowerCase();
        return label.includes(query) || matrix.includes(query);
      });
      return {
        total_catalog: items.length,
        matched: matched.length,
        returned: Math.min(matched.length, limit),
        datasets: matched.slice(0, limit).map((it) => ({
          matrix: it.extension?.matrix,
          label: it.label,
          dimensions: it.id,
          updated: it.updated,
        })),
      };
    }
    case 'dataset_metadata': {
      const matrix = reqStr(args, 'matrix', '"CPM01"');
      const ds = (await csoGet(datasetUrl(matrix))) as Dataset;
      const dimensions = (ds.id ?? []).map((dimId, i) => {
        const dim = ds.dimension?.[dimId];
        const cat = dim?.category ?? {};
        return {
          code: dimId,
          label: dim?.label ?? dimId,
          size: ds.size?.[i],
          categories: (cat.index ?? []).map((idx) => ({ index: idx, label: cat.label?.[idx] ?? idx })),
        };
      });
      return {
        matrix,
        label: ds.label,
        updated: ds.updated,
        size: ds.size,
        total_values: Array.isArray(ds.value) ? ds.value.length : undefined,
        note: ds.note,
        dimensions,
      };
    }
    case 'get_dataset': {
      const matrix = reqStr(args, 'matrix', '"CPM01"');
      return csoGet(datasetUrl(matrix));
    }
    case 'query_dataset': {
      const matrix = reqStr(args, 'matrix', '"CPM01"');
      const filters = args.filters;
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        throw new Error('filters must be an object mapping dimension code -> array of category index values, e.g. {"TLIST(M1)":["202512"]}.');
      }
      // Fetch metadata to learn the dimension ordering, then build the JSON-stat query.
      const meta = (await csoGet(datasetUrl(matrix))) as Dataset;
      const ids = meta.id ?? [];
      const dimension: Record<string, { category: { index: string[] } }> = {};
      for (const dimId of ids) {
        const sel = (filters as Record<string, unknown>)[dimId];
        if (Array.isArray(sel) && sel.length) {
          dimension[dimId] = { category: { index: sel.map(String) } };
        }
      }
      const body = {
        jsonrpc: '2.0',
        method: 'PxStat.Data.Cube_API.ReadDataset',
        params: {
          class: 'query',
          id: ids,
          dimension,
          extension: { matrix, language: { code: 'en' }, format: { type: 'JSON-stat', version: '2.0' } },
          version: '2.0',
        },
        id: 1,
      };
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`CSO: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      const json = (await res.json()) as { result?: unknown; error?: unknown };
      if (json.error) throw new Error(`CSO: JSON-RPC error ${JSON.stringify(json.error).slice(0, 200)}`);
      return json.result;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function datasetUrl(matrix: string): string {
  return `${REST}/PxStat.Data.Cube_API.ReadDataset/${encodeURIComponent(matrix)}/JSON-stat/2.0/en`;
}

async function csoGet(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CSO: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v.trim();
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, 1), max);
}

interface CollectionItem {
  label?: string;
  id?: string[];
  updated?: string;
  extension?: { matrix?: string };
}
interface Collection {
  link?: { item?: CollectionItem[] };
}
interface DimensionCategory {
  index?: string[];
  label?: Record<string, string>;
}
interface Dimension {
  label?: string;
  category?: DimensionCategory;
}
interface Dataset {
  label?: string;
  updated?: string;
  id?: string[];
  size?: number[];
  value?: unknown[];
  note?: unknown;
  dimension?: Record<string, Dimension>;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
