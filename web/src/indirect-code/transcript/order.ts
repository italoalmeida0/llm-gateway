export interface TranscriptCursor { stream: string; seq: number }

/** A bounded replay window joins point-in-time snapshots with later events.
 * Missing events require an authoritative snapshot, never guessed text merges. */
export function createTranscriptOrder(resync: () => void, capacity = 512) {
  let stream = "";
  let seq = 0;
  let waiting = false;
  const retired = new Set<string>();
  let events: { seq: number; apply: () => void }[] = [];
  const valid = (cursor: TranscriptCursor) =>
    typeof cursor.stream === "string" && !!cursor.stream &&
    Number.isSafeInteger(cursor.seq) && cursor.seq >= 0;

  function change(next: string) {
    if (stream) retired.add(stream);
    stream = next;
    seq = 0;
    events = [];
    waiting = false;
  }
  function request() {
    if (waiting) return;
    waiting = true;
    resync();
  }

  return {
    event(cursor: TranscriptCursor | undefined, apply: () => void) {
      if (!cursor) { if (!stream) apply(); return; }
      if (!valid(cursor) || retired.has(cursor.stream)) return;
      if (cursor.stream !== stream) change(cursor.stream);
      if (cursor.seq <= seq || events.some(event => event.seq === cursor.seq)) return;
      events.push({ seq: cursor.seq, apply });
      if (events.length > capacity) events.shift();
      if (waiting || cursor.seq !== seq + 1) { request(); return; }
      seq = cursor.seq;
      apply();
    },
    snapshot(cursor: TranscriptCursor | undefined): (() => void)[] | null {
      if (!cursor) return stream ? null : [];
      if (!valid(cursor) || retired.has(cursor.stream)) return null;
      if (cursor.stream !== stream) change(cursor.stream);
      const after = events.filter(event => event.seq > cursor.seq).sort((a, b) => a.seq - b.seq);
      let end = cursor.seq;
      for (const event of after) {
        if (event.seq !== end + 1) { waiting = false; request(); return null; }
        end = event.seq;
      }
      if (end < seq) { waiting = false; request(); return null; }
      seq = end;
      waiting = false;
      events = after;
      return after.map(event => event.apply);
    },
    reset() {
      stream = "";
      seq = 0;
      waiting = false;
      events = [];
      retired.clear();
    },
  };
}
