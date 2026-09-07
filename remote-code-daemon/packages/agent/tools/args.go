package tools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// unmarshalArgs decodes tool arguments tolerantly.
//
// Background: some models emit JSON numbers with a decimal point for
// integer fields (e.g. {"depth": 2.0} instead of {"depth": 2}).
// encoding/json rejects that with "cannot unmarshal number 2.0 into
// Go struct field ... of type int", surfacing as a confusing
// "invalid args" tool error. This helper normalizes whole-number
// floats (2.0, "2", 2) into ints before decoding into the target
// struct, so tools keep working regardless of how the model formats
// the number.
//
// Rules:
//   - whole floats (2.0) decode as the int value;
//   - fractional floats (2.5) are rejected with a clear error;
//   - null/absent fields keep their zero value (omitempty-safe);
//   - unknown fields are ignored (same as json.Unmarshal).
func unmarshalArgs(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fmt.Errorf("empty args")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return err
	}
	normalizeNumbers(v)
	fixed, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(fixed, target); err != nil {
		return err
	}
	return nil
}

// normalizeNumbers walks a decoded JSON value and rewrites json.Number
// nodes that represent whole numbers into int64, so a later unmarshal
// into int/int64 fields succeeds. Fractional numbers are left untouched
// so the final unmarshal reports a clear type error. Strings are never
// touched: a genuine string field (e.g. path "2") must not be coerced.
func normalizeNumbers(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			switch n := e.(type) {
			case json.Number:
				if i, ok := coerceWholeNumber(n.String()); ok {
					t[k] = i
				}
			case map[string]any, []any:
				normalizeNumbers(e)
			}
		}
	case []any:
		for i, e := range t {
			switch n := e.(type) {
			case json.Number:
				if iv, ok := coerceWholeNumber(n.String()); ok {
					t[i] = iv
				}
			case map[string]any, []any:
				normalizeNumbers(e)
			}
		}
	}
}

// coerceWholeNumber accepts "2", "2.0", 2e0 style inputs and returns
// the int64 value. It rejects fractional values ("2.5"), NaN/Inf,
// empty strings and out-of-range values (ok=false, caller keeps the
// original so the final unmarshal reports the type error).
func coerceWholeNumber(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i, true
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	if math.Trunc(f) != f {
		return 0, false
	}
	if f > math.MaxInt64 || f < math.MinInt64 {
		return 0, false
	}
	return int64(f), true
}
