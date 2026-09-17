package main

import "testing"

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.2.3", "v1.2.3", 0},
		{"v1.2.4", "v1.2.3", 1},
		{"v1.2.3", "v1.2.4", -1},
		{"v1.10.0", "v1.9.9", 1},
		{"v2.0", "v1.99.99", 1},
		{"latest", "v0.0.1", -1},
		{"v0.0.1", "latest", 1},
		{"20260917-1314", "20260916-0000", 1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Fatalf("compareVersions(%q,%q) = %d; want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestNewestStaged(t *testing.T) {
	dir := t.TempDir()
	mk := func(ver string) {
		p := dir + "/bin/daemon-" + ver
		mustMkdirAll(p)
		mustWriteFile(p+"/"+daemonAssetName(), "x")
	}
	mk("v1.0.0")
	mk("v1.2.0")
	mk("v0.9.9")
	if got := newestStaged(dir + "/bin"); got == "" {
		t.Fatal("no staged found")
	} else if want := dir + "/bin/daemon-v1.2.0/" + daemonAssetName(); got != want {
		t.Fatalf("newest = %q; want %q", got, want)
	}
	if newestStaged(t.TempDir()) != "" {
		t.Fatal("empty dir must yield nothing")
	}
}
