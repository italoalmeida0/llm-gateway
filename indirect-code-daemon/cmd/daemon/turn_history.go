package main

import (
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Turn-granular history pagination: the transcript is append-only and
// every message carries a TurnIndex, so blocks of whole turns are the
// natural page unit (never cut a turn in half). The daemon walks
// backwards from the tail, counting tokens per turn with btdby4, and
// stops as soon as the block reaches the token budget — counting only
// what it sends, never the whole session.
//
// Budget: historyBlockTokens (round-up: the turn crossing the line is
// always included whole, minimum one turn). Safety cap: a single
// monster turn is split by message count (historyBlockMaxMessages)
// instead of blowing the transport budget.

const (
	historyBlockTokens      = 128 * 1024
	historyBlockMaxMessages = 200
)

// historyBlock is one page of transcript: whole turns, newest last.
type historyBlock struct {
	Messages   []provider.Message
	Balloons   []filetrack.TurnChanges
	Attachments []AttachmentRef
	OldestTurn int  // smallest TurnIndex in the block (cursor for beforeTurn)
	NewestTurn int  // largest TurnIndex in the block
	HasOlder   bool // more turns exist below OldestTurn
	TotalTurns int  // distinct turn count in the full transcript
	FirstIndex int  // raw transcript offset of Messages[0] (srcIdx base)
}


// sliceHistoryBlock returns the tail block (beforeTurn <= 0) or the block
// of turns strictly below beforeTurn. Turns are grouped by TurnIndex in
// transcript order; messages with TurnIndex 0 (pre-turn system notices)
// attach to the following turn. Balloons whose TurnIndex falls inside the
// block ride along.
func sliceHistoryBlock(msgs []provider.Message, balloons []filetrack.TurnChanges, beforeTurn int) historyBlock {
	var out historyBlock
	if len(msgs) == 0 {
		return out
	}
	// Distinct turns, ascending, and per-turn message ranges.
	type turnRange struct {
		turn       int
		start, end int // [start, end) into msgs
	}
	var ranges []turnRange
	seen := map[int]bool{}
	for i, m := range msgs {
		ti := m.TurnIndex
		if beforeTurn > 0 && ti >= beforeTurn {
			continue
		}
		if len(ranges) == 0 || ranges[len(ranges)-1].turn != ti {
			// TurnIndex 0 prefix attaches to the first real turn below.
			if ti == 0 && len(ranges) > 0 {
				ranges[len(ranges)-1].end = i + 1
				continue
			}
			ranges = append(ranges, turnRange{turn: ti, start: i, end: i + 1})
		} else {
			ranges[len(ranges)-1].end = i + 1
		}
		if ti != 0 {
			seen[ti] = true
		}
	}
	out.TotalTurns = len(seen)
	if len(ranges) == 0 {
		return out
	}
	// Walk backwards accumulating whole turns until the budget is met.
	// Blocks are always whole turns (never cut a turn in half): the turn
	// crossing the budget line is included entirely (round-up), minimum
	// one turn. Safety cap: stop adding older turns once the page exceeds
	// historyBlockMaxMessages — a single monster turn still ships whole
	// (it is the freshest data), but it never drags older turns along.
	budget := 0
	first := len(ranges) // index into ranges of the block's oldest turn
	for i := len(ranges) - 1; i >= 0; i-- {
		r := ranges[i]
		turnMsgs := msgs[r.start:r.end]
		if i < len(ranges)-1 && len(msgs[ranges[i+1].start:ranges[len(ranges)-1].end]) >= historyBlockMaxMessages {
			break
		}
		budget += turnTokenCount(turnMsgs)
		first = i
		if budget >= historyBlockTokens {
			break
		}
	}
	block := ranges[first:]
	start, end := block[0].start, block[len(block)-1].end
	out.FirstIndex = start
	out.Messages = append([]provider.Message{}, msgs[start:end]...)
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = first > 0
	for _, b := range balloons {
		if b.TurnIndex >= out.OldestTurn && (out.NewestTurn <= 0 || b.TurnIndex <= out.NewestTurn) {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

// Completion tail: the last N whole turns (never cut a turn in half),
// minimum one turn, plus the cursor for get_history. The foreground
// client already received every turn message as deltas, so the
// end-of-turn snapshot only needs the fresh turns for reconciliation
// (a lost delta, a second device) — never the full transcript. Bounded
// by turn count, not tokens: the freshest data always ships whole and
// the payload stops growing with session age.
const completionTailTurns = 2

// sliceLastTurns returns the block of the last n whole turns in
// transcript order, newest last. TurnIndex 0 prefix messages (pre-turn
// system notices) ride with the first block turn, mirroring
// sliceHistoryBlock.
func sliceLastTurns(msgs []provider.Message, balloons []filetrack.TurnChanges, n int) historyBlock {
	var out historyBlock
	if len(msgs) == 0 || n <= 0 {
		return out
	}
	type turnRange struct {
		turn       int
		start, end int
	}
	var ranges []turnRange
	seen := map[int]bool{}
	for i, m := range msgs {
		ti := m.TurnIndex
		if len(ranges) == 0 || ranges[len(ranges)-1].turn != ti {
			if ti == 0 && len(ranges) > 0 {
				ranges[len(ranges)-1].end = i + 1
				continue
			}
			ranges = append(ranges, turnRange{turn: ti, start: i, end: i + 1})
		} else {
			ranges[len(ranges)-1].end = i + 1
		}
		if ti != 0 {
			seen[ti] = true
		}
	}
	out.TotalTurns = len(seen)
	if len(ranges) == 0 {
		return out
	}
	first := len(ranges) - n
	if first < 0 {
		first = 0
	}
	block := ranges[first:]
	start, end := block[0].start, block[len(block)-1].end
	out.FirstIndex = start
	out.Messages = append([]provider.Message{}, msgs[start:end]...)
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = first > 0
	for _, b := range balloons {
		if b.TurnIndex >= out.OldestTurn && (out.NewestTurn <= 0 || b.TurnIndex <= out.NewestTurn) {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

// historyCursorMap is the get_history cursor shape shared by every
// transcript-carrying event (session_data/session_content/
// session_compacted): the client merges by id, seals the block, and
// pages backwards from oldestTurn when the user scrolls up.
func historyCursorMap(block historyBlock) map[string]any {
	return map[string]any{
		"oldestTurn": block.OldestTurn,
		"newestTurn": block.NewestTurn,
		"hasOlder":   block.HasOlder,
		"totalTurns": block.TotalTurns,
		"firstIndex": block.FirstIndex,
	}
}

// completionPayload is the end-of-turn session_data shape: the full
// closing metadata (usage, compaction, context, todos, model/options,
// queue, attachments, file balloons of the tail) plus ONLY the last
// completionTailTurns whole turns + cursor. The foreground client
// reconciles the fresh turns by id; older turns are untouched.
// Call with the record lock held.
func completionPayload(rec *SessionRecord) map[string]any {
	p := sessionPayload(rec)
	block := sliceLastTurns(rec.Messages, rec.FileBalloons, completionTailTurns)
	p["messages"] = sanitizeMessagesForFrontend(block.Messages, rec.Attachments)
	p["fileBalloons"] = fileBalloonPayloads(block.Balloons)
	p["history"] = historyCursorMap(block)
	return p
}

// tailContentEvent is the session_content/session_compacted shape for
// out-of-turn sync points (edit, slash reply, truncate tail, quiet
// context notice, compaction): the affected tail turns + the same
// history cursor, so the client merges instead of replacing the list.
// n<=0 means the completion default (completionTailTurns).
func tailContentEvent(hostID, sessionID string, typ string, rec *SessionRecord, n int, extra map[string]any) map[string]any {
	if n <= 0 {
		n = completionTailTurns
	}
	block := sliceLastTurns(rec.Messages, rec.FileBalloons, n)
	ev := map[string]any{
		"type":       typ,
		"hostId":     hostID,
		"sessionId":  sessionID,
		"messages":   sanitizeMessagesForFrontend(block.Messages, rec.Attachments),
		"compaction": rec.Compaction,
		"history":    historyCursorMap(block),
	}
	for k, v := range extra {
		ev[k] = v
	}
	return ev
}
