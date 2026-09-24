package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Session lifecycle TTLs (plan §6).
const (
	// idleCacheTTL keeps a never-used (passively loaded) session in RAM.
	idleCacheTTL = 1 * time.Minute
	// postTurnTTL keeps a session after its turn truly ends.
	postTurnTTL = 30 * time.Minute
)

// Memory budget for resident sessions (plan §6.1). Tunable.
const (
	sessionMemoryBudget = 512 * 1024 * 1024 // 512 MB
	maxResidentActors   = 64
)

// routeMsg asks the supervisor for a session handle, spawning on demand.
// Spawn replays disk + WAL (loadSessionFused); a WAL with an uncommitted
// turn resumes as running state (worker Continue plugs in with the real
// agent loop; until then the actor holds the WAL open for append).
type routeMsg struct {
	SessionID string
	ForRead   bool // passive load (history/data): short idle TTL
	Reply     chan any
}

type sessionHandle struct {
	inbox   chan Envelope
	control chan any
	done    <-chan struct{}
}

// sessionSupervisor owns map[id]sessionHandle. Spawn-on-demand with
// disk/WAL replay when absent; passivate on eviction; watchdog pings.
// Rebuilding the map is always possible (spawn-on-lookup), so a supervisor
// restart loses nothing.
type sessionSupervisor struct {
	dataDir string
	cfg     *configCell
	ws      *wsActor
	bg      *bgSupervisor

	inbox   chan Envelope
	control chan any

	mu       sync.Mutex // guards residents ONLY; never held during I/O or actor calls
	resident map[string]*residentEntry

	emitFn   func(any)
	notifyFn func(string)
}

func newSessionSupervisor(dataDir string, cfg *configCell, ws *wsActor, bg *bgSupervisor) *sessionSupervisor {
	return &sessionSupervisor{
		dataDir: dataDir, cfg: cfg, ws: ws, bg: bg,
		inbox:   make(chan Envelope, inboxCap),
		control: make(chan any, controlCap),
		resident: map[string]*residentEntry{},
	}
}

type residentEntry struct {
	handle   *sessionHandle
	idleTTL  time.Duration
	staleRounds int
	// workerAlive tracks whether the actor's turn goroutine was observed
	// running (via workerDone channel). A reap that would orphan a live
	// goroutine sharing the WAL is forbidden: cancel first, reap only
	// after the worker exits.
}

func (s *sessionSupervisor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	if err := s.boot(); err != nil {
		fmt.Printf("[WARN] session supervisor boot: %v\n", err)
	}
	evictTick := time.NewTicker(30 * time.Second)
	defer evictTick.Stop()
	watchTick := time.NewTicker(15 * time.Second)
	defer watchTick.Stop()
	for {
		select {
		case env := <-s.inbox:
			if rm, ok := env.Payload.(routeMsg); ok {
				rm.Reply <- s.route(rm.SessionID, rm.ForRead)
			}
		case msg := <-s.control:
			switch msg.(type) {
			case shutdownMsg:
				s.shutdownAll()
				return
			case passivateMsg:
				// passivate-all (memory pressure from root): evict every idle resident
				s.evictIdle(true)
			}
		case <-evictTick.C:
			s.evictIdle(false)
		case <-watchTick.C:
			s.watchdogRound()
		}
	}
}

// store returns a diskStore bound to the data dir.
func (s *sessionSupervisor) disk() *diskStore { return newDiskStore(s.dataDir) }

// boot scans disk: sessions left "running" WITHOUT a WAL are flipped back
// to idle (no turn can be in flight at boot). Sessions WITH a WAL keep it;
// the WAL is replayed on first route (spawn), which resumes the turn.
func (s *sessionSupervisor) boot() error {
	st := s.disk()
	dir := st.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") || strings.HasSuffix(e.Name(), ".wal.jsonl") {
			continue
		}
		sid := strings.TrimSuffix(e.Name(), ".jsonl")
		if _, err := os.Stat(filepath.Join(dir, sid+".wal.jsonl")); err == nil {
			continue // WAL owns this session; replay on route
		}
		meta, err := st.readMetaTail(sid)
		if err != nil || meta.Status != "running" {
			continue
		}
		meta.Status = "idle"
		if err := st.rewriteMetaOnly(sid, meta); err != nil {
			fmt.Printf("[WARN] reset stale running %s: %v\n", sid, err)
			continue
		}
		fmt.Printf("[INFO] Reset stale running session: %s\n", sid)
	}
	return nil
}

