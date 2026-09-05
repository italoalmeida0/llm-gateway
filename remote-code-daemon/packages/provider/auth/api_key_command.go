package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	defaultAPIKeyCommandTimeout = 120 * time.Second
	maxAPIKeyCommandOutput      = 64 << 10
)

// APIKeyCommand describes a program that prints an API key to stdout.
// Program is executed directly, without a shell.
type APIKeyCommand struct {
	Program   string   `json:"program"`
	Args      []string `json:"args,omitempty"`
	TimeoutMS int      `json:"timeout_ms,omitempty"`
}

type apiKeyCommandCall struct {
	done  chan struct{}
	value string
	err   error
}

var apiKeyCommandCache = struct {
	sync.Mutex
	values   map[[sha256.Size]byte]string
	inflight map[[sha256.Size]byte]*apiKeyCommandCall
}{
	values:   make(map[[sha256.Size]byte]string),
	inflight: make(map[[sha256.Size]byte]*apiKeyCommandCall),
}

// ResolveAPIKeyCommand executes command and returns its API key. Successful
// results are cached in memory for the lifetime of the process. Concurrent
// requests for the same command share one execution.
func ResolveAPIKeyCommand(ctx context.Context, command APIKeyCommand) (string, error) {
	if strings.TrimSpace(command.Program) == "" {
		return "", errors.New("api key command has an empty program")
	}
	if command.TimeoutMS < 0 {
		return "", errors.New("api key command timeout_ms must not be negative")
	}

	encoded, err := json.Marshal(command)
	if err != nil {
		return "", errors.New("encode api key command")
	}
	cacheKey := sha256.Sum256(encoded)
	apiKeyCommandCache.Lock()
	if value, ok := apiKeyCommandCache.values[cacheKey]; ok {
		apiKeyCommandCache.Unlock()
		return value, nil
	}
	if call, ok := apiKeyCommandCache.inflight[cacheKey]; ok {
		apiKeyCommandCache.Unlock()
		select {
		case <-call.done:
			return call.value, call.err
		case <-ctx.Done():
			return "", errors.New("api key command was canceled")
		}
	}
	call := &apiKeyCommandCall{done: make(chan struct{})}
	apiKeyCommandCache.inflight[cacheKey] = call
	apiKeyCommandCache.Unlock()

	value, resolveErr := runAPIKeyCommand(ctx, command)
	apiKeyCommandCache.Lock()
	delete(apiKeyCommandCache.inflight, cacheKey)
	if resolveErr == nil {
		apiKeyCommandCache.values[cacheKey] = value
	}
	call.value = value
	call.err = resolveErr
	close(call.done)
	apiKeyCommandCache.Unlock()
	return value, resolveErr
}

func runAPIKeyCommand(ctx context.Context, command APIKeyCommand) (string, error) {
	timeout := defaultAPIKeyCommandTimeout
	if command.TimeoutMS > 0 {
		timeout = time.Duration(command.TimeoutMS) * time.Millisecond
	}
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(commandCtx, command.Program, command.Args...)
	configureAPIKeyCommandProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", errors.New("prepare api key command output")
	}
	if err := cmd.Start(); err != nil {
		return "", errors.New("start api key command")
	}

	output, readErr := io.ReadAll(io.LimitReader(stdout, maxAPIKeyCommandOutput+1))
	if len(output) > maxAPIKeyCommandOutput {
		cancelAPIKeyCommandProcess(cmd)
		_ = cmd.Wait()
		return "", fmt.Errorf("api key command output exceeds %d bytes", maxAPIKeyCommandOutput)
	}
	waitErr := cmd.Wait()
	if commandCtx.Err() != nil {
		return "", errors.New("api key command timed out or was canceled")
	}
	if readErr != nil {
		return "", errors.New("read api key command output")
	}
	if waitErr != nil {
		return "", errors.New("api key command exited unsuccessfully")
	}

	value := strings.TrimRight(string(output), "\r\n")
	if value == "" {
		return "", errors.New("api key command returned empty output")
	}
	if strings.ContainsAny(value, "\r\n") {
		return "", errors.New("api key command returned multiple lines")
	}

	return value, nil
}
