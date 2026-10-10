package provider

import (
	"crypto/tls"
	"net/http"
	"net/url"
)

// NewHTTPClient returns a provider HTTP client. When insecureTLS is true,
// only this client skips TLS certificate verification. The process-wide
// default transport is left untouched so auth, discovery, and other providers
// keep normal certificate validation.
func NewHTTPClient(insecureTLS bool) *http.Client {
	return NewHTTPClientWithProxy(insecureTLS, "")
}

// NewHTTPClientWithProxy is NewHTTPClient plus an explicit upstream proxy.
// An empty proxy keeps the default environment-based proxy resolution
// (HTTP(S)_PROXY). A malformed proxy URL falls back to the default behavior
// instead of failing the turn.
func NewHTTPClientWithProxy(insecureTLS bool, proxyURL string) *http.Client {
	if !insecureTLS && proxyURL == "" {
		return &http.Client{Timeout: 0}
	}
	tr, ok := http.DefaultTransport.(*http.Transport)
	if ok {
		tr = tr.Clone()
	} else {
		tr = &http.Transport{}
	}
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil {
			tr.Proxy = http.ProxyURL(u)
		}
	}
	if !insecureTLS {
		return &http.Client{Timeout: 0, Transport: tr}
	}
	if tr.TLSClientConfig != nil {
		tr.TLSClientConfig = tr.TLSClientConfig.Clone()
	} else {
		tr.TLSClientConfig = &tls.Config{}
	}
	tr.TLSClientConfig.InsecureSkipVerify = true //nolint:gosec
	return &http.Client{Timeout: 0, Transport: tr}
}

// WithHTTPClient scopes an HTTP client to a concrete provider client.
// Unsupported clients are returned unchanged.
func WithHTTPClient(c Client, httpClient *http.Client) Client {
	if httpClient == nil {
		return c
	}
	if v, ok := c.(*anthropicClient); ok {
		v.http = httpClient
	}
	return c
}
