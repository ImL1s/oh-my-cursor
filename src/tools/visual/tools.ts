import type { ToolDefinition } from '../types.js';
import type { VisualCapture, VisualCaptureType } from './types.js';
import { compareVisualCaptures, packageVisualReviewEvidence, recordVisualCapture } from './visual.js';

export function createVisualTools(): ToolDefinition[] {
  const captureTool: ToolDefinition = {
    name: 'visual_capture',
    aliases: ['ui_capture', 'omcu_visual_capture'],
    description: 'Record a visual capture, DOM snapshot, or browser test result reference.',
    provider: 'sdk-custom',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['screenshot', 'dom_snapshot', 'browser_log', 'visual_diff'],
          description: 'Type of visual artifact',
        },
        targetUrl: { type: 'string', description: 'URL or component identifier' },
        contentRef: { type: 'string', description: 'Path to captured screenshot or DOM payload' },
        width: { type: 'number', description: 'Viewport width' },
        height: { type: 'number', description: 'Viewport height' },
      },
      required: ['type', 'contentRef'],
    },
    execute: async (args, _context, env) => {
      const type = String(args.type) as VisualCaptureType;
      const contentRef = String(args.contentRef);
      const targetUrl = args.targetUrl ? String(args.targetUrl) : undefined;
      const dimensions =
        args.width && args.height
          ? { width: Number(args.width), height: Number(args.height) }
          : undefined;

      const projectRoot = env?.projectRoot ?? process.cwd();
      const capture = recordVisualCapture(
        {
          type,
          contentRef,
          targetUrl,
          dimensions,
        },
        projectRoot
      );

      return JSON.stringify(capture, null, 2);
    },
  };

  const compareTool: ToolDefinition = {
    name: 'visual_compare',
    aliases: ['ui_compare', 'omcu_visual_compare'],
    description: 'Compare two visual captures and compute difference score and diff artifact.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        baselineRef: { type: 'string', description: 'Baseline capture path or content' },
        candidateRef: { type: 'string', description: 'Candidate capture path or content' },
        maxDiffScore: { type: 'number', description: 'Maximum allowed diff fraction (default 0.05)' },
        notes: { type: 'string', description: 'Comparison rationale or notes' },
      },
      required: ['baselineRef', 'candidateRef'],
    },
    execute: async (args, _context, env) => {
      const baselineRef = String(args.baselineRef);
      const candidateRef = String(args.candidateRef);
      const maxDiffScore = args.maxDiffScore !== undefined ? Number(args.maxDiffScore) : undefined;
      const notes = args.notes ? String(args.notes) : undefined;
      const projectRoot = env?.projectRoot ?? process.cwd();

      const result = compareVisualCaptures(
        baselineRef,
        candidateRef,
        { maxDiffScore, notes },
        projectRoot
      );

      return JSON.stringify(result, null, 2);
    },
  };

  const reviewEvidenceTool: ToolDefinition = {
    name: 'visual_review_evidence',
    aliases: ['visual_verdict', 'omcu_visual_review'],
    description: 'Package visual review evidence. Enforces that a visual pass must have real visual capture evidence.',
    provider: 'sdk-custom',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['pass', 'fail', 'inconclusive'],
          description: 'Visual review verdict',
        },
        captures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              contentRef: { type: 'string' },
              targetUrl: { type: 'string' },
            },
            required: ['type', 'contentRef'],
          },
          description: 'Visual captures supporting this verdict',
        },
        notes: { type: 'string', description: 'Detailed review notes' },
      },
      required: ['verdict', 'captures', 'notes'],
    },
    execute: async (args, _context, env) => {
      const verdict = String(args.verdict) as 'pass' | 'fail' | 'inconclusive';
      const captures = (args.captures as unknown as VisualCapture[]) ?? [];
      const notes = String(args.notes);
      const projectRoot = env?.projectRoot ?? process.cwd();

      const evidence = packageVisualReviewEvidence(
        {
          verdict,
          captures,
          notes,
        },
        projectRoot
      );

      return JSON.stringify(evidence, null, 2);
    },
  };

  return [captureTool, compareTool, reviewEvidenceTool];
}
