/// <reference lib="webworker" />
// Web Worker entry for lyric parsing: keeps the (potentially 1k+ line) parsers off the
// animation thread. Message protocol is defined in lyrics-client.ts.

import { parseLyrics } from "./lyrics/index.ts";

interface LyricJob {
  id: number;
  text: string;
  format?: string;
  translation?: string;
  romanization?: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<LyricJob>) => {
  const { id, text, format, translation, romanization } = event.data;
  try {
    const result = await parseLyrics({ text, format, translation, romanization });
    ctx.postMessage({
      id,
      data: { lines: result.data.lines.map((line) => ({ ...line })) },
      empty: result.empty,
      ...(result.rejected ? { rejected: result.rejected } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    ctx.postMessage({ id, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
