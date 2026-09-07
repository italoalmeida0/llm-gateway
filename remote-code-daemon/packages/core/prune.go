package core

import (
	"github.com/patriceckhart/zot/packages/provider"
)

const (
	// PruneProtectTokens is the budget of recent tool output tokens kept verbatim.
	PruneProtectTokens = 40000
	// ToolOutputMaxChars is the maximum character length for older individual tool outputs.
	ToolOutputMaxChars = 2000
	// PrunedToolNotice replaces the body of pruned tool results.
	PrunedToolNotice = "[Old tool result content cleared]"
)

// PruneOldToolResults returns a copy of messages with older tool outputs
// cleared or truncated, matching OpenCode's two-tier context protection.
// The most recent 2 user turns and up to PruneProtectTokens of recent tool
// outputs are kept intact; older outputs are pruned to save context space.
func PruneOldToolResults(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}

	result := make([]provider.Message, len(msgs))
	copy(result, msgs)

	// Step 1: Count user turns backwards to identify the boundary of recent turns.
	userTurns := 0
	recentTurnBoundary := 0
	for i := len(result) - 1; i >= 0; i-- {
		if result[i].Role == provider.RoleUser {
			userTurns++
			if userTurns >= 2 {
				recentTurnBoundary = i
				break
			}
		}
	}

	// Step 2: Track token budget for tool outputs backwards.
	// 1 token ~ 4 chars.
	var recentToolTokens int

	for i := len(result) - 1; i >= 0; i-- {
		m := result[i]
		if m.Role != provider.RoleTool {
			continue
		}

		isRecentTurn := i >= recentTurnBoundary
		var newContent []provider.Content
		modified := false

		for _, c := range m.Content {
			trb, ok := c.(provider.ToolResultBlock)
			if !ok {
				newContent = append(newContent, c)
				continue
			}

			// Calculate size of this tool result
			var totalChars int
			for _, inner := range trb.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					totalChars += len(tb.Text)
				}
			}
			estimatedTokens := totalChars / 4

			if isRecentTurn && recentToolTokens+estimatedTokens <= PruneProtectTokens {
				recentToolTokens += estimatedTokens
				newContent = append(newContent, trb)
				continue
			}

			// Older tool result beyond protection budget: prune or truncate
			var prunedInner []provider.Content
			for _, inner := range trb.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					if len(tb.Text) > ToolOutputMaxChars {
						if isRecentTurn {
							// In recent turn but over budget: truncate
							prunedInner = append(prunedInner, provider.TextBlock{
								Text:             tb.Text[:ToolOutputMaxChars] + "\n[truncated]",
								ThoughtSignature: tb.ThoughtSignature,
							})
						} else {
							// Older turn: clear completely
							prunedInner = append(prunedInner, provider.TextBlock{
								Text:             PrunedToolNotice,
								ThoughtSignature: tb.ThoughtSignature,
							})
						}
						modified = true
					} else if !isRecentTurn && recentToolTokens >= PruneProtectTokens {
						prunedInner = append(prunedInner, provider.TextBlock{
							Text:             PrunedToolNotice,
							ThoughtSignature: tb.ThoughtSignature,
						})
						modified = true
					} else {
						prunedInner = append(prunedInner, tb)
					}
				} else {
					prunedInner = append(prunedInner, inner)
				}
			}
			trb.Content = prunedInner
			newContent = append(newContent, trb)
		}

		if modified {
			m.Content = newContent
			result[i] = m
		}
	}

	return result
}
