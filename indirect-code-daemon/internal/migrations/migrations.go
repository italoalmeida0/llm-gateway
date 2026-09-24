package migrations

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Storage migration chain for one SLOT dir (sessions + storage_version.json
// live inside the slot; nothing versioned lives at the root).
//
// Versioning mirrors the gateway's server/db.ts pattern (MIGRATIONS +
// PRAGMA user_version), adapted to a file tree: the current version lives
// in <slotDir>/storage_version.json. The launcher applies every pending
// migration in order; the daemon assumes CurrentVersion and fails fast
// otherwise. Every migration must be idempotent (re-running a fully or
// partially applied migration is always safe).
//
// Fresh installs start AT CurrentVersion (baseline stamp, no conversions):
// there is nothing to convert — sessions are JSONL with the meta line
// last since day one.

// CurrentVersion is the storage schema version the daemon understands.
const CurrentVersion = 1

// Migration is one version step: version N-1 -> N.
type Migration struct {
	Version int
	Name    string
	Apply   func(slotDir string) error
	Verify  func(slotDir string) error
}

// registry holds all migrations sorted by version.
var registry = map[int]Migration{}

func register(m Migration) {
	registry[m.Version] = m
}

func ordered() []Migration {
	vs := make([]int, 0, len(registry))
	for v := range registry {
		vs = append(vs, v)
	}
	sort.Ints(vs)
	out := make([]Migration, 0, len(vs))
	for _, v := range vs {
		out = append(out, registry[v])
	}
	return out
}

func versionFile(slotDir string) string {
	return filepath.Join(slotDir, "storage_version.json")
}

// StoredVersion reads the applied version (0 = unstamped slot dir).
func StoredVersion(slotDir string) (int, error) {
	raw, err := os.ReadFile(versionFile(slotDir))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	var doc struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, fmt.Errorf("unreadable storage_version.json: %w", err)
	}
	if doc.Version < 0 || doc.Version > CurrentVersion+100 {
		return 0, fmt.Errorf("implausible storage version %d", doc.Version)
	}
	return doc.Version, nil
}

func writeVersion(slotDir string, v int) error {
	data, err := json.MarshalIndent(map[string]any{"version": v}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(slotDir, ".storage-version-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, versionFile(slotDir))
}

// MigrateDir runs the chain with dir as the slot root (used for slot
// updates: the inactive slot dir is a full data root).
func MigrateDir(dir string) ([]int, error) {
	return Migrate(dir)
}

// Migrate applies every pending migration in order and returns the list
// of applied versions (empty when already current). Each migration is
// verified after apply; a failed migration aborts the chain WITHOUT
// bumping the stored version, so re-running resumes correctly.
//
// A fresh slot dir (no version file, no sessions) is stamped at
// CurrentVersion with no conversions: baseline, not a migration.
func Migrate(slotDir string) ([]int, error) {
	stored, err := StoredVersion(slotDir)
	if err != nil {
		return nil, err
	}
	if stored > CurrentVersion {
		return nil, fmt.Errorf("storage v%d is newer than this launcher (v%d): update the launcher", stored, CurrentVersion)
	}
	if stored == 0 {
		// Fresh slot: stamp the baseline, run nothing.
		if err := writeVersion(slotDir, CurrentVersion); err != nil {
			return nil, fmt.Errorf("baseline stamp: %w", err)
		}
		return []int{CurrentVersion}, nil
	}
	var applied []int
	for _, m := range ordered() {
		if m.Version <= stored || m.Version > CurrentVersion {
			continue
		}
		if err := m.Apply(slotDir); err != nil {
			return applied, fmt.Errorf("migration %d (%s): %w", m.Version, m.Name, err)
		}
		if m.Verify != nil {
			if err := m.Verify(slotDir); err != nil {
				return applied, fmt.Errorf("migration %d (%s) verify: %w", m.Version, m.Name, err)
			}
		}
		if err := writeVersion(slotDir, m.Version); err != nil {
			return applied, fmt.Errorf("migration %d: persist version: %w", m.Version, err)
		}
		applied = append(applied, m.Version)
	}
	return applied, nil
}
