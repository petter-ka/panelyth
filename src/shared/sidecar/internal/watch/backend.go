package watch

// backend reports changes per watched directory: each value on changed is
// the path of a watched directory whose entries changed.
type backend interface {
	Add(dir string) error
	Remove(dir string) error
	Close() error
	changed() <-chan string
	errors() <-chan error
}
