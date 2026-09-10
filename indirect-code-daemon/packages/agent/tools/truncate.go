package tools

import (
	"fmt"
	"strconv"
	"strings"
)

// Port of pi's truncate.ts (badlogic pi-mono, packages/coding-agent/src/core/tools).
// The AI-visible output of read/write/edit/bash mirrors pi exactly, so the
// truncation math and notice formats must match byte-for-byte.

const (
	defaultMaxLines = 2000
	defaultMaxBytes = 50 * 1024 // 50KB
)

// truncationResult mirrors pi's TruncationResult.
type truncationResult struct {
	content          string
	truncated        bool
	truncatedBy      string // "lines", "bytes", or "" (null in pi)
	totalLines       int
	totalBytes       int
	outputLines      int
	outputBytes      int
	lastLinePartial  bool
	firstLineExceeds bool
	maxLines         int
	maxBytes         int
}

// formatSize mirrors pi's formatSize: "123B", "50.0KB", "1.5MB".
func formatSize(bytes int) string {
	if bytes < 1024 {
		return fmt.Sprintf("%dB", bytes)
	} else if bytes < 1024*1024 {
		return strconv.FormatFloat(float64(bytes)/1024, 'f', 1, 64) + "KB"
	}
	return strconv.FormatFloat(float64(bytes)/(1024*1024), 'f', 1, 64) + "MB"
}

// splitLinesForCounting mirrors pi's splitLinesForCounting: split on "\n",
// dropping the phantom empty line produced by a trailing newline.
func splitLinesForCounting(content string) []string {
	if len(content) == 0 {
		return nil
	}
	lines := strings.Split(content, "\n")
	if strings.HasSuffix(content, "\n") {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// truncateHead truncates content from the head (keep first N lines/bytes).
// Suitable for file reads. Never returns partial lines; if the first line
// alone exceeds the byte limit, returns empty content with firstLineExceeds.
func truncateHead(content string, maxLines, maxBytes int) truncationResult {
	totalBytes := len(content)
	lines := splitLinesForCounting(content)
	totalLines := len(lines)

	if totalLines <= maxLines && totalBytes <= maxBytes {
		return truncationResult{
			content: content, truncated: false, truncatedBy: "",
			totalLines: totalLines, totalBytes: totalBytes,
			outputLines: totalLines, outputBytes: totalBytes,
			maxLines: maxLines, maxBytes: maxBytes,
		}
	}

	firstLineBytes := len(lines[0])
	if firstLineBytes > maxBytes {
		return truncationResult{
			content: "", truncated: true, truncatedBy: "bytes",
			totalLines: totalLines, totalBytes: totalBytes,
			outputLines: 0, outputBytes: 0,
			firstLineExceeds: true,
			maxLines:         maxLines, maxBytes: maxBytes,
		}
	}

	var outputLinesArr []string
	outputBytesCount := 0
	truncatedBy := "lines"

	for i := 0; i < len(lines) && i < maxLines; i++ {
		line := lines[i]
		lineBytes := len(line)
		if i > 0 {
			lineBytes++ // +1 for newline
		}
		if outputBytesCount+lineBytes > maxBytes {
			truncatedBy = "bytes"
			break
		}
		outputLinesArr = append(outputLinesArr, line)
		outputBytesCount += lineBytes
	}

	if len(outputLinesArr) >= maxLines && outputBytesCount <= maxBytes {
		truncatedBy = "lines"
	}

	outputContent := strings.Join(outputLinesArr, "\n")
	return truncationResult{
		content: outputContent, truncated: true, truncatedBy: truncatedBy,
		totalLines: totalLines, totalBytes: totalBytes,
		outputLines: len(outputLinesArr), outputBytes: len(outputContent),
		maxLines: maxLines, maxBytes: maxBytes,
	}
}

// truncateTail truncates content from the tail (keep last N lines/bytes).
// Suitable for bash output where the end matters. May return a partial
// first line when a single line exceeds the byte limit.
func truncateTail(content string, maxLines, maxBytes int) truncationResult {
	totalBytes := len(content)
	lines := splitLinesForCounting(content)
	totalLines := len(lines)

	if totalLines <= maxLines && totalBytes <= maxBytes {
		return truncationResult{
			content: content, truncated: false, truncatedBy: "",
			totalLines: totalLines, totalBytes: totalBytes,
			outputLines: totalLines, outputBytes: totalBytes,
			maxLines: maxLines, maxBytes: maxBytes,
		}
	}

	var outputLinesArr []string
	outputBytesCount := 0
	truncatedBy := "lines"
	lastLinePartial := false

	for i := len(lines) - 1; i >= 0 && len(outputLinesArr) < maxLines; i-- {
		line := lines[i]
		lineBytes := len(line)
		if len(outputLinesArr) > 0 {
			lineBytes++ // +1 for newline
		}
		if outputBytesCount+lineBytes > maxBytes {
			truncatedBy = "bytes"
			// Edge case: no lines added yet and this line alone exceeds
			// maxBytes — take the end of the line (partial).
			if len(outputLinesArr) == 0 {
				truncatedLine := truncateStringToBytesFromEnd(line, maxBytes)
				outputLinesArr = append([]string{truncatedLine}, outputLinesArr...)
				outputBytesCount = len(truncatedLine)
				lastLinePartial = true
			}
			break
		}
		outputLinesArr = append([]string{line}, outputLinesArr...)
		outputBytesCount += lineBytes
	}

	if len(outputLinesArr) >= maxLines && outputBytesCount <= maxBytes {
		truncatedBy = "lines"
	}

	outputContent := strings.Join(outputLinesArr, "\n")
	return truncationResult{
		content: outputContent, truncated: true, truncatedBy: truncatedBy,
		totalLines: totalLines, totalBytes: totalBytes,
		outputLines: len(outputLinesArr), outputBytes: len(outputContent),
		lastLinePartial: lastLinePartial,
		maxLines:        maxLines, maxBytes: maxBytes,
	}
}

// truncateStringToBytesFromEnd keeps the last maxBytes bytes of str,
// snapping to a valid UTF-8 character boundary.
func truncateStringToBytesFromEnd(str string, maxBytes int) string {
	if len(str) <= maxBytes {
		return str
	}
	start := len(str) - maxBytes
	// Advance to the start of a multi-byte character.
	for start < len(str) && str[start]&0xC0 == 0x80 {
		start++
	}
	return str[start:]
}

// truncateStringToBytesFromStart keeps the first maxBytes bytes of str,
// snapping to a valid UTF-8 character boundary (never splits a rune).
func truncateStringToBytesFromStart(str string, maxBytes int) string {
	if len(str) <= maxBytes {
		return str
	}
	end := maxBytes
	// Back off to the start of a multi-byte character.
	for end > 0 && str[end]&0xC0 == 0x80 {
		end--
	}
	return str[:end]
}
