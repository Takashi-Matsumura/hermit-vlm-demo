/**
 * SSE(text/event-stream) を読みながら、イベントを1件ずつコールバックに渡す。
 * app/page.tsx が持っている while ループと同じ処理だが、既存ファイルは変更しない方針なので
 * 新しいページからだけ使う。
 */
export async function readSse<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // SSE は空行1つでイベント区切り
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const line = chunk.trim();
      if (!line.startsWith("data:")) continue;
      onEvent(JSON.parse(line.slice(5).trim()) as T);
    }
  }
}
