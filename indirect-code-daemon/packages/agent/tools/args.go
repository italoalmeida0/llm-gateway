package tools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
)

// unmarshalArgs decodes tool arguments tolerantly.
//
// Background: some models emit JSON numbers with a decimal point for
// integer fields (e.g. {"depth": 2.0} instead of {"depth": 2}), and some
// callers serialize ints as strings ({"limit": "6.0"}).
// encoding/json rejects both with "cannot unmarshal ... into Go struct
// field ... of type int", surfacing as a confusing "invalid args" tool
// error. This helper normalizes whole-number floats and whole-number
// strings into ints before decoding into the target struct, so tools keep
// working regardless of how the caller formats the number.
//
// Rules:
//   - whole floats (2.0) and whole-number strings ("2", "2.0") decode
//     as the int value — BUT only for fields the target struct declares
//     as numeric (checked via reflection); genuine string fields (path,
//     command, pattern...) are never touched;
//   - fractional values (2.5, "2.5") are rejected with a clear error;
//   - null/absent fields keep their zero value (omitempty-safe);
//   - unknown fields are ignored (same as json.Unmarshal).
//
// It also tolerates the mirror mistake for slices: some models emit a
// single value where an array is expected ({"include": "*.ts"} instead of
// {"include": ["*.ts"]}, or one edit object instead of an edits array), or
// wrap the whole array in a JSON string. Fields the target struct declares
// as slices are normalized: a lone value is wrapped into a one-element
// array and a string holding a JSON array is parsed.
func unmarshalArgs(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fmt.Errorf("empty args")
	}
	numericFields := numericFieldSet(target)
	sliceFields := sliceFieldSet(target)
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return err
	}
	normalizeNumbers(v, numericFields)
	normalizeSlices(v, sliceFields)
	fixed, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(fixed, target); err != nil {
		return err
	}
	return nil
}

// normalizeNumbers walks a decoded JSON value and rewrites whole-number
// json.Number nodes into int64, and whole-number strings into int64 — but
// ONLY for keys the target struct declares as numeric (numericFields holds
// the JSON field names of int/int64/float64 fields). Genuine string fields
// (path "2", todo id "1", command text...) are never touched, so "2"
// stays "2" where a string is expected. Unknown keys (absent from the
// struct) are left alone — the final unmarshal ignores them anyway.
func normalizeNumbers(v any, numericFields map[string]bool) {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			isNumericKey := numericFields[k]
			switch n := e.(type) {
			case json.Number:
				// Whole floats coerce everywhere (2.5 stays and errors
				// below); numeric strings only on numeric fields.
				if i, ok := coerceWholeNumber(n.String()); ok {
					t[k] = i
				}
			case string:
				if isNumericKey {
					if i, ok := coerceWholeNumber(n); ok {
						t[k] = i
					}
				}
			case map[string]any, []any:
				normalizeNumbers(e, numericFields)
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
				normalizeNumbers(e, numericFields)
			}
		}
	}
}

// numericFieldSet returns the JSON names of the target struct's numeric
// fields (int/int64/float64), so normalizeNumbers knows which string
// values are safe to coerce. Nested structs are flattened by JSON name —
// collisions fall back to "don't coerce" only when ambiguous, which in
// practice never happens (tool schemas don't reuse a name as both string
// and number). A nil/unknown target yields an empty set (floats still
// coerce; strings never do).
func numericFieldSet(target any) map[string]bool {
	out := map[string]bool{}
	collectNumericFields(reflect.TypeOf(target), out)
	return out
}

func collectNumericFields(t reflect.Type, out map[string]bool) {
	if t == nil {
		return
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue // unexported
		}
		tag := f.Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		if name == "-" {
			continue
		}
		ft := f.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		switch ft.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
			reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
			reflect.Float32, reflect.Float64:
			out[name] = true
		case reflect.Struct:
			collectNumericFields(ft, out)
		case reflect.Slice, reflect.Array:
			collectNumericFields(ft.Elem(), out)
		}
	}
}

// normalizeSlices rewrites values for slice-typed fields into arrays:
// a lone value (string or object) becomes a one-element array, and a
// string that holds a JSON array ("[\"a\",\"b\"]") is parsed into that
// array. Only keys the target struct declares as slices are touched, so
// genuine string fields are never wrapped. Values that cannot possibly
// decode (a non-JSON string for a struct-elem slice) are left alone so
// the final unmarshal reports the type error.
func normalizeSlices(v any, sliceFields map[string]bool) {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			if sliceFields[k] {
				switch n := e.(type) {
				case string:
					// "[...]" decodes as that array; "{...}" becomes a
					// one-element array of that object; anything else
					// ("*.ts") becomes a one-element array of the string.
					var parsed any
					if err := json.Unmarshal([]byte(n), &parsed); err == nil {
						switch p := parsed.(type) {
						case []any:
							t[k] = p
							normalizeNumbers(p, nil)
							normalizeSlices(p, sliceFields)
							continue
						case map[string]any:
							t[k] = []any{p}
							normalizeSlices(p, sliceFields)
							continue
						}
					}
					t[k] = []any{n}
				case map[string]any:
					t[k] = []any{n}
				case []any:
					normalizeNumbers(n, nil)
					normalizeSlices(n, sliceFields)
				}
				continue
			}
			switch n := e.(type) {
			case map[string]any, []any:
				normalizeSlices(n, sliceFields)
			}
		}
	case []any:
		for _, e := range t {
			switch n := e.(type) {
			case map[string]any, []any:
				normalizeSlices(n, sliceFields)
			}
		}
	}
}

// sliceFieldSet returns the JSON names of the target struct's slice
// fields (any element type), so normalizeSlices knows which lone values
// are safe to wrap into arrays. Nested structs are flattened by JSON
// name, mirroring collectNumericFields.
func sliceFieldSet(target any) map[string]bool {
	out := map[string]bool{}
	collectSliceFields(reflect.TypeOf(target), out)
	return out
}

func collectSliceFields(t reflect.Type, out map[string]bool) {
	if t == nil {
		return
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue // unexported
		}
		tag := f.Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		if name == "-" {
			continue
		}
		ft := f.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		switch ft.Kind() {
		case reflect.Slice:
			out[name] = true
			collectSliceFields(ft.Elem(), out)
		case reflect.Struct:
			collectSliceFields(ft, out)
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
