/**
 * ワーカープール方式の並列実行ヘルパー。
 * 元々は app/api/manual/annotate/route.ts の private 関数だったが、
 * app/api/manual/verify/route.ts でも同じパターンが必要になったため切り出した。
 */

/**
 * items を同時 limit 件までで処理する。
 * fn は内部で必ず try/catch すること（throw するとワーカーが1本死んで並列度が落ちる）。
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await fn(items[index], index);
      }
    }),
  );
}