// route returns the resident handle, spawning the actor on demand.
func (s *sessionSupervisor) route(id string, forRead bool) spawnResult {
	if !validSessionID(id) {
		return spawnResult{Error: "invalid session id"}
	}
	s.mu.Lock()
	if ent, ok := s.resident[id]; ok {
		if !forRead && ent.idleTTL == idleCacheTTL {
			ent.idleTTL = postTurnTTL // promoted to active use
		}
		h := ent.handle
		s.mu.Unlock()
		return spawnResult{Inbox: h.inbox, Control: h.control, Done: h.done}
	}
	s.mu.Unlock()

	st := s.disk()
	rec, _, err := st.loadSessionFused(id)
	if err != nil {
		return spawnResult{Error: err.Error()}
	}
	act := newSessionActor(id, rec, st, s.emit, s.bg, s.onEvent)
	act.supCfg = s.cfg
	act.convertServer = func(msg map[string]any) {
		if host := s.cfg.load(); host != nil {
			msg["hostId"] = host.HostID
		}
		s.emit(msg)
	}
	// Uncommitted WAL? Reopen for append, restore the persisted approval
	// deadline, and RESUME the turn: spawn a worker in Continue mode on the
	// same turn index (v1 resumeAgentTurn parity). Abandoned WALs (turn
	// already completed/cancelled, balloon present, or empty prompt with no
	// messages) are discarded instead.
	resumeHeader, resumeWAL := turnResumeCandidate(rec, st, id)
	if resumeHeader != nil {
		act.wal = resumeWAL
		act.state = stateRunning
		if rec.Turn == nil || rec.Turn.Status != "running" {
			rec.Turn = &TurnActivity{StartedAt: resumeHeader.StartedAt, Status: "running"}
			if rec.Turn.StartedAt <= 0 {
				rec.Turn.StartedAt = time.Now().UnixMilli()
			}
		}
		if rec.Status != "running" {
			rec.Status = "running"
		}
		rec.TurnSeq = max(rec.TurnSeq, resumeHeader.TurnIndex)
		act.resumeSnap = &workerSnapshot{
			gen: -1, // filled at spawn: next gen
			jailed: rec.Jailed,
			turnIndex:   resumeHeader.TurnIndex,
			model:       rec.Model,
			options:     normalizedOptions(rec.Options),
			messages:    append([]provider.Message(nil), rec.Messages...),
			usage:       rec.Usage,
			compaction:  rec.Compaction,
			context:     rec.Context,
			attachments: append([]AttachmentRef(nil), rec.Attachments...),
			cwd:         rec.CWD,
			prompt:      resumeHeader.Prompt,
			attachIDs:   append([]string(nil), resumeHeader.AttachmentIDs...),
			incoming:    append([]filetrack.TrackedFile(nil), resumeHeader.Incoming...),
			resume:      true,
		}
		// A restart never bypasses the 15-min timeout: an already-expired
		// deadline is cleared (the resumed worker re-arms on next block);
		// a future one is kept and enforced by the worker hooks.
		if rec.ApprovalDeadlineUnix > 0 && rec.ApprovalDeadlineUnix <= time.Now().UnixMilli() {
			rec.ApprovalDeadlineUnix = 0
		}
	}
	if act.done == nil {
		act.done = make(chan struct{})
	}
	go act.run()
	if act.resumeSnap != nil {
		snap := act.resumeSnap
		act.resumeSnap = nil
		// Spawn the Continue worker on the actor goroutine so gen/cancel
		// assignment races nothing (route runs off-actor, but the actor
		// loop hasn't processed any message yet — still, be strict).
		snap.gen = act.gen + 1
		act.gen = snap.gen
		ctx, cancel := context.WithCancel(context.Background())
		act.cancel = cancel
		act.workerDone = make(chan struct{})
		gen := act.gen
		workerDone := act.workerDone
		go func() {
			defer close(workerDone)
			// startWorker signature is (act, ctx, gen, prompt); resume uses
			// the snapshot path directly.
			_ = gen
			runResumeWorker(act, ctx, snap)
		}()
		hostID := ""
		if cfg := s.cfg.load(); cfg != nil {
			hostID = cfg.HostID
		}
		act.emit(map[string]any{
			"type": "session_status", "hostId": hostID, "sessionId": id,
			"status": "running", "turn": map[string]any{"startedAt": rec.Turn.StartedAt}, "resumed": true,
		})
	}
	h := &sessionHandle{inbox: act.inbox, control: act.control, done: act.done}
	ttl := postTurnTTL
	if forRead && act.state == stateIdle {
		ttl = idleCacheTTL
	}
	s.mu.Lock()
	// Lost race: someone spawned while we loaded — keep the first winner.
	if ent, ok := s.resident[id]; ok {
		s.mu.Unlock()
		act.control <- shutdownMsg{}
		<-act.done
		if !forRead && ent.idleTTL == idleCacheTTL {
			ent.idleTTL = postTurnTTL
		}
		return spawnResult{Inbox: ent.handle.inbox, Control: ent.handle.control, Done: ent.handle.done}
	}
	s.resident[id] = &residentEntry{handle: h, idleTTL: ttl}
	n := len(s.resident)
	s.mu.Unlock()
	if n > maxResidentActors {
		go s.evictIdle(false)
	}
	return spawnResult{Inbox: h.inbox, Control: h.control, Done: h.done}
}

