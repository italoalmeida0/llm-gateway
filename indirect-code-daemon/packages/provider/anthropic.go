package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// anthropicDefaultBaseURL is only a fallback; the daemon always points this
// client at the gateway's forced Anthropic surface (…/anthropic/v1).
const anthropicDefaultBaseURL = "https://api.anthropic.com"

const anthropicVersion = "2023-06-01"

type anthropicClient struct {
	apiKey        string
	baseURL       string
	http          *http.Client
	modelOverride *Model // gateway registry metadata, scoped to this client
}

// NewGatewayAnthropic creates a client speaking the Anthropic Messages API
// against the gateway. baseURL must be the gateway's forced Anthropic
// surface (…/anthropic/v1). There is no OpenAI fallback: providers without a
// native Anthropic endpoint are served by the gateway's Anthropic→OpenAI
// translation.
func NewGatewayAnthropic(apiKey, baseURL string, model Model) Client {
	c := NewAnthropic(apiKey, baseURL).(*anthropicClient)
	c.modelOverride = &model
	return c
}

// NewAnthropic creates an Anthropic client. baseURL may be empty.
func NewAnthropic(apiKey, baseURL string) Client {
	if baseURL == "" {
		baseURL = anthropicDefaultBaseURL
	}
	return &anthropicClient{
		apiKey:  apiKey,
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 0},
	}
}

func (c *anthropicClient) Name() string { return "anthropic" }

// ---- wire types ----

type anthCacheControl struct {
	Type string `json:"type"` // "ephemeral"
}

