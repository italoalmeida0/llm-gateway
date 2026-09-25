package main

import "llm-gateway/indirect-code-daemon/packages/processutil"

func pidAlive(n int) bool { return processutil.Alive(n) }
