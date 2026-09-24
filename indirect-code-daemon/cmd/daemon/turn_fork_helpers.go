package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func copyForkAttachment(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func forkContentPaths(content []provider.Content, paths map[string]string) []provider.Content {
	for i, block := range content {
		switch b := block.(type) {
		case provider.TextBlock:
			for before, after := range paths {
				b.Text = strings.ReplaceAll(b.Text, before, after)
			}
			content[i] = b
		case provider.ToolResultBlock:
			b.Content = forkContentPaths(b.Content, paths)
			content[i] = b
		}
	}
	return content
}

func selectedAttachment(ids *[]string, id string) bool {
	if ids != nil {
		for _, candidate := range *ids {
			if candidate == id {
				return true
			}
		}
	}
	return false
}
