package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// projectsActor is the sole owner of projects.json. All CRUD goes through
// its mailbox, eliminating v1's file-level lost-update. Cascade delete
// purges sessions via the session supervisor (passed as callback to avoid
// an import cycle in wiring).

type projCreateMsg struct {
	Path  string
	Name  string
	Reply chan any
}

type projDeleteMsg struct {
	ProjectID string
	Reply     chan any
}

type projCollapseMsg struct {
	ProjectID string
	Collapsed bool
}

type projListMsg struct {
	Reply chan any
}

type projectsActor struct {
	dataDir string
	inbox   chan Envelope
	control chan any

	emit         func(any)
	hostID       func() string
	onEvent      func(string)
	purgeSession func(id string) error // session supervisor cascade

	list []ProjectEntry
}

func newProjectsActor(dataDir string) *projectsActor {
	return &projectsActor{
		dataDir: dataDir,
		inbox:   make(chan Envelope, inboxCap),
		control: make(chan any, controlCap),
	}
}

func (p *projectsActor) file() string { return filepath.Join(p.dataDir, "projects.json") }

func (p *projectsActor) load() {
	data, _ := os.ReadFile(p.file())
	var list []ProjectEntry
	_ = json.Unmarshal(data, &list)
	home, _ := os.UserHomeDir()
	cleanHome := filepath.Clean(home)
	found := false
	modified := false
	for i := range list {
		cleanP := filepath.Clean(resolvePath(list[i].Path))
		if cleanP == cleanHome {
			list[i].Path, list[i].Name, list[i].Protected = home, "Home", true
			found = true
		} else {
			if list[i].Protected {
				list[i].Protected = false
				modified = true
			}
			if list[i].Name == "Home" {
				base := filepath.Base(list[i].Path)
				if base == "." || base == "" {
					list[i].Name = list[i].Path
				} else {
					list[i].Name = base
				}
				modified = true
			}
		}
	}
	if !found && home != "" {
		list = append(list, ProjectEntry{ID: "home", Name: "Home", Path: home, Protected: true})
		modified = true
	}
	if modified && len(data) > 0 {
		_ = p.save(list)
	}
	p.list = list
}

