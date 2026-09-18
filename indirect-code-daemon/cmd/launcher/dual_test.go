package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDualDownloadVersionedFirst(t *testing.T) {
	var hits []string
	fakeBin := "#!/bin/sh\necho 'indirect-code daemon v9.9.9'\n"
	pad := make([]byte, 2<<20)
	for i := range pad {
		pad[i] = '#'
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		w.Write([]byte(fakeBin))
		w.Write(pad)
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	dir := t.TempDir()
	lp, err := fetchDaemonTo(dir, "9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0] != "/indirect-code-"+runtime.GOOS+"-"+runtime.GOARCH+"-v9.9.9" {
		t.Fatalf("versioned URL must be tried first, hits=%v", hits)
	}
	if err := selfVerifyDaemon(lp, "9.9.9"); err != nil {
		t.Fatalf("self-verify: %v", err)
	}
	_ = filepath.Join
	_ = os.Getpid
}

func TestDualDownloadFallback(t *testing.T) {
	// Versioned 404s, floating serves stale-but-valid binary: download
	// succeeds via fallback, self-verify decides (fails here).
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "-v9.9.9") {
			w.WriteHeader(404)
			return
		}
		w.Write([]byte("#!/bin/sh\necho 'indirect-code daemon vOLD'\n"))
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	dir := t.TempDir()
	lp, err := fetchDaemonTo(dir, "9.9.9")
	if err != nil {
		t.Fatalf("fallback must succeed at download: %v", err)
	}
	if err := selfVerifyDaemon(lp, "9.9.9"); err == nil {
		t.Fatal("stale fallback must fail self-verify")
	}
	if len(hits) != 2 {
		t.Fatalf("expected 2 attempts, hits=%v", hits)
	}
}
