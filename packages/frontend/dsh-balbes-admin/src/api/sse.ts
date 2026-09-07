/**
 * Minimal incremental SSE parser: buffers until a blank line, then emits the
 * payload of the last "data:" line in the frame. Comment lines (": ...") and
 * event/id fields are ignored — the server sends only data frames.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let data: string | null = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) data = line.slice("data:".length).trimStart();
        // other fields and comments are ignored
      }
      if (data !== null) onData(data);
    }
  };
}
