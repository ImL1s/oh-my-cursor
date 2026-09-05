import type { ToolDefinition } from '../types.js';
import { assertSafeUrl, isPrimarySource, packageResearchEvidence } from './research.js';
import type { ResearchSourceCitation } from './types.js';

export function createResearchTools(): ToolDefinition[] {
  const fetchTool: ToolDefinition = {
    name: 'research_fetch',
    aliases: ['fetch_doc', 'omcu_research_fetch'],
    description: 'Fetch and parse external reference documentation with SSRF protection and primary source citation metadata.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target documentation URL' },
        allowPrivateNetworks: { type: 'boolean', description: 'Allow private IP addresses (default false)' },
      },
      required: ['url'],
    },
    execute: async (args) => {
      const urlString = String(args.url);
      const allowPrivate = Boolean(args.allowPrivateNetworks);
      const parsedUrl = assertSafeUrl(urlString, allowPrivate);
      const domain = parsedUrl.hostname;
      const primary = isPrimarySource(domain);

      // Perform bounded HTTP fetch
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(parsedUrl.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'oh-my-cursor/0.3.0 (+https://github.com/ImL1s/oh-my-cursor)' },
        });

        if (!res.ok) {
          return JSON.stringify(
            {
              url: urlString,
              status: res.status,
              statusText: res.statusText,
              error: `HTTP error ${res.status}`,
            },
            null,
            2
          );
        }

        const text = await res.text();
        const snippet = text.slice(0, 2000);

        const citation: ResearchSourceCitation = {
          url: urlString,
          domain,
          retrievedAt: new Date().toISOString(),
          primarySource: primary,
          snippet,
        };

        return JSON.stringify(citation, null, 2);
      } catch (err) {
        return JSON.stringify(
          {
            url: urlString,
            domain,
            primarySource: primary,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  const packageTool: ToolDefinition = {
    name: 'research_evidence_package',
    aliases: ['package_research', 'omcu_research_evidence'],
    description: 'Package research citations and findings into a durable evidence artifact under .omcu/artifacts/research/.',
    provider: 'sdk-custom',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Research topic or query' },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              domain: { type: 'string' },
              retrievedAt: { type: 'string' },
              primarySource: { type: 'boolean' },
              title: { type: 'string' },
              snippet: { type: 'string' },
            },
            required: ['url', 'domain'],
          },
          description: 'Citations used for this finding',
        },
        summary: { type: 'string', description: 'Synthesized research summary' },
        rawContent: { type: 'string', description: 'Optional raw content or excerpts' },
      },
      required: ['topic', 'citations', 'summary'],
    },
    execute: async (args, _context, env) => {
      const topic = String(args.topic);
      const citations = (args.citations as unknown as ResearchSourceCitation[]) ?? [];
      const summary = String(args.summary);
      const rawContent = args.rawContent !== undefined ? String(args.rawContent) : undefined;
      const projectRoot = env?.projectRoot ?? process.cwd();

      const artifact = packageResearchEvidence(topic, citations, summary, rawContent, projectRoot);
      return JSON.stringify(artifact, null, 2);
    },
  };

  return [fetchTool, packageTool];
}
