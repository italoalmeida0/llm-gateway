package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const openaiDefaultBaseURL = "https://api.openai.com"

// usesAdaptiveThinking reports whether a model only supports the adaptive
// thinking mode (kept from the removed Anthropic client: some gateways
// expose such models through the OpenAI-compatible wire and they accept
// the same reasoning_effort knob including the top "xhigh" tier).
func usesAdaptiveThinking(m Model) bool {
	id := strings.ToLower(m.ID)
	for _, marker := range []string{"opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8", "opus-5", "opus.5", "sonnet-5", "fable-5"} {
		if strings.Contains(id, marker) {
			return true
		}
	}
	return false
}

// versionSegmentSuffix matches a trailing API version segment such as
// "/v1" or Z.AI's "/v4".
var versionSegmentSuffix = regexp.MustCompile(`/v\d+$`)

// chatCompletionsURL builds the chat-completions endpoint for an
// OpenAI-compatible base URL. A base that already carries an API
// version segment gets "/chat/completions" appended directly; a bare
// host (e.g. api.openai.com) gets the conventional "/v1/chat/completions".
//
// Matching any "/vN" segment (not just "/v1") keeps Z.AI's coding-plan
// base, which ends in "/paas/v4", from getting a spurious "/v1" that
// yields ".../paas/v4/v1/chat/completions" and a 404.
func chatCompletionsURL(baseURL string) string {
	if versionSegmentSuffix.MatchString(baseURL) {
		return baseURL + "/chat/completions"
	}
	return baseURL + "/v1/chat/completions"
}

type openaiClient struct {
	apiKey              string
	baseURL             string
	chatCompletionsPath string
	name                string
	headers             map[string]string
	http                *http.Client
	modelOverride       *Model // gateway registry metadata, scoped to this client
}

// NewGatewayOpenAI uses the gateway's model configuration exclusively.
func NewGatewayOpenAI(apiKey, baseURL string, model Model) Client {
	c := NewOpenAI(apiKey, baseURL).(*openaiClient)
	c.modelOverride = &model
	return c
}

// NewOpenAI creates an OpenAI client using an API key. baseURL may be empty.
func NewOpenAI(apiKey, baseURL string) Client {
	if baseURL == "" {
		baseURL = openaiDefaultBaseURL
	}
	return &openaiClient{
		apiKey:  apiKey,
		baseURL: strings.TrimRight(baseURL, "/"),
		name:    "openai",
		http:    &http.Client{Timeout: 0},
	}
}

func (c *openaiClient) Name() string {
	if c.name != "" {
		return c.name
	}
	return "openai"
}

// ---- wire types ----

type oaiContentText struct {
	Type string `json:"type"` // "text"
	Text string `json:"text"`
}

type oaiContentImage struct {
	Type     string `json:"type"` // "image_url"
	ImageURL struct {
		URL string `json:"url"`
	} `json:"image_url"`
}

type oaiToolCallFn struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON string
}

type oaiToolCall struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"` // "function" or "openrouter:..."
	Function  oaiToolCallFn   `json:"function,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type oaiMessage struct {
	Role       string        `json:"role"`
	Content    interface{}   `json:"content,omitempty"` // string or []block
	Name       string        `json:"name,omitempty"`
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
	Tools      []oaiTool     `json:"tools,omitempty"`
	// ReasoningContent carries the model's chain-of-thought summary
	// alongside an assistant tool-call message. Required by Kimi's
	// chat completions endpoint when thinking is enabled and the
	// assistant message contains a tool call; OpenAI ignores it.
	ReasoningContent string `json:"reasoning_content,omitempty"`
}

type oaiTool struct {
	Type       string          `json:"type"` // "function" or "openrouter:..."
	Parameters json.RawMessage `json:"parameters,omitempty"`
	Function   *struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function,omitempty"`
}

type oaiStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type oaiRequest struct {
	Model            string            `json:"model"`
	Messages         []oaiMessage      `json:"messages"`
	Tools            []oaiTool         `json:"tools,omitempty"`
	ToolChoice       string            `json:"tool_choice,omitempty"`
	Stream           bool              `json:"stream"`
	StreamOptions    *oaiStreamOptions `json:"stream_options,omitempty"`
	Temperature      *float32          `json:"temperature,omitempty"`
	MaxTokens        *int              `json:"max_tokens,omitempty"`
	MaxCompletionTok *int              `json:"max_completion_tokens,omitempty"`
	ReasoningEffort  string            `json:"reasoning_effort,omitempty"`
	SessionID        string            `json:"session_id,omitempty"`
	MaxToolCalls     int               `json:"max_tool_calls,omitempty"`
}

