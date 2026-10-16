package git

import (
	"os"
	"path/filepath"
	"strings"
)

// Repo is a working tree found from a folder in it.
type Repo struct {
	// Root is the working tree's top folder; GitDir its Git folder (".git",
	// or where a ".git" file points for worktrees and submodules).
	Root   string
	GitDir string
}

// FindRepo walks up from dir to the first folder holding ".git" (a folder,
// or a file naming the Git folder). It starts no process: a folder outside
// any repository costs a few stats. A folder inside ".git" itself is not in
// a working tree.
func FindRepo(dir string) (Repo, bool) {
	dir = filepath.Clean(dir)
	for {
		if filepath.Base(dir) == ".git" {
			return Repo{}, false
		}
		dotGit := filepath.Join(dir, ".git")
		if fi, err := os.Stat(dotGit); err == nil {
			if fi.IsDir() {
				if isGitDir(dotGit) {
					return Repo{Root: dir, GitDir: dotGit}, true
				}
			} else if gd := gitDirFile(dotGit); gd != "" {
				return Repo{Root: dir, GitDir: gd}, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return Repo{}, false
		}
		dir = parent
	}
}

// isGitDir tells a Git folder from a folder that is merely named ".git".
func isGitDir(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "HEAD"))
	return err == nil
}

// gitDirFile reads a ".git" file ("gitdir: <path>"), relative to its folder.
func gitDirFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 4096 {
		return ""
	}
	rest, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
	if !ok {
		return ""
	}
	gd := strings.TrimSpace(rest)
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(filepath.Dir(path), gd)
	}
	if !isGitDir(gd) {
		return ""
	}
	return filepath.Clean(gd)
}

// Operation is what the repository is in the middle of, from the files Git
// leaves in its folder; "" when nothing.
func (r Repo) Operation() string {
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(r.GitDir, name))
		return err == nil
	}
	switch {
	case exists("rebase-merge"), exists("rebase-apply"):
		return "rebasing"
	case exists("MERGE_HEAD"):
		return "merging"
	case exists("CHERRY_PICK_HEAD"):
		return "cherryPicking"
	case exists("REVERT_HEAD"):
		return "reverting"
	case exists("BISECT_LOG"):
		return "bisecting"
	}
	return ""
}

// Rel is dir relative to the working tree, with forward slashes; "" for the
// top folder. ok is false when dir is not inside it.
func (r Repo) Rel(dir string) (string, bool) {
	rel, err := filepath.Rel(r.Root, filepath.Clean(dir))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	return filepath.ToSlash(rel), true
}
