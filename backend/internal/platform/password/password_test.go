package password

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHashAndVerify(t *testing.T) {
	ctx := context.Background()
	h, err := Hash(ctx, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := Verify(ctx, "correct horse", h); err != nil || !ok {
		t.Fatalf("right password: ok=%v err=%v", ok, err)
	}
	if ok, _ := Verify(ctx, "wrong horse", h); ok {
		t.Fatal("wrong password accepted")
	}
	if h2, _ := Hash(ctx, "correct horse"); h2 == h {
		t.Fatal("hashes must be salted")
	}
	if _, err := Verify(ctx, "x", "$bcrypt$whatever"); err == nil {
		t.Fatal("unknown format must fail")
	}
}

func TestBusy(t *testing.T) {
	ctx := context.Background()
	h, err := Hash(ctx, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	defer func(w time.Duration) { slotWait = w }(slotWait)
	slotWait = 10 * time.Millisecond
	for range cap(slots) {
		slots <- struct{}{}
	}
	_, hashErr := Hash(ctx, "x")
	_, verifyErr := Verify(ctx, "correct horse", h)
	for range cap(slots) {
		<-slots
	}
	if !errors.Is(hashErr, ErrBusy) || !errors.Is(verifyErr, ErrBusy) {
		t.Fatalf("all slots taken: hash=%v verify=%v", hashErr, verifyErr)
	}
	if ok, err := Verify(ctx, "correct horse", h); err != nil || !ok {
		t.Fatalf("after release: ok=%v err=%v", ok, err)
	}
}
