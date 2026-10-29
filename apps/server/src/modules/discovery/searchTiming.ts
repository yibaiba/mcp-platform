export type SearchPhase = 'authorization' | 'index' | 'embedding' | 'retrieval' | 'serialization';
export class SearchTiming {
  readonly milliseconds: Record<SearchPhase, number> = {
    authorization: 0,
    index: 0,
    embedding: 0,
    retrieval: 0,
    serialization: 0,
  };
  async measure<T>(phase: SearchPhase, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.milliseconds[phase] += performance.now() - started;
    }
  }
}
