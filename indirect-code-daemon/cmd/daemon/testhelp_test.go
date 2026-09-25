package main

import "os"

func mustMkdirAll(p string) {
	if err := os.MkdirAll(p, 0o700); err != nil {
		panic(err)
	}
}

func mustWriteFile(p, s string) {
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		panic(err)
	}
}
