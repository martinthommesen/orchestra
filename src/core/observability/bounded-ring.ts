import { Effect, Clock as EffectClock, Ref } from "effect";

export interface BoundedRing<Entry, Input> {
  readonly record: (input: Input) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<Entry>>;
}

/** A bounded, newest-last ring: clock-stamped, monotonic-seq, cap-evicting. Append never fails. */
export const makeBoundedRing = <Entry, Input>(
  cap: number,
  build: (input: Input, seq: number, ms: number) => Entry,
): Effect.Effect<BoundedRing<Entry, Input>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<{ seq: number; buffer: ReadonlyArray<Entry> }>({
      seq: 0,
      buffer: [],
    });
    return {
      record: (input) =>
        Effect.gen(function* () {
          const ms = yield* EffectClock.currentTimeMillis;
          yield* Ref.update(ref, (st) => {
            const seq = st.seq + 1;
            const next = [...st.buffer, build(input, seq, ms)];
            return { seq, buffer: next.length > cap ? next.slice(next.length - cap) : next };
          });
        }),
      list: Ref.get(ref).pipe(Effect.map((st) => st.buffer)),
    };
  });
