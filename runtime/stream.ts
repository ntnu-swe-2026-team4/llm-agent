// 串流的回覆（單次型、對話型共用）：可以 for await 一段段拿文字，也可以只 await result 拿最後的結果

export interface Streamed<R> extends AsyncIterable<string> {
  /** 整個回覆完的結果 */
  result: Promise<R>;
}

/** 把「吐文字、最後 return 結果」的產生器包成 Streamed */
export function streamed<R>(gen: AsyncGenerator<string, R>): Streamed<R> {
  let resolve!: (r: R) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<R>((res, rej) => ((resolve = res), (reject = rej)));
  result.catch(() => {}); // 呼叫端用 for await 時錯誤會從那裡丟出，這裡不要再算一次「沒處理的錯誤」

  let started = false;
  async function* chunks() {
    started = true;
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done) { resolve(next.value); return; }
        yield next.value;
      }
    } catch (e) {
      reject(e);
      throw e;
    }
  }
  const iterator = chunks();
  return {
    [Symbol.asyncIterator]: () => iterator,
    get result() {
      // 沒有人在讀串流：自己讀完，結果才出得來
      if (!started) (async () => { for await (const _ of iterator); })().catch(() => {});
      return result;
    },
  };
}
