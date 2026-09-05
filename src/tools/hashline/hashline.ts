import crypto from 'node:crypto';
import { ToolError } from '../types.js';
import type { Hashline, HashlineEditChunk, HashlineEditResult } from './types.js';

export function computeLineHash(line: string): string {
  const normalized = line.replace(/\r$/, '');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
}

export function formatHashlines(content: string): readonly Hashline[] {
  const rawLines = content.split('\n');
  return rawLines.map((text, idx) => {
    const line = idx + 1;
    const hash = computeLineHash(text);
    return { line, hash, text };
  });
}

export function formatHashlineText(content: string): string {
  const hashlines = formatHashlines(content);
  return hashlines.map((h) => `${h.line} #${h.hash}: ${h.text}`).join('\n');
}

export function generateSimpleDiff(oldLines: readonly string[], newLines: readonly string[]): string {
  const diff: string[] = ['--- original', '+++ modified'];
  let i = 0;
  while (i < Math.max(oldLines.length, newLines.length)) {
    if (i < oldLines.length && i < newLines.length) {
      if (oldLines[i] !== newLines[i]) {
        diff.push(`- ${oldLines[i]}`);
        diff.push(`+ ${newLines[i]}`);
      }
    } else if (i < oldLines.length) {
      diff.push(`- ${oldLines[i]}`);
    } else {
      diff.push(`+ ${newLines[i]}`);
    }
    i++;
  }
  return diff.join('\n');
}

export function applyHashlineEdit(
  content: string,
  edits: readonly HashlineEditChunk[]
): HashlineEditResult {
  const lines = content.split('\n');
  const currentHashlines = formatHashlines(content);

  // Sort edits descending by startLine so earlier line offsets are not disturbed
  const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);

  let modifiedLinesCount = 0;

  for (const edit of sortedEdits) {
    if (edit.startLine < 1 || edit.startLine > lines.length + 1) {
      throw new ToolError(
        'E_HASH_MISMATCH',
        `Edit startLine ${edit.startLine} is out of bounds (1..${lines.length + 1})`
      );
    }
    if (edit.endLine < edit.startLine - 1 || edit.endLine > lines.length) {
      throw new ToolError(
        'E_HASH_MISMATCH',
        `Edit endLine ${edit.endLine} is out of bounds (${edit.startLine - 1}..${lines.length})`
      );
    }

    // Verify expected line hashes if specified
    if (edit.expectedHashes && edit.expectedHashes.length > 0) {
      const targetLength = edit.endLine - edit.startLine + 1;
      if (edit.expectedHashes.length !== targetLength) {
        throw new ToolError(
          'E_HASH_MISMATCH',
          `Expected ${targetLength} line hashes for range ${edit.startLine}..${edit.endLine}, got ${edit.expectedHashes.length}`
        );
      }

      for (let i = 0; i < targetLength; i++) {
        const lineIdx = edit.startLine - 1 + i;
        const actualHash = currentHashlines[lineIdx]?.hash;
        const expectedHash = edit.expectedHashes[i];
        if (actualHash !== expectedHash) {
          throw new ToolError(
            'E_STALE_EDIT',
            `Stale edit detected at line ${lineIdx + 1}: expected hash #${expectedHash}, found #${actualHash}`
          );
        }
      }
    }

    const replacementLines = edit.newText === '' ? [] : edit.newText.split('\n');
    const deleteCount = edit.endLine >= edit.startLine ? edit.endLine - edit.startLine + 1 : 0;
    lines.splice(edit.startLine - 1, deleteCount, ...replacementLines);
    modifiedLinesCount += Math.max(deleteCount, replacementLines.length);
  }

  const modifiedContent = lines.join('\n');
  const diffPreview = generateSimpleDiff(content.split('\n'), lines);

  return {
    success: true,
    modifiedContent,
    diffPreview,
    modifiedLines: modifiedLinesCount,
  };
}