func (p *projectsActor) write(list []ProjectEntry) error {
	if err := os.MkdirAll(p.dataDir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomicFile(p.file(), data); err != nil {
		return err
	}
	return nil
}

func (p *projectsActor) save(list []ProjectEntry) error {
	if err := p.write(list); err != nil {
		return err
	}
	p.list = append([]ProjectEntry(nil), list...)
	if p.onEvent != nil {
		p.onEvent("projects")
	}
	return nil
}

func (p *projectsActor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	p.load()
	for {
		select {
		case env := <-p.inbox:
			p.handle(env)
		case msg := <-p.control:
			if _, ok := msg.(shutdownMsg); ok {
				return
			}
		}
	}
}

func (p *projectsActor) handle(env Envelope) {
	switch m := env.Payload.(type) {
	case projCreateMsg:
		p.onCreate(m)
	case projDeleteMsg:
		p.onDelete(m)
	case projCollapseMsg:
		for i := range p.list {
			if p.list[i].ID == m.ProjectID {
				next := append([]ProjectEntry(nil), p.list...)
				next[i].Collapsed = m.Collapsed
				_ = p.save(next)
				break
			}
		}
	case projListMsg:
		items := make([]map[string]any, 0, len(p.list))
		for _, pr := range p.list {
			items = append(items, projectPayload(pr))
		}
		m.Reply <- items
	}
}

func (p *projectsActor) host() string {
	if p.hostID != nil {
		return p.hostID()
	}
	return ""
}

func (p *projectsActor) onCreate(m projCreateMsg) {
	fail := func(msg string) {
		m.Reply <- map[string]any{"type": "error", "hostId": p.host(), "message": msg}
	}
	rawPath := strings.TrimSpace(m.Path)
	if rawPath == "" {
		fail("Project path cannot be empty")
		return
	}
	path := resolvePath(rawPath)
	if path == "" {
		fail("Project path cannot be resolved")
		return
	}
	_ = os.MkdirAll(path, 0o755)
	name := strings.TrimSpace(m.Name)
	home, _ := os.UserHomeDir()
	cleanPath := filepath.Clean(path)
	isHome := home != "" && filepath.Clean(home) == cleanPath
	if name == "" {
		if isHome {
			name = "Home"
		} else {
			base := filepath.Base(path)
			if base == "." || base == "" {
				name = path
			} else {
				name = base
			}
		}
	}
	// Truncate on a rune boundary: a byte cut splits multibyte names
	// (CJK/emoji) and persists a corrupted project name.
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	for _, pr := range p.list {
		if filepath.Clean(resolvePath(pr.Path)) == cleanPath {
			if isHome && !pr.Protected {
				pr.Protected = true
				_ = p.save(p.list)
			}
			m.Reply <- map[string]any{"type": "project_created", "hostId": p.host(), "project": projectPayload(pr)}
			return
		}
	}
	entry := ProjectEntry{ID: fmt.Sprintf("proj_%d", time.Now().UnixNano()/1000), Name: name, Path: path, CreatedAt: time.Now().UnixMilli(), Protected: isHome}
	if err := p.save(append([]ProjectEntry{entry}, p.list...)); err != nil {
		fail("Failed to save project: " + err.Error())
		return
	}
	m.Reply <- map[string]any{"type": "project_created", "hostId": p.host(), "project": projectPayload(entry)}
}

func (p *projectsActor) onDelete(m projDeleteMsg) {
	if m.ProjectID == "" {
		m.Reply <- map[string]any{}
		return
	}
	next := make([]ProjectEntry, 0, len(p.list))
	var doomed *ProjectEntry
	for _, pr := range p.list {
		if pr.ID == m.ProjectID {
			cp := pr
			doomed = &cp
			continue
		}
		next = append(next, pr)
	}
	if doomed != nil && doomed.Protected {
		m.Reply <- map[string]any{"type": "error", "hostId": p.host(), "message": "The default Home project cannot be deleted"}
		return
	}
	// Identify sessions before replacing p.list, since projectForDirectory
	// needs the doomed entry to resolve their owner.
	var doomedSessions []string
	// Cascade: purge sessions owned by this project. Purge is routed
	// through the session supervisor callback (which passivates + deletes
	// disk state); listed via disk scan to avoid depending on residency.
	if doomed != nil && p.purgeSession != nil {
		for _, s := range listSessionSummaries(p.dataDir) {
			owner := projectForDirectory(s.CWD, p.list)
			if owner == nil || owner.ID != doomed.ID {
				continue
			}
			doomedSessions = append(doomedSessions, s.ID)
		}
	}
	// Check that the current project file is writable before deleting sessions.
	// The project remains in memory and on disk if a purge fails, so the
	// operation can be retried; the final replacement save is still checked
	// after purging.
	if err := p.write(p.list); err != nil {
		m.Reply <- map[string]any{"type": "error", "hostId": p.host(), "message": "Failed to save project: " + err.Error()}
		return
	}
	for _, id := range doomedSessions {
		if err := p.purgeSession(id); err != nil {
			m.Reply <- map[string]any{"type": "error", "hostId": p.host(), "message": "Failed to purge project session: " + err.Error()}
			return
		}
	}
	if err := p.save(next); err != nil {
		m.Reply <- map[string]any{"type": "error", "hostId": p.host(), "message": "Failed to save project: " + err.Error()}
		return
	}
	m.Reply <- map[string]any{"type": "project_deleted", "hostId": p.host(), "projectId": m.ProjectID}
}

func projectPayload(pr ProjectEntry) map[string]any {
	return map[string]any{
		"id": pr.ID, "name": pr.Name, "path": pr.Path,
		"createdAt": pr.CreatedAt, "protected": pr.Protected,
		"collapsed": pr.Collapsed, "folderStatus": inspectWorkspace(pr.Path).Status,
	}
}

func projectForDirectory(cwd string, projects []ProjectEntry) *ProjectEntry {
	cwd = resolvePath(cwd)
	normalize := func(path string) string {
		path = filepath.Clean(path)
		if runtime.GOOS == "windows" {
			path = strings.ToLower(path)
		}
		return path
	}
	cwd = normalize(cwd)
	var match *ProjectEntry
	length := -1
	for i := range projects {
		if projects[i].Path == "" {
			continue
		}
		path := normalize(projects[i].Path)
		prefix := strings.TrimRight(path, string(filepath.Separator)) + string(filepath.Separator)
		if (cwd == path || strings.HasPrefix(cwd, prefix)) && len(path) > length {
			match = &projects[i]
			length = len(path)
		}
	}
	if match == nil {
		for i := range projects {
			if projects[i].Protected {
				return &projects[i]
			}
		}
	}
	return match
}
