package tools

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPermissionSetEmptyScopesDenyAccess(t *testing.T) {
	s := NewSandbox(t.TempDir())
	s.SetPermissions(&PermissionSet{})
	if err := s.CheckReadPath(filepath.Join(s.Root, "a")); err == nil {
		t.Fatal("empty read scope allowed access")
	}
	if err := s.CheckWritePath(filepath.Join(s.Root, "a")); err == nil {
		t.Fatal("empty write scope allowed access")
	}
}

func TestPermissionSetScopedAccess(t *testing.T) {
	root := t.TempDir()
	var p PermissionSet
	p.FS.Read = []string{"${workspace}/src"}
	p.FS.Write = []string{"${agent_data}"}
	expanded := p.Expand(root, filepath.Join(root, "data"))
	s := NewSandbox(root)
	s.SetPermissions(&expanded)
	if err := s.CheckReadPath(filepath.Join(root, "src", "a.go")); err != nil {
		t.Fatalf("read inside scope: %v", err)
	}
	if err := s.CheckReadPath(filepath.Join(root, "secret")); err == nil {
		t.Fatal("read outside scope was allowed")
	}
	if err := s.CheckWritePath(filepath.Join(root, "data", "state.json")); err != nil {
		t.Fatalf("write inside scope: %v", err)
	}
}

func TestPermissionExpandDoesNotMutateManifest(t *testing.T) {
	var p PermissionSet
	p.FS.Read = []string{"${workspace}"}
	_ = p.Expand("/first", "/data")
	if got := p.FS.Read[0]; got != "${workspace}" {
		t.Fatalf("manifest mutated to %q", got)
	}
}

func TestBashAllowlistRejectsShellEscapes(t *testing.T) {
	var p PermissionSet
	p.Bash.Mode = "allowlist"
	p.Bash.Allow = []string{"echo"}
	s := NewSandbox(t.TempDir())
	s.SetPermissions(&p)
	for _, cmd := range []string{"echo $(uname)", "echo hi > /tmp/out", "echo `uname`", "echo ok\nrm -rf /"} {
		if err := s.CheckBashPermission(cmd); err == nil || !strings.Contains(err.Error(), "does not permit") {
			t.Errorf("command %q was not rejected: %v", cmd, err)
		}
	}
	if err := s.CheckBashPermission("echo ok"); err != nil {
		t.Fatalf("allowed command rejected: %v", err)
	}
	if err := s.CheckBashPermission("rm file"); err == nil {
		t.Fatal("unlisted command was allowed")
	}
}

func TestBashModeNoneDenies(t *testing.T) {
	var p PermissionSet
	p.Bash.Mode = "none"
	s := NewSandbox(t.TempDir())
	s.SetPermissions(&p)
	if err := s.CheckBashPermission("echo ok"); err == nil {
		t.Fatal("none mode allowed bash")
	}
}

func TestBashModeAskAllows(t *testing.T) {
	var p PermissionSet
	p.Bash.Mode = "ask"
	s := NewSandbox(t.TempDir())
	s.SetPermissions(&p)
	if err := s.CheckBashPermission("rm -rf /tmp/x"); err != nil {
		t.Fatalf("ask mode rejected command: %v", err)
	}
}