func (s *sessionSupervisor) emit(ev any) {
	if s.emitFn != nil {
		s.emitFn(ev)
	}
}

func (s *sessionSupervisor) onEvent(collection string) {
	if s.notifyFn != nil {
		s.notifyFn(collection)
	}
}

// evictIdle passivates idle residents past TTL (or all idle when force).
// Memory budget: over budget evicts oldest-idle first regardless of TTL.
func (s *sessionSupervisor) evictIdle(force bool) {
	type cand struct {
		id         string
		lastActive int64
		bytes      int64
	}
	now := time.Now().UnixMilli()
	var cands []cand
	var totalBytes int64
	s.mu.Lock()
	ids := make([]string, 0, len(s.resident))
	for id := range s.resident {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	reports := map[string]*watchdogReport{}
	for _, id := range ids {
		rep := s.ping(id)
		if rep == nil {
			continue // dead; watchdog round reaps it
		}
		reports[id] = rep
		totalBytes += rep.ResidentBytes
		if rep.State == stateIdle {
			cands = append(cands, cand{id: id, lastActive: rep.LastProgress, bytes: rep.ResidentBytes})
		}
	}
	overBudget := totalBytes > sessionMemoryBudget
	s.mu.Lock()
	ttls := map[string]time.Duration{}
	for id, ent := range s.resident {
		ttls[id] = ent.idleTTL
	}
	s.mu.Unlock()
	var evict []string
	if overBudget {
		// Oldest-idle first until under budget (bubble: simple sort).
		for i := 0; i < len(cands); i++ {
			for j := i + 1; j < len(cands); j++ {
				if cands[j].lastActive < cands[i].lastActive {
					cands[i], cands[j] = cands[j], cands[i]
				}
			}
		}
		for _, c := range cands {
			if totalBytes <= sessionMemoryBudget {
				break
			}
			evict = append(evict, c.id)
			totalBytes -= c.bytes
		}
	}
	for _, c := range cands {
		ttl := ttls[c.id]
		if force || now-c.lastActive > int64(ttl/time.Millisecond) {
			evict = append(evict, c.id)
		}
	}
	for _, id := range evict {
		s.passivate(id)
	}
}

// passivate commits the WAL and drops the actor from RAM. Next route
// re-spawns transparently from disk.
func (s *sessionSupervisor) passivate(id string) {
	s.mu.Lock()
	ent, ok := s.resident[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.resident, id)
	s.mu.Unlock()
	// Blocking send with watchdog timeout: a passivate swallowed by
	// `default` would orphan a live actor (goroutine + open WAL) that no
	// longer exists in the map — the exact leak class F4 calls out.
	// Control lane is drained continuously by a live actor, so 5s only
	// fires when it is truly wedged (then the watchdog reaps the handle,
	// which is already gone from the map — nothing more to do).
	select {
	case ent.handle.control <- passivateMsg{}:
	case <-time.After(5 * time.Second):
		fmt.Printf("[WARN] passivate %s: control lane stuck, actor orphaned (watchdog will reap)\n", id)
	}
}

// ping asks one resident for its watchdog report (nil = dead).
func (s *sessionSupervisor) ping(id string) *watchdogReport {
	s.mu.Lock()
	ent, ok := s.resident[id]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	reply := make(chan any, 1)
	select {
	case ent.handle.control <- watchdogPingMsg{Reply: reply}:
	case <-time.After(5 * time.Second):
		return nil
	}
	select {
	case r := <-reply:
		if rep, ok := r.(watchdogReport); ok {
			return &rep
		}
		return nil
	case <-time.After(5 * time.Second):
		return nil
	}
}

// watchdogRound implements the 3-level policy (plan §5.5): no reply → reap
// (next route respawns from disk/WAL); alive+stale+awaiting → normal;
// alive+stale+running → cancel (repeatedly, never reap: a live worker
// goroutine sharing the WAL must not be orphaned — see stale-running
// branch below).
func (s *sessionSupervisor) watchdogRound() {
	now := time.Now().UnixMilli()
	s.mu.Lock()
	ids := make([]string, 0, len(s.resident))
	for id := range s.resident {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		rep := s.ping(id)
		if rep == nil {
			// Wedged or gone: drop the handle; next route respawns.
			// (A truly wedged goroutine leaks — logged, unavoidable in Go.)
			fmt.Printf("[WARN] watchdog: session %s unresponsive, reaping handle\n", id)
			s.mu.Lock()
			delete(s.resident, id)
			s.mu.Unlock()
			continue
		}
		stale := now-rep.LastProgress > int64((2*15*time.Second)/time.Millisecond)
		if !stale {
			s.mu.Lock()
			if ent, ok := s.resident[id]; ok {
				ent.staleRounds = 0
			}
			s.mu.Unlock()
			continue
		}
		switch rep.State {
		case stateAwaitAppr, stateAwaitQ:
			// Waiting on a human: normal. The §8 timer bounds it.
		case stateRunning:
			s.mu.Lock()
			ent, ok := s.resident[id]
			if ok {
				ent.staleRounds++
			}
			s.mu.Unlock()
			if !ok {
				continue
			}
			if ent.staleRounds == 1 {
				select {
				case ent.handle.control <- cancelTurnMsg{Reason: "watchdog_stale"}:
				default:
				}
			} else {
				// Never reap while the worker goroutine may still be alive:
				// two actors sharing one WAL corrupts it. Keep cancelling
				// and wait for the worker exit (finishTurn → idle, which
				// clears staleness) instead of dropping the handle.
				fmt.Printf("[WARN] watchdog: session %s still stale after cancel, re-cancelling (no reap while worker may live)\n", id)
				select {
				case ent.handle.control <- cancelTurnMsg{Reason: "watchdog_stale_retry"}:
				default:
				}
			}
		}
	}
}

// shutdownAll commits every resident in parallel with a deadline, then returns.
func (s *sessionSupervisor) shutdownAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.resident))
	for id := range s.resident {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			s.mu.Lock()
			ent, ok := s.resident[id]
			s.mu.Unlock()
			if !ok {
				return
			}
			select {
			case ent.handle.control <- shutdownMsg{}:
			case <-time.After(5 * time.Second):
			}
		}(id)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		fmt.Printf("[WARN] session supervisor shutdown timed out\n")
	}
}

