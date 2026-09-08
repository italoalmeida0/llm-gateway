package main

// Managed info/exclude for the temp git review repo.
//
// The exclude keeps the temp repo small and relevant: dependency, build,
// cache, log and editor-temporary files never enter the baseline commit and
// therefore never show up as pending changes. The project's own .gitignore
// still applies on top (git evaluates both); this file is only the ADDITIONAL
// daemon-managed layer.
//
// User lines outside the managed block are preserved across rewrites.

import (
	"os"
	"path/filepath"
	"strings"
)

const gitExcludeBegin = "### llm-gateway-managed begin (do not edit) ###"
const gitExcludeEnd = "### llm-gateway-managed end ###"

// gitManagedExclude is the broad temp/dependency/build ignore list applied to
// every temp review repo, covering the common ecosystems.
var gitManagedExclude = []string{
	".git/",
	".hg/",
	".svn/",
	".bzr/",
	"node_modules/",
	".npm/",
	".yarn/",
	".pnpm-store/",
	"bower_components/",
	"vendor/",
	"dist/",
	"build/",
	"out/",
	".next/",
	".nuxt/",
	".output/",
	".vercel/",
	".netlify/",
	"coverage/",
	".nyc_output/",
	"__pycache__/",
	".pytest_cache/",
	".mypy_cache/",
	".ruff_cache/",
	".venv/",
	"venv/",
	".tox/",
	"target/",
	".gradle/",
	"bin/",
	"obj/",
	".vs/",
	".idea/",
	".vscode/",
	".zed/",
	".cache/",
	".parcel-cache/",
	".turbo/",
	".vite/",
	"*.log",
	"*.tmp",
	"*.temp",
	"*.swp",
	"*.swo",
	"*~",
	".DS_Store",
	"Thumbs.db",
	"*.orig",
	"*.rej",
	".env*.local",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.pyc",
	"*.pyo",
	"*.class",
	"*.o",
	"*.a",
	"*.so",
	"*.dylib",
	"*.dll",
	"*.exe",
}

// writeExclude rewrites <gitDir>/info/exclude, preserving user content
// outside the managed block.
func (t *gitReviewTracker) writeExclude() error {
	infoDir := filepath.Join(t.gitDir, "info")
	if err := os.MkdirAll(infoDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(infoDir, "exclude")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	}
	var kept []string
	inManaged := false
	for _, line := range strings.Split(existing, "\n") {
		trim := strings.TrimSpace(line)
		if trim == gitExcludeBegin {
			inManaged = true
			continue
		}
		if trim == gitExcludeEnd {
			inManaged = false
			continue
		}
		if !inManaged {
			kept = append(kept, line)
		}
	}
	var b strings.Builder
	for _, line := range kept {
		if strings.TrimSpace(line) == "" && len(kept) <= 1 {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString(gitExcludeBegin + "\n")
	for _, pattern := range gitManagedExclude {
		b.WriteString(pattern + "\n")
	}
	b.WriteString(gitExcludeEnd + "\n")
	return os.WriteFile(path, []byte(b.String()), 0o600)
}
