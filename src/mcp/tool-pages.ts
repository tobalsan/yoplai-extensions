const MAX_TOOL_PAGES = 1000;

export async function* toolPages<T>(
  server: string,
  signal: AbortSignal,
  listPage: (params?: { cursor: string }) => Promise<{ tools: T[]; nextCursor?: string }>,
): AsyncGenerator<T[]> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_TOOL_PAGES; pageIndex++) {
    signal.throwIfAborted();
    const page = await listPage(cursor === undefined ? undefined : { cursor });
    signal.throwIfAborted();
    yield page.tools;
    cursor = page.nextCursor;
    if (!cursor) return;
    if (seenCursors.has(cursor)) throw new Error(`MCP server "${server}" returned a repeated cursor for tools/list`);
    seenCursors.add(cursor);
  }
  throw new Error(`MCP server "${server}" exceeded ${MAX_TOOL_PAGES} pages for tools/list`);
}
