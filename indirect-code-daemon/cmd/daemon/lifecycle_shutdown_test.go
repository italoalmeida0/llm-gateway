package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// isRevokedDialError: 401 (host deletado offline) mata o daemon; erro
// transitório (timeout/refused/500) mantém o backoff de reconexão.
func TestIsRevokedDialError(t *testing.T) {
	if !isRevokedDialError(&http.Response{StatusCode: 401}, nil) {
		t.Fatal("401 deve ser tratado como revogado")
	}
	if isRevokedDialError(nil, nil) {
		t.Fatal("nil não é revogado")
	}
	if isRevokedDialError(&http.Response{StatusCode: 500}, errors.New("connection refused")) {
		t.Fatal("500/refused não deve matar o daemon")
	}
	if isRevokedDialError(nil, errors.New("dial tcp: i/o timeout")) {
		t.Fatal("timeout não deve matar o daemon")
	}
	if !isRevokedDialError(nil, errors.New("websocket: bad handshake response code 401")) {
		t.Fatal("mensagem 401 deve ser tratada como revogada")
	}
}

// stopDaemonFromPidFile sem pidfile deve falhar (nada para matar).
func TestStopDaemonWithoutPidFile(t *testing.T) {
	if err := stopDaemonFromPidFile(t.TempDir()); err == nil {
		t.Fatal("sem daemon.pid deveria retornar erro")
	}
}

// performPairing com identidade anterior (hostId + daemonToken do
// config.json) deve provar a identidade no corpo do POST para o gateway
// reutilizar a mesma linha em vez de duplicar o host.
func TestPerformPairingSendsPreviousIdentity(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "hostId": "host_abc", "daemonToken": "dmt_new",
			"apiKey": "gw_x", "gatewayUrl": "http://gw",
		})
	}))
	defer srv.Close()

	d := &DaemonServer{
		dataDir:    t.TempDir(),
		configPath: t.TempDir() + "/config.json",
		config: &DaemonConfig{
			HostID: "host_abc", DaemonToken: "dmt_old",
			Settings: HarnessSettings{AutoCompactThreshold: 80},
		},
		sessions: map[string]*ActiveSession{},
	}
	if err := d.performPairing(srv.URL+"/api/indirect-code/connect/tok", "MyPC"); err != nil {
		t.Fatalf("performPairing: %v", err)
	}
	if got["hostId"] != "host_abc" || got["daemonToken"] != "dmt_old" {
		t.Fatalf("identidade anterior não enviada: %v", got)
	}
	if d.config.HostID != "host_abc" || d.config.DaemonToken != "dmt_new" {
		t.Fatalf("config não atualizada com token rotacionado: %+v", d.config)
	}
}

// performPairing sem config anterior não envia prova (fresh pair).
func TestPerformPairingWithoutPreviousIdentity(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "hostId": "host_new", "daemonToken": "dmt_1",
			"apiKey": "gw_x", "gatewayUrl": "http://gw",
		})
	}))
	defer srv.Close()

	d := &DaemonServer{
		dataDir:    t.TempDir(),
		configPath: t.TempDir() + "/config.json",
		sessions:   map[string]*ActiveSession{},
	}
	if err := d.performPairing(srv.URL+"/api/indirect-code/connect/tok", ""); err != nil {
		t.Fatalf("performPairing: %v", err)
	}
	if _, ok := got["hostId"]; ok {
		t.Fatalf("fresh pair não deveria enviar hostId: %v", got)
	}
	if _, ok := got["daemonToken"]; ok {
		t.Fatalf("fresh pair não deveria enviar daemonToken: %v", got)
	}
}
