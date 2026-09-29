package core

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

var (
	// ErrRepetitionLoop is returned when the model enters an infinite repetitive loop in text or thinking.
	ErrRepetitionLoop = errors.New("repetition loop detected in model output")
)

const (
	maxRollingWindow = 4096
	minUnitLength    = 15
	maxUnitLength    = 1024
	shortUnitMax     = 60
	shortMinRepeats  = 4
	shortMinChars    = 120
	longMinRepeats   = 3
	longMinChars     = 180
	strideCheckChars = 64
	minLineRepeatLen = 20
	minLineRepeats   = 4
)

// LoopGuard tracks streamed content in a rolling window and detects repetition loops.
type LoopGuard struct {
	textTail      string
	reasoningTail string
	textSinceScan int
	reasSinceScan int
	active        bool
}

// NewLoopGuard creates a new LoopGuard.
func NewLoopGuard() *LoopGuard {
	return &LoopGuard{
		active: true,
	}
}

// FeedText feeds text delta and returns true if a repetition loop is detected.
func (g *LoopGuard) FeedText(delta string) (bool, string) {
	if !g.active || delta == "" {
		return false, ""
	}
	g.textTail += delta
	if len(g.textTail) > maxRollingWindow {
		g.textTail = g.textTail[len(g.textTail)-maxRollingWindow:]
	}
	g.textSinceScan += len(delta)
	if g.textSinceScan >= strideCheckChars || strings.Contains(delta, "\n") {
		g.textSinceScan = 0
		if detected, detail := detectLoopInTail(g.textTail); detected {
			return true, "text: " + detail
		}
	}
	return false, ""
}

// FeedReasoning feeds reasoning delta and returns true if a repetition loop is detected.
func (g *LoopGuard) FeedReasoning(delta string) (bool, string) {
	if !g.active || delta == "" {
		return false, ""
	}
	g.reasoningTail += delta
	if len(g.reasoningTail) > maxRollingWindow {
		g.reasoningTail = g.reasoningTail[len(g.reasoningTail)-maxRollingWindow:]
	}
	g.reasSinceScan += len(delta)
	if g.reasSinceScan >= strideCheckChars || strings.Contains(delta, "\n") {
		g.reasSinceScan = 0
		if detected, detail := detectLoopInTail(g.reasoningTail); detected {
			return true, "reasoning: " + detail
		}
	}
	return false, ""
}

func detectLoopInTail(tail string) (bool, string) {
	// 1. Line repetition check (e.g. repeated identical log line or instruction)
	lines := strings.Split(tail, "\n")
	if len(lines) >= minLineRepeats {
		lastLine := strings.TrimSpace(lines[len(lines)-1])
		if lastLine == "" && len(lines) >= minLineRepeats+1 {
			lastLine = strings.TrimSpace(lines[len(lines)-2])
		}
		if len(lastLine) >= minLineRepeatLen && hasLetters(lastLine) && !isTrivialFill(lastLine) {
			repeats := 0
			for i := len(lines) - 1; i >= 0; i-- {
				cur := strings.TrimSpace(lines[i])
				if cur == "" {
					continue
				}
				if cur == lastLine {
					repeats++
					if repeats >= minLineRepeats {
						return true, "repeated line (" + truncateSample(lastLine, 40) + ")"
					}
				} else {
					break
				}
			}
		}
	}

	// 2. Exact suffix cycle check
	n := len(tail)
	if n < minUnitLength*longMinRepeats {
		return false, ""
	}

	for l := minUnitLength; l <= maxUnitLength && l*longMinRepeats <= n; l++ {
		unit := tail[n-l : n]
		if isTrivialFill(unit) || !hasLetters(unit) {
			continue
		}

		repeats := 1
		requiredRepeats := longMinRepeats
		minTotalChars := longMinChars
		if l <= shortUnitMax {
			requiredRepeats = shortMinRepeats
			minTotalChars = shortMinChars
		}

		pos := n - l
		for pos-l >= 0 && tail[pos-l:pos] == unit {
			repeats++
			pos -= l
			if repeats >= requiredRepeats && (repeats*l) >= minTotalChars {
				return true, fmt.Sprintf("exact cycle of length %d (%s)", l, truncateSample(unit, 40))
			}
		}
	}

	return false, ""
}

func isTrivialFill(s string) bool {
	seen := make(map[rune]bool)
	hasLetter := false
	for _, r := range s {
		seen[r] = true
		if unicode.IsLetter(r) {
			hasLetter = true
		}
	}
	if len(seen) <= 3 || !hasLetter {
		return true
	}
	trimmed := strings.TrimFunc(s, func(r rune) bool {
		return unicode.IsPunct(r) || unicode.IsSpace(r) || unicode.IsDigit(r) || r == '|' || r == '-' || r == '='
	})
	return len(trimmed) == 0
}

func hasLetters(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

func truncateSample(s string, maxLen int) string {
	s = strings.ReplaceAll(s, "\n", "\\n")
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
