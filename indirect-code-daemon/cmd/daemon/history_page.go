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
	OldestTurn int  // smallest TurnIndex in the block (cursor for beforeTurn)
	NewestTurn int  // largest TurnIndex in the block
	HasOlder   bool // more turns exist below OldestTurn
	TotalTurns int  // distinct turn count in the full transcript
	FirstIndex int  // raw transcript offset of Messages[0] (srcIdx base)
}

// turnTokenCount counts one turn's messages with btdby4 (same ruler as
// estimateContext). Messages that serialize to nothing count 0.
func turnTokenCount(msgs []provider.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	_, per := provider.ContextTokensByMessage("", nil, msgs)
	total := 0
	for _, n := range per {
		total += n
	}
	return total
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
