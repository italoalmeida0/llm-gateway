package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"time"
)

const workerHealthDeadline = 2 * time.Minute

var parentHealthAddress, parentHealthToken string

type workerHealthReport struct {
	Token       string `json:"token"`
	PID         int    `json:"pid"`
	Healthy     bool   `json:"healthy"`
	PairingWait bool   `json:"pairingWait,omitempty"`
}

// Read once and remove before tools inherit the worker's environment.
func captureParentHealth() {
	parentHealthAddress = os.Getenv("LLMGW_PARENT_HEALTH_ADDRESS")
	parentHealthToken = os.Getenv("LLMGW_PARENT_HEALTH_TOKEN")
	_ = os.Unsetenv("LLMGW_PARENT_HEALTH_ADDRESS")
	_ = os.Unsetenv("LLMGW_PARENT_HEALTH_TOKEN")
}

func reportParentHealth(healthy bool) { sendParentHealth(workerHealthReport{Healthy: healthy}) }

func sendParentHealth(report workerHealthReport) {
	if parentHealthAddress == "" {
		return
	}
	c, err := net.DialTimeout("tcp", parentHealthAddress, time.Second)
	if err != nil {
		return
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(time.Second))
	report.Token, report.PID = parentHealthToken, os.Getpid()
	_ = json.NewEncoder(c).Encode(report)
}

// The boot process owns the final deadline. A frozen worker cannot keep itself
// alive by stopping its own watchdog. Only completed healthy rounds reset it.
func watchWorkerHealth(ln net.Listener, token string, cmd *exec.Cmd, done <-chan struct{}, deadline time.Duration) {
	healthy := make(chan time.Duration, 1)
	go func() {
		pairingAllowed := true
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.SetDeadline(time.Now().Add(time.Second))
			var r workerHealthReport
			err = json.NewDecoder(c).Decode(&r)
			_ = c.Close()
			if err == nil && r.Token == token && r.PID == cmd.Process.Pid {
				extension := deadline
				if r.PairingWait && pairingAllowed {
					extension = 15 * time.Minute
				} else if !r.Healthy {
					continue
				}
				pairingAllowed = false
				select {
				case healthy <- extension:
				default:
				}
			}
		}
	}()
	defer ln.Close()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return
		case extension := <-healthy:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(extension)
		case <-timer.C:
			fmt.Fprintln(os.Stderr, "[WARN] worker health deadline exceeded; replacing worker")
			// Kill this exact child handle only. Independent runners survive.
			_ = cmd.Process.Kill()
			return
		}
	}
}