type anthSystemBlock struct {
	Type         string            `json:"type"` // "text"
	Text         string            `json:"text"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthTextBlock struct {
	Type         string            `json:"type"` // "text"
	Text         string            `json:"text"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthImageBlock struct {
	Type   string `json:"type"` // "image"
	Source struct {
		Type      string `json:"type"` // "base64"
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthToolUseBlock struct {
	Type  string          `json:"type"` // "tool_use"
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// anthRedactedThinkingBlock is replayed verbatim: the encrypted payload the
// provider emitted must come back unchanged on the next turn, in position.
type anthRedactedThinkingBlock struct {
	Type string `json:"type"` // "redacted_thinking"
	Data string `json:"data"`
}

type anthToolResultBlock struct {
	Type         string            `json:"type"` // "tool_result"
	ToolUseID    string            `json:"tool_use_id"`
	Content      interface{}       `json:"content,omitempty"` // string or []block
	IsError      bool              `json:"is_error,omitempty"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthMessage struct {
	Role    string      `json:"role"` // "user" | "assistant"
	Content interface{} `json:"content"`
}

type anthTool struct {
	Name         string            `json:"name"`
	Description  string            `json:"description,omitempty"`
	InputSchema  json.RawMessage   `json:"input_schema"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthRequest struct {
	Model       string        `json:"model"`
	System      interface{}   `json:"system,omitempty"` // []anthSystemBlock
	Messages    []anthMessage `json:"messages"`
	Tools       []anthTool    `json:"tools,omitempty"`
	MaxTokens   int           `json:"max_tokens"`
	Temperature *float32      `json:"temperature,omitempty"`
	Stream      bool          `json:"stream"`
}

// ---- request building ----

func (c *anthropicClient) buildRequest(req Request) (*anthRequest, error) {
	m := Model{
		ID:            req.Model,
		ContextWindow: 32768,
		MaxOutput:     8192,
	}
	if c.modelOverride != nil {
		m = *c.modelOverride
	}

	maxTok := req.MaxTokens
	if maxTok <= 0 {
		maxTok = m.MaxOutput
	}
	if m.ContextWindow > 0 && maxTok > 0 {
		reserve := m.ContextWindow / 8
		const maxReserve = 4096
		if reserve > maxReserve {
			reserve = maxReserve
		}
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
	// Anthropic requires max_tokens; never send zero.
	if maxTok <= 0 {
		maxTok = 4096
	}

	out := &anthRequest{
		Model:       req.Model,
		MaxTokens:   maxTok,
		Temperature: req.Temperature,
		Stream:      true,
	}
	if req.System != "" {
		out.System = []anthSystemBlock{
			{
				Type:         "text",
				Text:         req.System,
				CacheControl: &anthCacheControl{Type: "ephemeral"},
			},
		}
	}

	req.Messages = RepairOrphanedToolResults(req.Messages)
	for _, msg := range req.Messages {
		switch msg.Role {
		case RoleUser:
			blocks := buildAnthUserContent(msg.Content)
			if len(blocks) == 0 {
				continue
			}
			out.Messages = append(out.Messages, anthMessage{Role: "user", Content: blocks})
		case RoleAssistant:
			var blocks []interface{}
			var text strings.Builder
			flushText := func() {
				if text.Len() > 0 {
					blocks = append(blocks, anthTextBlock{Type: "text", Text: text.String()})
					text.Reset()
				}
			}
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
					flushText()
					args := v.Arguments
					if len(args) == 0 || !json.Valid(args) {
						args = json.RawMessage("{}")
					}
					blocks = append(blocks, anthToolUseBlock{
						Type: "tool_use", ID: v.ID, Name: v.Name, Input: args,
					})
				case ReasoningBlock:
					// A redacted thinking blob replays verbatim, in position;
					// a bare human-readable summary has no signature and is
					// transcript-only, never sent.
					if v.Encrypted != "" {
						flushText()
						blocks = append(blocks, anthRedactedThinkingBlock{
							Type: "redacted_thinking", Data: v.Encrypted,
						})
					}
				}
			}
			flushText()
			if len(blocks) == 0 {
				continue
			}
			out.Messages = append(out.Messages, anthMessage{Role: "assistant", Content: blocks})
		case RoleTool:
			// All results of one message share a single user turn, as the
			// Anthropic format requires.
			var blocks []interface{}
			for _, b := range msg.Content {
				if tr, ok := b.(ToolResultBlock); ok {
					blocks = append(blocks, anthToolResultBlock{
						Type:      "tool_result",
						ToolUseID: tr.CallID,
						Content:   buildAnthToolResultContent(tr.Content),
						IsError:   tr.IsError,
					})
				}
			}
			if len(blocks) == 0 {
				continue
			}
			out.Messages = append(out.Messages, anthMessage{Role: "user", Content: blocks})
		}
	}

	// Cache the conversation history by setting cache_control on the last block
	// of the last user turn (including tool results, which are user turns in Anthropic).
	for i := len(out.Messages) - 1; i >= 0; i-- {
		if out.Messages[i].Role == "user" {
			if blocks, ok := out.Messages[i].Content.([]interface{}); ok && len(blocks) > 0 {
				lastIdx := len(blocks) - 1
				switch b := blocks[lastIdx].(type) {
				case anthTextBlock:
					b.CacheControl = &anthCacheControl{Type: "ephemeral"}
					blocks[lastIdx] = b
				case anthImageBlock:
					b.CacheControl = &anthCacheControl{Type: "ephemeral"}
					blocks[lastIdx] = b
				case anthToolResultBlock:
					b.CacheControl = &anthCacheControl{Type: "ephemeral"}
					blocks[lastIdx] = b
				}
				out.Messages[i].Content = blocks
			}
			break
		}
	}

	activatedTools := activatedToolNames(req.Messages)
	for _, t := range req.Tools {
		if t.Deferred && !activatedTools[t.Name] {
			continue
		}
		schema := t.Schema
		if len(schema) == 0 || !json.Valid(schema) {
			schema = json.RawMessage(`{"type":"object"}`)
		}
		out.Tools = append(out.Tools, anthTool{
			Name: t.Name, Description: t.Description, InputSchema: schema,
		})
	}
	if len(out.Tools) > 0 {
		out.Tools[len(out.Tools)-1].CacheControl = &anthCacheControl{Type: "ephemeral"}
	}

	return out, nil
}

func buildAnthUserContent(blocks []Content) []interface{} {
	var out []interface{}
	for _, b := range blocks {
		switch v := b.(type) {
		case TextBlock:
			out = append(out, anthTextBlock{Type: "text", Text: v.Text})
		case ImageBlock:
			var img anthImageBlock
			img.Type = "image"
			img.Source.Type = "base64"
			img.Source.MediaType = v.MimeType
			img.Source.Data = base64.StdEncoding.EncodeToString(v.Data)
			out = append(out, img)
		}
	}
	return out
}

func buildAnthToolResultContent(blocks []Content) interface{} {
	var out []interface{}
	for _, b := range blocks {
		switch v := b.(type) {
		case TextBlock:
			out = append(out, anthTextBlock{Type: "text", Text: v.Text})
		case ImageBlock:
			var img anthImageBlock
			img.Type = "image"
			img.Source.Type = "base64"
			img.Source.MediaType = v.MimeType
			img.Source.Data = base64.StdEncoding.EncodeToString(v.Data)
			out = append(out, img)
		}
	}
	if len(out) == 0 {
		return ""
	}
	if len(out) == 1 {
		if t, ok := out[0].(anthTextBlock); ok {
			return t.Text
		}
	}
	return out
}

// ---- streaming ----

func (c *anthropicClient) messagesURL() string {
	return strings.TrimRight(c.baseURL, "/") + "/messages"
}

func (c *anthropicClient) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	endpoint := c.messagesURL()
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
		httpReq.Header.Set("x-api-key", c.apiKey)
		httpReq.Header.Set("anthropic-version", anthropicVersion)
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

func (c *anthropicClient) runStream(ctx context.Context, resp *http.Response, req Request, out chan<- Event) {
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

	type blockEntry struct {
		kind      string // "text" | "tool_use" | "redacted"
		textBuf   strings.Builder
		toolID    string
		toolName  string
		toolArgs  strings.Builder
		announced bool
		// redacted holds the whole encrypted thinking payload, which arrives
		// complete inside content_block_start (redacted blocks have no deltas).
		redacted string
	}
	blocks := map[int]*blockEntry{}
	var (
		reasoningBuf strings.Builder
		usage        Usage
		stop         StopReason = StopEnd
		finalErr     error
		// sawStop tracks a clean message_stop. Without it the stream was
		// cut (connection closed, gateway abort): any tool_use block in
		// the wreckage is incomplete and must error, never pass as a
		// finished turn.
		sawStop bool
	)

	ordered := func() []*blockEntry {
		// Content blocks arrive in index order but indexes may be sparse
		// (a tool_use can be index 0); map iteration is random, so sort.
		max := -1
		for i := range blocks {
			if i > max {
				max = i
			}
		}
		out := make([]*blockEntry, 0, len(blocks))
		for i := 0; i <= max; i++ {
			if b, ok := blocks[i]; ok {
				out = append(out, b)
			}
		}
		return out
	}

	assembleMsg := func() Message {
		content := []Content{}
		for _, b := range ordered() {
			switch b.kind {
			case "redacted":
				content = append(content, ReasoningBlock{Encrypted: b.redacted})
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
					ID: b.toolID, Name: b.toolName, Arguments: json.RawMessage(args),
				})
			}
		}
		if reasoningBuf.Len() > 0 {
			content = append(content, ReasoningBlock{Summary: reasoningBuf.String()})
		}
		return Message{Role: RoleAssistant, Content: content, Time: time.Now()}
	}

	sendDone := func() {
		msg := assembleMsg()
		if !sawStop && stop != StopAborted && finalErr == nil {
			for _, blk := range msg.Content {
				if tc, ok := blk.(ToolCallBlock); ok {
					stop = StopError
					finalErr = fmt.Errorf(
						"%s: truncated response: stream ended without message_stop with incomplete tool_use %q (%s)",
						c.Name(), tc.ID, tc.Name,
					)
					break
				}
			}
		}
		StampCost(model, &usage)
		out <- EventUsage{Usage: usage}
		out <- EventDone{Stop: stop, Err: finalErr, Message: msg}
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
			if ev.Event == "ping" {
				continue
			}
			if ev.Data == "" {
				continue
			}
			var msg struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "error":
				var errBody struct {
					Error struct {
						Type    string `json:"type"`
						Message string `json:"message"`
					} `json:"error"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &errBody); err == nil {
					stop = StopError
					finalErr = fmt.Errorf("anthropic: %s: %s", errBody.Error.Type, errBody.Error.Message)
					sendDone()
					return
				}
			case "message_start":
				var start struct {
					Message struct {
						Model string `json:"model"`
						Usage struct {
							InputTokens         int `json:"input_tokens"`
							CacheCreationTokens int `json:"cache_creation_input_tokens"`
							CacheReadTokens     int `json:"cache_read_input_tokens"`
						} `json:"usage"`
					} `json:"message"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &start); err == nil {
					usage.InputTokens = start.Message.Usage.InputTokens
					usage.CacheWriteTokens = start.Message.Usage.CacheCreationTokens
					usage.CacheReadTokens = start.Message.Usage.CacheReadTokens
				}
			case "content_block_start":
				var st struct {
					Index        int `json:"index"`
					ContentBlock struct {
						Type string `json:"type"`
						ID   string `json:"id"`
						Name string `json:"name"`
						Data string `json:"data"`
					} `json:"content_block"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &st); err != nil {
					continue
				}
				switch st.ContentBlock.Type {
				case "redacted_thinking":
					// Encrypted thinking arrives whole in the start event —
					// there are no deltas to wait for. Keep it verbatim so
					// the next turn replays it in position.
					if st.ContentBlock.Data != "" {
						blocks[st.Index] = &blockEntry{kind: "redacted", redacted: st.ContentBlock.Data}
					}
				case "tool_use":
					b := &blockEntry{kind: "tool_use"}
					b.toolID = st.ContentBlock.ID
					b.toolName = st.ContentBlock.Name
					blocks[st.Index] = b
					if b.toolID != "" && b.toolName != "" {
						b.announced = true
						out <- EventToolStart{ID: b.toolID, Name: b.toolName}
					}
				default:
					// text and thinking blocks stream as text-like deltas.
					blocks[st.Index] = &blockEntry{kind: "text"}
				}
			case "content_block_delta":
				var d struct {
					Index int `json:"index"`
					Delta struct {
						Type        string `json:"type"`
						Text        string `json:"text"`
						PartialJSON string `json:"partial_json"`
						Thinking    string `json:"thinking"`
					} `json:"delta"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &d); err != nil {
					continue
				}
				b := blocks[d.Index]
				if b == nil {
					b = &blockEntry{kind: "text"}
					blocks[d.Index] = b
				}
				switch d.Delta.Type {
				case "text_delta":
					b.textBuf.WriteString(d.Delta.Text)
					out <- EventTextDelta{Delta: d.Delta.Text}
				case "input_json_delta":
					if b.kind != "tool_use" {
						b.kind = "tool_use"
					}
					// Late id/name (block start without them): announce now.
					if !b.announced && b.toolID != "" && b.toolName != "" {
						b.announced = true
						out <- EventToolStart{ID: b.toolID, Name: b.toolName}
					}
					b.toolArgs.WriteString(d.Delta.PartialJSON)
					if b.announced {
						out <- EventToolArgs{ID: b.toolID, Delta: d.Delta.PartialJSON}
					}
				case "thinking_delta", "signature_delta":
					if d.Delta.Thinking != "" {
						reasoningBuf.WriteString(d.Delta.Thinking)
						out <- EventReasoningDelta{Delta: d.Delta.Thinking}
					}
				}
			case "message_delta":
				var md struct {
					Delta struct {
						StopReason string `json:"stop_reason"`
					} `json:"delta"`
					Usage struct {
						OutputTokens     int  `json:"output_tokens"`
						InputTokens      *int `json:"input_tokens"`
						CacheReadTokens  *int `json:"cache_read_input_tokens"`
						CacheWriteTokens *int `json:"cache_creation_input_tokens"`
					} `json:"usage"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &md); err != nil {
					continue
				}
				if md.Usage.OutputTokens != 0 {
					usage.OutputTokens = md.Usage.OutputTokens
				}
				if md.Usage.InputTokens != nil {
					usage.InputTokens = *md.Usage.InputTokens
				}
				if md.Usage.CacheReadTokens != nil {
					usage.CacheReadTokens = *md.Usage.CacheReadTokens
				}
				if md.Usage.CacheWriteTokens != nil {
					usage.CacheWriteTokens = *md.Usage.CacheWriteTokens
				}
				switch md.Delta.StopReason {
				case "tool_use":
					stop = StopToolUse
					announcedAny := false
					for _, b := range ordered() {
						if b.kind == "tool_use" && b.announced {
							announcedAny = true
							out <- EventToolEnd{ID: b.toolID}
						}
					}
					if !announcedAny {
						stop = StopEnd
					}
				case "max_tokens":
					stop = StopLength
				default:
					stop = StopEnd
				}
			case "message_stop":
				sawStop = true
				sendDone()
				return
			}
		}
	}
}
