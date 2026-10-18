package imports

// SetFailHook makes every write of an apply call f first; an error from f
// fails that write (tests of rollback and skipping). It returns a function
// that removes the hook.
func SetFailHook(f func(item ImportItem) error) func() {
	failTestHook = f
	return func() { failTestHook = nil }
}
