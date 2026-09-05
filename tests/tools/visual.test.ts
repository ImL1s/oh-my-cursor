import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVisualCaptures,
  createToolRegistry,
  createVisualTools,
  packageVisualReviewEvidence,
  recordVisualCapture,
} from '../../src/tools/index.js';

describe('Visual Evidence and UI Review Tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-visual-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('strictly rejects visual pass verdict when visual capture evidence is missing', () => {
    expect(() =>
      packageVisualReviewEvidence(
        {
          verdict: 'pass',
          captures: [], // Empty captures
          notes: 'Looks good by reading the code',
        },
        tempDir
      )
    ).toThrow(/E_VISUAL_EVIDENCE_MISSING: Cannot report a visual pass without visual capture evidence/);
  });

  it('records visual capture and performs visual comparison', () => {
    const file1 = path.join(tempDir, 'shot1.png');
    const file2 = path.join(tempDir, 'shot2.png');
    fs.writeFileSync(file1, 'IMAGE_DATA_V1');
    fs.writeFileSync(file2, 'IMAGE_DATA_V1');

    const capture = recordVisualCapture(
      {
        type: 'screenshot',
        contentRef: file1,
        dimensions: { width: 1280, height: 800 },
      },
      tempDir
    );
    expect(capture.timestamp).toBeDefined();

    const comparison = compareVisualCaptures(file1, file2, undefined, tempDir);
    expect(comparison.diffScore).toBe(0.0);
    expect(comparison.isMatch).toBe(true);

    // Modified file2
    fs.writeFileSync(file2, 'IMAGE_DATA_V2_DIFFERENT');
    const comp2 = compareVisualCaptures(file1, file2, undefined, tempDir);
    expect(comp2.diffScore).toBeGreaterThan(0.0);
  });

  it('packages visual review evidence with captures via ToolRegistry', async () => {
    const registry = createToolRegistry(createVisualTools());

    // 1. Record capture
    const captureRes = await registry.execute(
      'visual_capture',
      {
        type: 'screenshot',
        contentRef: 'mock-screenshot.png',
        targetUrl: 'http://localhost:3000',
        width: 1024,
        height: 768,
      },
      { toolCallId: 'vis-1' },
      { projectRoot: tempDir }
    );
    const parsedCapture = JSON.parse(captureRes as string);
    expect(parsedCapture.type).toBe('screenshot');

    // 2. Package review evidence
    const evidenceRes = await registry.execute(
      'visual_review_evidence',
      {
        verdict: 'pass',
        captures: [parsedCapture],
        notes: 'Verified UI matches design system',
      },
      { toolCallId: 'vis-2' },
      { projectRoot: tempDir }
    );
    const parsedEvidence = JSON.parse(evidenceRes as string);
    expect(parsedEvidence.artifactPath).toContain('.omcu/artifacts/visual/visual-review-');
    expect(fs.existsSync(path.join(tempDir, parsedEvidence.artifactPath))).toBe(true);
  });
});
