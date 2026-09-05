package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	xaiClientID = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiScope    = "openid profile email offline_access grok-cli:access api:access"
)

var (
	xaiDeviceCodeURL = "https://auth.x.ai/oauth2/device/code"
	xaiTokenURL      = "https://auth.x.ai/oauth2/token"
)

type XAIDeviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func RequestXAIDeviceAuthorization(ctx context.Context) (XAIDeviceAuthorization, error) {
	values := url.Values{"client_id": {xaiClientID}, "scope": {xaiScope}}
	var out XAIDeviceAuthorization
	if err := postXAIForm(ctx, xaiDeviceCodeURL, values, &out); err != nil {
		return out, fmt.Errorf("xai device authorization: %w", err)
	}
	if out.DeviceCode == "" || out.UserCode == "" || out.VerificationURI == "" || out.ExpiresIn <= 0 {
		return out, fmt.Errorf("xai device authorization: incomplete response")
	}
	verificationURL := out.VerificationURIComplete
	if verificationURL == "" {
		verificationURL = out.VerificationURI
	}
	u, err := url.Parse(verificationURL)
	if err != nil || u.Scheme != "https" {
		return out, fmt.Errorf("xai device authorization: untrusted verification uri")
	}
	if out.VerificationURIComplete == "" {
		q := u.Query()
		q.Set("user_code", out.UserCode)
		u.RawQuery = q.Encode()
		out.VerificationURIComplete = u.String()
	}
	return out, nil
}

func PollXAIDeviceToken(ctx context.Context, dev XAIDeviceAuthorization) (*OAuthToken, error) {
	interval := time.Duration(dev.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	deadline := time.NewTimer(time.Duration(dev.ExpiresIn) * time.Second)
	defer deadline.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("xai device code expired")
		case <-time.After(interval):
		}

		values := url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"client_id":   {xaiClientID},
			"device_code": {dev.DeviceCode},
		}
		tok, retry, nextInterval, err := requestXAIToken(ctx, values, "")
		if err != nil {
			return nil, err
		}
		if tok != nil {
			return tok, nil
		}
		if !retry {
			return nil, fmt.Errorf("xai device authorization failed")
		}
		if nextInterval > 0 {
			interval = nextInterval
		}
	}
}

func RefreshXAIToken(ctx context.Context, refreshToken string) (*OAuthToken, error) {
	values := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {xaiClientID},
		"refresh_token": {refreshToken},
	}
	tok, _, _, err := requestXAIToken(ctx, values, refreshToken)
	return tok, err
}

func requestXAIToken(ctx context.Context, values url.Values, previousRefresh string) (*OAuthToken, bool, time.Duration, error) {
	var body struct {
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		TokenType        string `json:"token_type"`
		Scope            string `json:"scope"`
		ExpiresIn        int    `json:"expires_in"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		Interval         int    `json:"interval"`
	}
	status, err := postXAIFormStatus(ctx, xaiTokenURL, values, &body)
	if err != nil {
		return nil, false, 0, fmt.Errorf("xai token request: %w", err)
	}
	if status >= 200 && status < 300 && body.AccessToken != "" {
		if body.RefreshToken == "" {
			body.RefreshToken = previousRefresh
		}
		expires := body.ExpiresIn
		if expires <= 0 {
			expires = 3600
		}
		return &OAuthToken{
			AccessToken: body.AccessToken, RefreshToken: body.RefreshToken,
			TokenType: body.TokenType, Scope: body.Scope,
			Expiry:   time.Now().Add(time.Duration(expires)*time.Second - 5*time.Minute),
			ClientID: xaiClientID,
		}, false, 0, nil
	}
	switch body.Error {
	case "authorization_pending":
		return nil, true, 0, nil
	case "slow_down":
		return nil, true, time.Duration(body.Interval) * time.Second, nil
	case "access_denied", "authorization_denied":
		return nil, false, 0, fmt.Errorf("xai device authorization was denied")
	case "expired_token":
		return nil, false, 0, fmt.Errorf("xai device code expired")
	default:
		detail := strings.TrimSpace(strings.Join([]string{body.Error, body.ErrorDescription}, ": "))
		if detail == "" {
			detail = http.StatusText(status)
		}
		return nil, false, 0, fmt.Errorf("xai oauth http %d: %s", status, detail)
	}
}

func postXAIForm(ctx context.Context, endpoint string, values url.Values, out any) error {
	status, err := postXAIFormStatus(ctx, endpoint, values, out)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("http %d", status)
	}
	return nil
}

func postXAIFormStatus(ctx context.Context, endpoint string, values url.Values, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return resp.StatusCode, fmt.Errorf("invalid json: %w", err)
	}
	return resp.StatusCode, nil
}