// turnResumeCandidate mirrors v1 turnResumeAbandoned (inverted): returns the
// WAL header + reopened append handle when the WAL holds an uncommitted
// turn worth resuming, else (nil, nil). Committed/abandoned WALs are removed
// by the caller path (committed) or left for the actor to discard.
func turnResumeCandidate(rec *SessionRecord, st *diskStore, id string) (*walHeader, *walWriter) {
	if _, err := os.Stat(filepath.Join(st.sessionsDir(), id+".wal.jsonl")); err != nil {
		return nil, nil
	}
	header, herr := st.readWALHeader(id)
	if herr != nil || header == nil || header.TurnIndex <= 0 {
		return nil, nil
	}
	if rec.TurnSeq > header.TurnIndex {
		return nil, nil
	}
	if rec.TurnSeq == header.TurnIndex && rec.Turn != nil &&
		(rec.Turn.Status == "completed" || rec.Turn.Status == "cancelled" || rec.Turn.Status == "cancelling") {
		_ = os.Remove(st.walPath(id))
		return nil, nil
	}
	for _, b := range rec.FileBalloons {
		if b.TurnIndex == header.TurnIndex {
			_ = os.Remove(st.walPath(id))
			return nil, nil
		}
	}
	hasMessages := false
	for _, m := range rec.Messages {
		if m.TurnIndex == header.TurnIndex {
			hasMessages = true
			break
		}
	}
	if !hasMessages && header.Prompt == "" && len(header.AttachmentIDs) == 0 {
		_ = os.Remove(st.walPath(id))
		return nil, nil
	}
	ww, werr := st.openWALAppend(id)
	if werr != nil {
		return nil, nil
	}
	return header, ww
}
