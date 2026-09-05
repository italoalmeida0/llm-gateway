package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/patriceckhart/zot/packages/provider"
)

func TestScanStoredSessionGroupsIncludesDefaultAndAgentSessions(t *testing.T) {
	home := t.TempDir()
	cwdA := filepath.Join(home, "missing-a")
	cwdB := filepath.Join(home, "missing-b")

	create := func(root, cwd, text string) string {
		t.Helper()
		session, err := NewSession(root, cwd, "test", "test-model", "test-version")
		if err != nil {
			t.Fatal(err)
		}
		if err := session.AppendMessage(provider.Message{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: text}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := session.Close(); err != nil {
			t.Fatal(err)
		}
		return session.Path
	}

	first := create(home, cwdA, "one")
	second := create(home, cwdA, "two")
	agentRoot := filepath.Join(home, "sessions", "agents", "reviewer")
	third := create(agentRoot, cwdA, "agent")
	_ = create(home, cwdB, "other")
	bad := filepath.Join(home, "sessions", "bad.jsonl")
	if err := os.WriteFile(bad, []byte("not json\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	groups, issues := ScanStoredSessionGroups(filepath.Join(home, "sessions"))
	if len(groups) != 2 {
		t.Fatalf("groups = %#v, want 2", groups)
	}
	if groups[0].CWD != cwdA || len(groups[0].Paths) != 3 {
		t.Fatalf("first group = %#v, want three sessions for %q", groups[0], cwdA)
	}
	for _, want := range []string{first, second, third} {
		if !pruneTestContainsString(groups[0].Paths, want) {
			t.Errorf("group paths %q do not contain %q", groups[0].Paths, want)
		}
	}
	if groups[0].SizeBytes <= 0 {
		t.Fatalf("group summary missing size: %#v", groups[0])
	}
	if groups[1].CWD != cwdB || len(groups[1].Paths) != 1 {
		t.Fatalf("second group = %#v", groups[1])
	}
	if len(issues) != 1 || issues[0].Path != bad {
		t.Fatalf("issues = %#v, want malformed session issue", issues)
	}
}

func TestScanStoredSessionGroupsMissingRootIsEmpty(t *testing.T) {
	groups, issues := ScanStoredSessionGroups(filepath.Join(t.TempDir(), "missing"))
	if len(groups) != 0 || len(issues) != 0 {
		t.Fatalf("groups = %#v, issues = %#v, want empty", groups, issues)
	}
}

func pruneTestContainsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
