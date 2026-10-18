package password

import "testing"

func TestHashAndVerify(t *testing.T) {
	h, err := Hash("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := Verify("correct horse", h); err != nil || !ok {
		t.Fatalf("right password: ok=%v err=%v", ok, err)
	}
	if ok, _ := Verify("wrong horse", h); ok {
		t.Fatal("wrong password accepted")
	}
	if h2, _ := Hash("correct horse"); h2 == h {
		t.Fatal("hashes must be salted")
	}
	if _, err := Verify("x", "$bcrypt$whatever"); err == nil {
		t.Fatal("unknown format must fail")
	}
}
