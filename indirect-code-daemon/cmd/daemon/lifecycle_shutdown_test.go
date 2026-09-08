package main

import (
	"errors"
	"net/http"
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
