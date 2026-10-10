// Package core implements the agent loop, tool runtime, and session
// persistence. It is provider-agnostic: it talks to an LLM only through
// the provider.Client interface.
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Tool is a capability the agent can invoke.
type Tool interface {
	// Name is the unique tool id shown to the LLM.
	Name() string
	// Description is a one-line summary shown to the LLM.
	Description() string
	// Schema is a JSON Schema object for Execute's args.
	Schema() json.RawMessage
	// Execute runs the tool. progress may be called any number of times
	// with partial textual output (for UIs); it is not sent to the LLM.
	Execute(ctx context.Context, args json.RawMessage, progress func(string)) (ToolResult, error)
}

// ToolResult is the outcome of Tool.Execute.
type ToolResult struct {
	StartedAt  int64
	DurationMs int64
	// Content is sent back to the LLM (text and/or images). Text bodies are
	// PURE tool content (program output, file text, log lines): the agent
	// wraps them in the <tool_result> envelope (see envelope.go) together
	// with Attrs. System metadata never goes in the body.
	Content []provider.Content
	// IsError marks this result as a tool-MISUSE error (bad arguments,
	// permission denied, not found, aborted). A command's own non-zero
	// exit is NOT an error: report it via Attrs (exit="2") instead.
	IsError bool
	// Attrs are envelope attributes rendered on the <tool_result> open
	// tag: exit, status, page, next, truncated, job_id, info, ... Empty
	// values are skipped. Facts for the model to branch on; never prose.
	Attrs []Attr
	// ActivateTools names previously deferred tools that become available
	// after this result. Unknown names are ignored by the agent.
	ActivateTools []string
	// Details is arbitrary data for UIs and logs; not sent to the LLM.
	Details any
}

// Registry is a name->Tool map.
type Registry map[string]Tool

// NewRegistry builds a Registry from a list of tools.
func NewRegistry(tools ...Tool) Registry {
	r := Registry{}
	for _, t := range tools {
		r[t.Name()] = t
	}
	return r
}

// Specs returns the tool definitions to advertise to the LLM.
// Sorted by tool name so the order is stable across requests. This
// is load-bearing for provider-side prompt caching: providers
// prefix-match tool definitions, and Go's map iteration order is
// randomized per call, which would otherwise bust the cache every
// single turn.
func (r Registry) Specs() []provider.Tool {
	names := make([]string, 0, len(r))
	for name := range r {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]provider.Tool, 0, len(r))
	for _, name := range names {
		t := r[name]
		deferred := false
		if d, ok := t.(interface{ Deferred() bool }); ok {
			deferred = d.Deferred()
		}
		out = append(out, provider.Tool{
			Name:        t.Name(),
			Description: t.Description(),
			Schema:      t.Schema(),
			Deferred:    deferred,
		})
	}
	return out
}

// Get looks up a tool by name.
func (r Registry) Get(name string) (Tool, error) {
	t, ok := r[name]
	if !ok && name == "patch" {
		t, ok = r["edit"]
	}
	if !ok {
		return nil, fmt.Errorf("unknown tool %q%s", name, r.suggest(name))
	}
	return t, nil
}

// suggest renders a recovery hint for an unknown tool name: the closest
// registered name when one is clearly related, plus the full list so the
// model can pick the right tool on the next call instead of guessing.
func (r Registry) suggest(name string) string {
	names := make([]string, 0, len(r))
	for n := range r {
		names = append(names, n)
	}
	sort.Strings(names)
	if best := closestName(name, names); best != "" {
		return fmt.Sprintf(" — did you mean %q? Available tools: %s", best, strings.Join(names, ", "))
	}
	return ". Available tools: " + strings.Join(names, ", ")
}

// toolAliasHints maps tool names the model commonly reaches for that are not
// registered (shell-style verbs, pre-rename vocabulary) to the registered tool
// that serves the same job. Used only in the unknown-tool error hint.
var toolAliasHints = map[string]string{
	"grep":                          "search",
	"find":                          "glob",
	"cat":                           "read",
	"ls":                            "inspect",
	"sleep":                         "bg_await",
	"web_search":                    "search_web",
	"fetchurl":                      "fetch_url",
	"mark_task_as_complete":         "finish_entire_request",
	"mark_task_complete":            "finish_entire_request",
	"mark_plan_as_ready_to_execute": "finish_entire_request",
}

// closestName returns the registered name closest to name: a known alias
// first, then a small edit distance. "" when nothing is similar enough to be
// a useful hint.
func closestName(name string, names []string) string {
	if alias, ok := toolAliasHints[name]; ok {
		for _, n := range names {
			if n == alias {
				return alias
			}
		}
	}
	best, bestDist := "", 0
	limit := 3
	if len(name) <= 4 {
		limit = 2
	}
	for _, n := range names {
		d := editDistance(name, n)
		if d <= limit && (best == "" || d < bestDist) {
			best, bestDist = n, d
		}
	}
	return best
}

// editDistance is the Levenshtein distance between a and b.
func editDistance(a, b string) int {
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	cur := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = min3(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
