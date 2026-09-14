package mcp

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
var envPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
var headerPattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$")

func ValidName(name string) bool {
	return namePattern.MatchString(name) && name != "constructor" && name != "prototype" && name != "__proto__"
}

func Validate(cfg Config) error {
	switch cfg.Transport {
	case "", "stdio":
		if strings.TrimSpace(cfg.Command) == "" || len(cfg.Command) > 4096 || strings.ContainsRune(cfg.Command, 0) {
			return errors.New("MCP command is required and must not contain null bytes")
		}
	case "http", "streamable-http", "sse":
		u, err := url.Parse(cfg.URL)
		if err != nil || len(cfg.URL) > 8192 || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
			return errors.New("MCP URL must be HTTP or HTTPS without embedded credentials or a fragment")
		}
	default:
		return errors.New("Unsupported MCP transport")
	}
	if len(cfg.Args) > 128 || len(cfg.Env) > 128 || len(cfg.Headers) > 64 {
		return errors.New("MCP configuration has too many arguments or variables")
	}
	for _, arg := range cfg.Args {
		if len(arg) > 16384 || strings.ContainsRune(arg, 0) {
			return errors.New("Invalid MCP argument")
		}
	}
	for k, v := range cfg.Env {
		if !envPattern.MatchString(k) || len(k) > 256 || len(v) > 16384 || strings.ContainsRune(v, 0) {
			return errors.New("Invalid MCP environment variable")
		}
	}
	for k, v := range cfg.Headers {
		if !headerPattern.MatchString(k) || len(k) > 256 || len(v) > 16384 || strings.ContainsAny(v, "\r\n\x00") {
			return errors.New("Invalid MCP header")
		}
		switch strings.ToLower(k) {
		case "host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version":
			return errors.New("MCP transport headers are managed automatically")
		}
	}
	return nil
}

// exec.Command resolves names before applying Cmd.Env. Honor an explicit PATH
// without mutating the daemon process environment used by other sessions.
func executablePath(cfg Config, cwd string) (string, error) {
	if filepath.IsAbs(cfg.Command) || strings.ContainsAny(cfg.Command, "/\\") {
		return cfg.Command, nil
	}
	for key, value := range cfg.Env {
		if key != "PATH" && !(runtime.GOOS == "windows" && strings.EqualFold(key, "PATH")) {
			continue
		}
		for _, dir := range filepath.SplitList(value) {
			if !filepath.IsAbs(dir) {
				dir = filepath.Join(cwd, dir)
			}
			if path, err := exec.LookPath(filepath.Join(dir, cfg.Command)); err == nil {
				return path, nil
			}
		}
		return "", os.ErrNotExist
	}
	return exec.LookPath(cfg.Command)
}