// ---- request building ----

func (c *openaiClient) buildRequest(req Request) (*oaiRequest, error) {
	m := Model{
		ID:            req.Model,
		ContextWindow: 32768,
		MaxOutput:     8192,
	}
	if c.modelOverride != nil {
		m = *c.modelOverride
	}
	reasoning := ClampReasoningForModel(m, req.Reasoning)
	out := &oaiRequest{
		Model:         req.Model,
		Stream:        true,
		StreamOptions: &oaiStreamOptions{IncludeUsage: true},
		Temperature:   req.Temperature,
	}

	maxTok := req.MaxTokens
	if maxTok <= 0 {
		maxTok = m.MaxOutput
	}
	// Clamp max_tokens so output plus estimated input fits within the context window.
	// Some providers (OpenRouter) enforce input + max_output <= context_length and
	// reject requests where the total exceeds it. Reserving headroom based on actual
	// prompt size guarantees the request fits, even with large multi-turn contexts.
	if m.ContextWindow > 0 && maxTok > 0 {
		reserve := m.ContextWindow / 8
		const maxReserve = 4096
		if reserve > maxReserve {
			reserve = maxReserve
		}
		// Expand reserve when the actual prompt tokens exceed the static reserve,
		// guaranteeing that input + max_output fits within the context window.
		if inputEst := estimateRequestTokens(req); inputEst > reserve {
			reserve = inputEst + 256
		}
		clamped := m.ContextWindow - reserve
		if clamped < 1 {
			clamped = 1
		}
		if maxTok > clamped {
			maxTok = clamped
		}
	}
	if m.Reasoning {
		if maxTok > 0 {
			out.MaxCompletionTok = &maxTok
		}
		effort := OpenAIReasoningEffort(reasoning)
		if usesAdaptiveThinking(m) {
			// Some gateways expose adaptive-thinking Anthropic models through
			// the OpenAI-compatible chat-completions wire. They accept the
			// same reasoning_effort knob, including the top "xhigh" tier;
			// don't clamp "maximum" to "high" for those models.
			effort = OpenAICompatAnthropicEffort(reasoning)
		}
		if hasReasoningLevelOverride(m, req.Reasoning) {
			// Explicit model mappings describe the endpoint's actual effort
			// values and take precedence over conservative protocol defaults.
			effort = reasoning
		}
		if effort != "" {
			out.ReasoningEffort = effort
		}
	} else if maxTok > 0 {
		// Omit max_tokens when unknown (some discovered models don't
		// advertise an output cap) so the server applies its own default
		// instead of receiving an invalid max_tokens: 0.
		out.MaxTokens = &maxTok
	}

	if req.System != "" {
		out.Messages = append(out.Messages, oaiMessage{Role: "system", Content: req.System})
	}

	activatedTools := activatedToolNames(req.Messages)

	req.Messages = RepairOrphanedToolResults(req.Messages)
	for _, msg := range req.Messages {
		switch msg.Role {
		case RoleUser:
			content := buildOAIUserContent(msg.Content)
			out.Messages = append(out.Messages, oaiMessage{Role: "user", Content: content})
		case RoleAssistant:
			am := oaiMessage{Role: "assistant"}
			var text strings.Builder
			var reasoning strings.Builder
			for _, b := range msg.Content {
				switch v := b.(type) {
				case TextBlock:
					if strings.TrimSpace(v.Text) == "" {
						continue
					}
					if text.Len() > 0 {
						text.WriteString("\n")
					}
					text.WriteString(v.Text)
				case ToolCallBlock:
					if v.Server {
						continue
					}
					args := v.Arguments
					if len(args) == 0 || !json.Valid(args) {
						args = json.RawMessage("{}")
					}
					am.ToolCalls = append(am.ToolCalls, oaiToolCall{
						ID:   v.ID,
						Type: "function",
						Function: oaiToolCallFn{
							Name:      v.Name,
							Arguments: string(args),
						},
					})
				case ReasoningBlock:
					if v.Summary != "" {
						if reasoning.Len() > 0 {
							reasoning.WriteString("\n")
						}
						reasoning.WriteString(v.Summary)
					}
				}
			}
			if text.Len() > 0 {
				am.Content = text.String()
			}
			if reasoning.Len() > 0 && len(am.ToolCalls) > 0 {
				am.ReasoningContent = reasoning.String()
			}
			// Kimi rejects assistant messages with neither visible text nor
			// tool calls ("assistant must not be empty"). This can happen when
			// a previous stream produced only reasoning_content, which is kept
			// internally for provider replay but cannot send back as standalone
			// assistant content on OpenAI-compatible chat-completions APIs.
			if am.Content == nil && len(am.ToolCalls) == 0 {
				continue
			}
			out.Messages = append(out.Messages, am)
		case RoleTool:
			// Each ToolResultBlock becomes its own tool message. Preserve
			// image blocks for vision-capable OpenAI models instead of
			// flattening the tool output to plain text.
			for _, b := range msg.Content {
				if tr, ok := b.(ToolResultBlock); ok {
					content := buildOAIToolContent(tr.Content, tr.IsError)
					out.Messages = append(out.Messages, oaiMessage{
						Role:       "tool",
						ToolCallID: tr.CallID,
						Content:    content,
					})
				}
			}
		}
	}

	for _, t := range req.Tools {
		if t.Deferred && !activatedTools[t.Name] {
			continue
		}
		out.Tools = append(out.Tools, makeOAITool(t))
	}
	if len(out.Tools) > 0 {
		out.ToolChoice = "auto"
	}

	return out, nil
}

