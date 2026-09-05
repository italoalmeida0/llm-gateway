package auth

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAPIKeyCommandHelperProcess(t *testing.T) {
	if os.Getenv("ZOT_API_KEY_COMMAND_HELPER") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) < 2 {
		os.Exit(2)
	}
	switch args[1] {
	case "print":
		fmt.Print(os.Getenv("ZOT_API_KEY_COMMAND_VALUE"))
	case "fail":
		fmt.Fprint(os.Stderr, os.Getenv("ZOT_API_KEY_COMMAND_VALUE"))
		os.Exit(1)
	case "sleep":
		time.Sleep(5 * time.Second)
	case "large":
		fmt.Print(strings.Repeat("x", maxAPIKeyCommandOutput+1))
	case "count":
		if len(args) < 3 {
			os.Exit(2)
		}
		f, err := os.OpenFile(args[2], os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(3)
		}
		_, _ = f.WriteString("run\n")
		_ = f.Close()
		fmt.Print("cached-key\n")
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func apiKeyHelperCommand(mode string, extra ...string) APIKeyCommand {
	args := []string{"-test.run=^TestAPIKeyCommandHelperProcess$", "--", mode}
	args = append(args, extra...)
	return APIKeyCommand{Program: os.Args[0], Args: args}
}

func resetAPIKeyCommandCache(t *testing.T) {
	t.Helper()
	apiKeyCommandCache.Lock()
	oldValues := apiKeyCommandCache.values
	oldInflight := apiKeyCommandCache.inflight
	apiKeyCommandCache.values = make(map[[32]byte]string)
	apiKeyCommandCache.inflight = make(map[[32]byte]*apiKeyCommandCall)
	apiKeyCommandCache.Unlock()
	t.Cleanup(func() {
		apiKeyCommandCache.Lock()
		apiKeyCommandCache.values = oldValues
		apiKeyCommandCache.inflight = oldInflight
		apiKeyCommandCache.Unlock()
	})
}

func TestResolveAPIKeyCommand(t *testing.T) {
	resetAPIKeyCommandCache(t)
	t.Setenv("ZOT_API_KEY_COMMAND_HELPER", "1")
	t.Setenv("ZOT_API_KEY_COMMAND_VALUE", "secret-value\r\n")

	got, err := ResolveAPIKeyCommand(context.Background(), apiKeyHelperCommand("print"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "secret-value" {
		t.Fatalf("ResolveAPIKeyCommand() = %q, want %q", got, "secret-value")
	}
}

func TestResolveAPIKeyCommandCachesSuccess(t *testing.T) {
	resetAPIKeyCommandCache(t)
	t.Setenv("ZOT_API_KEY_COMMAND_HELPER", "1")
	countPath := t.TempDir() + string(os.PathSeparator) + "count"
	command := apiKeyHelperCommand("count", countPath)

	for range 2 {
		got, err := ResolveAPIKeyCommand(context.Background(), command)
		if err != nil {
			t.Fatal(err)
		}
		if got != "cached-key" {
			t.Fatalf("got %q", got)
		}
	}
	contents, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(contents), "run\n"); got != 1 {
		t.Fatalf("command ran %d times, want 1", got)
	}
}

func TestResolveAPIKeyCommandFailureDoesNotExposeOutput(t *testing.T) {
	resetAPIKeyCommandCache(t)
	t.Setenv("ZOT_API_KEY_COMMAND_HELPER", "1")
	t.Setenv("ZOT_API_KEY_COMMAND_VALUE", "must-not-appear")

	_, err := ResolveAPIKeyCommand(context.Background(), apiKeyHelperCommand("fail"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "must-not-appear") {
		t.Fatalf("error exposed command output: %v", err)
	}
}

func TestResolveAPIKeyCommandTimeoutAndOutputLimit(t *testing.T) {
	resetAPIKeyCommandCache(t)
	t.Setenv("ZOT_API_KEY_COMMAND_HELPER", "1")

	t.Run("timeout", func(t *testing.T) {
		command := apiKeyHelperCommand("sleep")
		command.TimeoutMS = 20
		if _, err := ResolveAPIKeyCommand(context.Background(), command); err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("error = %v, want timeout", err)
		}
	})
	t.Run("output limit", func(t *testing.T) {
		if _, err := ResolveAPIKeyCommand(context.Background(), apiKeyHelperCommand("large")); err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("error = %v, want output limit", err)
		}
	})
}