func makeOAITool(t Tool) oaiTool {
	var tool oaiTool
	tool.Type = "function"
	tool.Function = &struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	}{
		Name:        t.Name,
		Description: t.Description,
		Parameters:  t.Schema,
	}
	return tool
}

func buildOAIUserContent(blocks []Content) interface{} {
	hasImage := false
	for _, b := range blocks {
		if _, ok := b.(ImageBlock); ok {
			hasImage = true
			break
		}
	}
	if !hasImage {
		var sb strings.Builder
		for _, b := range blocks {
			if tb, ok := b.(TextBlock); ok {
				if sb.Len() > 0 {
					sb.WriteString("\n")
				}
				sb.WriteString(tb.Text)
			}
		}
		return sb.String()
	}
	return buildOAIContentBlocks(blocks, false)
}

func buildOAIToolContent(blocks []Content, isError bool) interface{} {
	hasImage := false
	for _, b := range blocks {
		if _, ok := b.(ImageBlock); ok {
			hasImage = true
			break
		}
	}
	if !hasImage {
		var sb strings.Builder
		for _, b := range blocks {
			if tb, ok := b.(TextBlock); ok {
				if sb.Len() > 0 {
					sb.WriteString("\n")
				}
				sb.WriteString(tb.Text)
			}
		}
		if isError && sb.Len() > 0 {
			sb.WriteString(" [error]")
		}
		return sb.String()
	}
	return buildOAIContentBlocks(blocks, isError)
}

func buildOAIContentBlocks(blocks []Content, isError bool) []interface{} {
	var arr []interface{}
	for _, b := range blocks {
		switch v := b.(type) {
		case TextBlock:
			arr = append(arr, oaiContentText{Type: "text", Text: v.Text})
		case ImageBlock:
			var img oaiContentImage
			img.Type = "image_url"
			img.ImageURL.URL = "data:" + v.MimeType + ";base64," + base64.StdEncoding.EncodeToString(v.Data)
			arr = append(arr, img)
		}
	}
	if isError {
		arr = append(arr, oaiContentText{Type: "text", Text: "[error]"})
	}
	return arr
}

// ---- streaming ----

func (c *openaiClient) chatCompletionsURL() string {
	if c.chatCompletionsPath != "" {
		return strings.TrimRight(c.baseURL, "/") + "/" + strings.TrimLeft(c.chatCompletionsPath, "/")
	}
	return chatCompletionsURL(c.baseURL)
}

func (c *openaiClient) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	endpoint := c.chatCompletionsURL()
	wire, err := c.buildRequest(req)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	newReq := func() (*http.Request, error) {
		httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("content-type", "application/json")
		httpReq.Header.Set("accept", "text/event-stream")
		httpReq.Header.Set("authorization", "Bearer "+c.apiKey)
		for k, v := range c.headers {
			httpReq.Header.Set(k, v)
		}
		return httpReq, nil
	}

	resp, err := doStreamWithRetry(ctx, c.http, newReq)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", c.Name(), err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("%s: http %d: %s", c.Name(), resp.StatusCode, strings.TrimSpace(string(b)))
	}

	out := make(chan Event, 16)
	go c.runStream(ctx, resp, req, out)
	return out, nil
}

func (c *openaiClient) runStream(ctx context.Context, resp *http.Response, req Request, out chan<- Event) {
	defer close(out)
	defer resp.Body.Close()

	var model Model
	if c.modelOverride != nil {
		model = *c.modelOverride
	} else {
		model = Model{ID: req.Model}
	}
	out <- EventStart{Model: req.Model, Provider: c.Name()}

	raw := make(chan sseEvent, 16)
	go readSSE(resp.Body, raw)

	// Interleaved block tracking: text and tool_calls preserve their
	// emission order so the assistant message renders in the same order
	// the model produced it. The builder fires one kind of block at a
	// time — incoming text deltas after a tool_call split into a fresh
	// text block; subsequent tool_calls each get their own slot.
	type blockEntry struct {
		kind      string // "text" | "tool_use"
		textBuf   strings.Builder
		toolID    string
		toolName  string
		toolArgs  strings.Builder
		announced bool
		server    bool
	}
	var (
		blocks       []*blockEntry
		currentText  *blockEntry             // most-recent text block, nil if none
		toolByIdx    = map[int]*blockEntry{} // openai tool_call index -> block
		reasoningBuf strings.Builder
		usage        Usage
		stop         StopReason = StopEnd
		finalErr     error
	)

	appendText := func(delta string) {
		if currentText == nil {
			currentText = &blockEntry{kind: "text"}
			blocks = append(blocks, currentText)
		}
		currentText.textBuf.WriteString(delta)
	}

	getOrCreateTool := func(idx int) *blockEntry {
		if t, ok := toolByIdx[idx]; ok {
			return t
		}
		t := &blockEntry{kind: "tool_use"}
		toolByIdx[idx] = t
		blocks = append(blocks, t)
		// A new tool block breaks the current text block. Subsequent text
		// deltas will start a fresh text block after this tool.
		currentText = nil
		return t
	}

	assembleMsg := func() Message {
		content := []Content{}
		for _, b := range blocks {
			switch b.kind {
			case "text":
				if b.textBuf.Len() > 0 {
					content = append(content, TextBlock{Text: b.textBuf.String()})
				}
			case "tool_use":
				args := b.toolArgs.String()
				if args == "" || !json.Valid([]byte(args)) {
					args = "{}"
				}
				content = append(content, ToolCallBlock{
					ID: b.toolID, Name: b.toolName, Arguments: json.RawMessage(args), Server: b.server,
				})
			}
		}
		if reasoningBuf.Len() > 0 {
			content = append(content, ReasoningBlock{Summary: reasoningBuf.String()})
		}
		return Message{Role: RoleAssistant, Content: content, Time: time.Now()}
	}

	sendDone := func() {
		StampCost(model, &usage)
		out <- EventUsage{Usage: usage}
		out <- EventDone{Stop: stop, Err: finalErr, Message: assembleMsg()}
	}

	for {
		select {
		case <-ctx.Done():
			stop = StopAborted
			finalErr = ctx.Err()
			sendDone()
			return
		case ev, ok := <-raw:
			if !ok {
				sendDone()
				return
			}
			if ev.Data == "[DONE]" {
				sendDone()
				return
			}
			var chunk struct {
				Choices []struct {
					Index int `json:"index"`
					Delta struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
						Reasoning        string `json:"reasoning"`
						ToolCalls        []struct {
							Index     int             `json:"index"`
							ID        string          `json:"id"`
							Type      string          `json:"type"`
							Name      string          `json:"name"`
							Arguments json.RawMessage `json:"arguments"`
							Function  struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
					FinishReason string `json:"finish_reason"`
				} `json:"choices"`
				Usage *struct {
					PromptTokens        int `json:"prompt_tokens"`
					CompletionTokens    int `json:"completion_tokens"`
					PromptTokensDetails struct {
						CachedTokens int `json:"cached_tokens"`
					} `json:"prompt_tokens_details"`
					CompletionTokensDetails *struct {
						ReasoningTokens int `json:"reasoning_tokens"`
					} `json:"completion_tokens_details"`
				} `json:"usage"`
				Error *struct {
					Message string `json:"message"`
					Type    string `json:"type"`
				} `json:"error"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &chunk); err != nil {
				continue
			}
			if chunk.Error != nil {
				stop = StopError
				finalErr = fmt.Errorf("openai: %s", chunk.Error.Message)
				sendDone()
				return
			}
			if chunk.Usage != nil {
				usage.InputTokens = chunk.Usage.PromptTokens - chunk.Usage.PromptTokensDetails.CachedTokens
				if usage.InputTokens < 0 {
					usage.InputTokens = chunk.Usage.PromptTokens
				}
				usage.OutputTokens = chunk.Usage.CompletionTokens
				usage.CacheReadTokens = chunk.Usage.PromptTokensDetails.CachedTokens
				if details := chunk.Usage.CompletionTokensDetails; details != nil {
					usage.ReasoningTokens = details.ReasoningTokens
					usage.ReasoningTokensKnown = true
				}
			}
			for _, ch := range chunk.Choices {
				reasoning := ch.Delta.ReasoningContent
				if reasoning == "" {
					reasoning = ch.Delta.Reasoning
				}
				if reasoning != "" {
					reasoningBuf.WriteString(reasoning)
					out <- EventReasoningDelta{Delta: reasoning}
				}
				if ch.Delta.Content != "" {
					appendText(ch.Delta.Content)
					out <- EventTextDelta{Delta: ch.Delta.Content}
				}
				for _, tc := range ch.Delta.ToolCalls {
					t := getOrCreateTool(tc.Index)
					if tc.ID != "" {
						t.toolID = tc.ID
					}
					if tc.Function.Name != "" {
						t.toolName = tc.Function.Name
					}
					if !t.announced && t.toolID != "" && t.toolName != "" {
						t.announced = true
						out <- EventToolStart{ID: t.toolID, Name: t.toolName}
					}
					if tc.Function.Arguments != "" {
						t.toolArgs.WriteString(tc.Function.Arguments)
						if t.announced {
							out <- EventToolArgs{ID: t.toolID, Delta: tc.Function.Arguments}
						}
					}
				}
				switch ch.FinishReason {
				case "stop":
					stop = StopEnd
				case "length":
					stop = StopLength
				case "tool_calls", "function_call":
					stop = StopToolUse
					hasClientTool := false
					for _, b := range blocks {
						if b.kind == "tool_use" && b.announced {
							out <- EventToolEnd{ID: b.toolID}
							if !b.server {
								hasClientTool = true
							}
						}
					}
					if !hasClientTool {
						// OpenRouter executed every tool server-side; the
						// client must not send tool_result messages.
						stop = StopEnd
					}
				}
			}
		}
	}
}

// estimateRequestTokens estimates the token size of a request before dispatch.
// 1 token ~ 4 characters, with an added 10% safety margin.
func estimateRequestTokens(req Request) int {
	totalChars := len(req.System)
	for _, m := range req.Messages {
		for _, c := range m.Content {
			switch v := c.(type) {
			case TextBlock:
				totalChars += len(v.Text)
			case ReasoningBlock:
				// Summaries and replayed encrypted blobs both ride the wire.
				totalChars += len(v.Summary) + len(v.Encrypted)
			case ToolCallBlock:
				totalChars += len(v.Name) + len(v.Arguments)
			case ToolResultBlock:
				for _, inner := range v.Content {
					if tb, ok := inner.(TextBlock); ok {
						totalChars += len(tb.Text)
					}
				}
			}
		}
	}
	for _, t := range req.Tools {
		totalChars += len(t.Name) + len(t.Description) + len(t.Schema)
	}
	if totalChars <= 0 {
		return 0
	}
	return (totalChars + 3) / 4
}

