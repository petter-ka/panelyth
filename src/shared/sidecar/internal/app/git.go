package app

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"

	"panelyth/sidecar/internal/git"
	"panelyth/sidecar/internal/rpc"
)

// Git in the commander (ADR-0043). Wire types mirror
// src/shared/contracts/src/rpc.ts.

const evGitProgress = "git.progress"

// Limits of Git requests.
const (
	// MaxGitChanges caps the change list the commit dialog shows.
	MaxGitChanges = 2000
	// MaxGitPaths caps the paths of one run.
	MaxGitPaths = 10_000
	// MaxCommitMessage bounds a commit message.
	MaxCommitMessage = 64 << 10
)

type (
	gitDirParams struct {
		DirID int64 `json:"dirId"`
		// Force reads the status again instead of a recent one.
		Force bool `json:"force"`
	}
	gitProblem struct {
		Message string `json:"message"`
		Reason  string `json:"reason"`
	}
	gitRepoWire struct {
		RepoID int64  `json:"repoId"`
		Root   string `json:"root"`
		Name   string `json:"name"`
		// Rel is the panel's folder inside the working tree ("" at the top).
		Rel       string     `json:"rel"`
		Branch    string     `json:"branch"`
		Head      string     `json:"head"`
		Unborn    bool       `json:"unborn"`
		Upstream  string     `json:"upstream"`
		Ahead     int        `json:"ahead"`
		Behind    int        `json:"behind"`
		Stashes   int        `json:"stashes"`
		Operation string     `json:"operation"`
		Counts    git.Counts `json:"counts"`
	}
	gitStatusResult struct {
		// Available: Git was found; without it there is no Git UI.
		Available bool         `json:"available"`
		Repo      *gitRepoWire `json:"repo"`
		Marks     []git.Mark   `json:"marks"`
		Inherited git.State    `json:"inherited"`
		Truncated bool         `json:"truncated"`
		// Problem: the folder is in a repository whose status Git would not give.
		Problem *gitProblem `json:"problem"`
	}
	gitChangeWire struct {
		Path     string    `json:"path"`
		Orig     string    `json:"orig"`
		State    git.State `json:"state"`
		Staged   bool      `json:"staged"`
		Unstaged bool      `json:"unstaged"`
	}
	gitChangesResult struct {
		ChangesID int64           `json:"changesId"`
		Entries   []gitChangeWire `json:"entries"`
		Truncated bool            `json:"truncated"`
	}
	gitRunParams struct {
		DirID int64  `json:"dirId"`
		Op    git.Op `json:"op"`
		// The paths: a selection of the panel, or rows of a change list.
		Selection *selectionWire `json:"selection"`
		ChangesID int64          `json:"changesId"`
		Items     []int          `json:"items"`
		Message   string         `json:"message"`
		Amend     bool           `json:"amend"`
		StageAll  bool           `json:"stageAll"`
		Push      bool           `json:"push"`
		Mode      git.PullMode   `json:"mode"`
		Branch    string         `json:"branch"`
	}
	gitRunResult struct {
		OpID int64 `json:"opId"`
	}
	gitCancelParams struct {
		OpID int64 `json:"opId"`
	}
	gitCancelResult struct {
		Cancelled bool `json:"cancelled"`
	}
	gitBranchesResult struct {
		Branches  []git.Branch `json:"branches"`
		Truncated bool         `json:"truncated"`
	}
	gitLogParams struct {
		DirID int64 `json:"dirId"`
		Limit int   `json:"limit"`
	}
	gitLogResult struct {
		Entries []git.LogEntry `json:"entries"`
	}
)

func (s *indexService) registerGit(srv *rpc.Server) {
	rpc.Register(srv, "git.status", s.gitStatus)
	rpc.Register(srv, "git.changes", s.gitChanges)
	rpc.Register(srv, "git.run", s.gitRun)
	rpc.Register(srv, "git.cancel", func(_ context.Context, p gitCancelParams) (gitCancelResult, error) {
		return gitCancelResult{Cancelled: s.git != nil && s.git.Cancel(p.OpID)}, nil
	})
	rpc.Register(srv, "git.branches", s.gitBranches)
	rpc.Register(srv, "git.log", s.gitLog)
}

func (s *indexService) emitGit(r git.Report) {
	s.events.Post(evGitProgress, strconv.FormatInt(r.OpID, 10), r)
}

func (s *indexService) gitAvailable() bool { return s.git != nil && s.git.Available() }

// gitRepoOf finds the repository of an indexed folder.
func (s *indexService) gitRepoOf(ctx context.Context, dirID int64) (git.Repo, string, bool, error) {
	dir, err := s.dirPath(ctx, dirID)
	if err != nil {
		return git.Repo{}, "", false, err
	}
	repo, ok := git.FindRepo(dir)
	if !ok {
		return git.Repo{}, "", false, nil
	}
	rel, _ := repo.Rel(dir)
	return repo, rel, true, nil
}

// gitRepoIn is gitRepoOf for methods that need a repository.
func (s *indexService) gitRepoIn(ctx context.Context, dirID int64) (git.Repo, error) {
	if !s.gitAvailable() {
		return git.Repo{}, rpc.NewError(rpc.CodeUnsupportedMedia, "Git was not found on this computer.")
	}
	repo, _, ok, err := s.gitRepoOf(ctx, dirID)
	if err != nil {
		return repo, err
	}
	if !ok {
		return repo, rpc.NewError(rpc.CodeNotFound, "This folder is not in a Git repository.")
	}
	return repo, nil
}

func gitError(err error) error {
	var ge *git.Error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, git.ErrBusy):
		return rpc.NewError(rpc.CodeBusy, "Another Git operation is running in this repository.")
	case errors.Is(err, git.ErrStaleChanges):
		return rpc.NewError(rpc.CodeInvalidArgument, "The list of changes is out of date; open it again.")
	case errors.Is(err, git.ErrTooLarge):
		return rpc.NewError(rpc.CodeInvalidArgument, "This repository has too many changes to show.")
	case errors.As(err, &ge):
		e := rpc.NewError(rpc.CodeInvalidArgument, ge.Message)
		if ge.Reason != "" {
			e.Details = map[string]string{"reason": ge.Reason}
		}
		return e
	}
	return rpc.NewError(rpc.CodeInternal, err.Error())
}

func (s *indexService) gitStatus(ctx context.Context, p gitDirParams) (gitStatusResult, error) {
	res := gitStatusResult{Available: s.gitAvailable(), Marks: []git.Mark{}}
	if !res.Available {
		return res, nil
	}
	repo, rel, ok, err := s.gitRepoOf(ctx, p.DirID)
	if err != nil || !ok {
		return res, err
	}
	w := &gitRepoWire{RepoID: s.git.RepoID(repo.Root), Root: repo.Root, Name: filepath.Base(repo.Root), Rel: rel,
		Operation: repo.Operation()}
	res.Repo = w
	st, err := s.git.Status(ctx, repo.Root, p.Force)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return res, err
		}
		prob := &gitProblem{Message: err.Error()}
		var ge *git.Error
		if errors.As(err, &ge) {
			prob.Reason = ge.Reason
		}
		res.Problem = prob
		return res, nil
	}
	w.Branch, w.Head, w.Unborn, w.Upstream = st.Branch, st.Head, st.Unborn, st.Upstream
	w.Ahead, w.Behind, w.Stashes, w.Counts = st.Ahead, st.Behind, st.Stashes, st.Counts()
	f := st.ForFolder(rel)
	if f.Marks != nil {
		res.Marks = f.Marks
	}
	res.Inherited, res.Truncated = f.Inherited, f.Truncated
	return res, nil
}

func (s *indexService) gitChanges(ctx context.Context, p gitDirParams) (gitChangesResult, error) {
	repo, err := s.gitRepoIn(ctx, p.DirID)
	if err != nil {
		return gitChangesResult{}, err
	}
	st, err := s.git.Status(ctx, repo.Root, true)
	if err != nil {
		return gitChangesResult{}, gitError(err)
	}
	res := gitChangesResult{Entries: []gitChangeWire{}}
	kept := make([]git.Entry, 0, min(len(st.Entries), MaxGitChanges))
	for _, e := range st.Entries {
		if e.State == git.Ignored {
			continue
		}
		if len(kept) == MaxGitChanges {
			res.Truncated = true
			break
		}
		kept = append(kept, e)
		res.Entries = append(res.Entries, gitChangeWire{Path: e.Path, Orig: e.Orig, State: e.State,
			Staged: e.Staged, Unstaged: e.Unstaged})
	}
	res.ChangesID = s.git.SaveChanges(repo.Root, kept)
	return res, nil
}

func (s *indexService) gitRun(ctx context.Context, p gitRunParams) (gitRunResult, error) {
	if !git.ValidOp(p.Op) {
		return gitRunResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown Git operation")
	}
	if len(p.Message) > MaxCommitMessage || len(p.Branch) > 250 || len(p.Items) > MaxGitPaths {
		return gitRunResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the request is too large")
	}
	repo, err := s.gitRepoIn(ctx, p.DirID)
	if err != nil {
		return gitRunResult{}, err
	}
	req := git.Request{Op: p.Op, Message: p.Message, Amend: p.Amend, StageAll: p.StageAll, Push: p.Push,
		Mode: p.Mode, Branch: strings.TrimSpace(p.Branch)}
	switch p.Op {
	case git.OpStage, git.OpUnstage, git.OpDiscard:
		if req.Paths, err = s.gitPaths(ctx, repo, p); err != nil {
			return gitRunResult{}, err
		}
		if len(req.Paths) == 0 {
			return gitRunResult{}, rpc.NewError(rpc.CodeInvalidArgument, "Nothing to do: no files of this repository were chosen.")
		}
	case git.OpPull:
		if req.Mode == "" {
			req.Mode = git.PullFastForward
		}
		if req.Mode != git.PullFastForward && req.Mode != git.PullRebase && req.Mode != git.PullMerge {
			return gitRunResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown pull mode")
		}
	case git.OpSwitch, git.OpCreateBranch:
		if req.Branch == "" || strings.HasPrefix(req.Branch, "-") {
			return gitRunResult{}, rpc.NewError(rpc.CodeInvalidArgument, "That is not a valid branch name.")
		}
	}
	id, err := s.git.Start(repo.Root, req)
	if err != nil {
		return gitRunResult{}, gitError(err)
	}
	return gitRunResult{OpID: id}, nil
}

// gitPaths are a run's paths relative to the working tree: entries of the
// panel's selection inside the repository, or rows of a change list.
func (s *indexService) gitPaths(ctx context.Context, repo git.Repo, p gitRunParams) ([]string, error) {
	if p.ChangesID != 0 {
		entries, err := s.git.Changes(p.ChangesID, repo.Root, p.Items)
		if err != nil {
			return nil, gitError(err)
		}
		var out []string
		for _, e := range entries {
			out = append(out, strings.TrimSuffix(e.Path, "/"))
			// Staging a rename stages its source's deletion too.
			if e.Orig != "" && p.Op == git.OpStage {
				out = append(out, e.Orig)
			}
		}
		return out, nil
	}
	if p.Selection == nil {
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "choose the files first")
	}
	ids, err := s.resolveSelection(*p.Selection)
	if err != nil {
		return nil, err
	}
	if len(ids) > MaxGitPaths {
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "Too many files for one Git operation.")
	}
	paths, err := s.store.EntryPaths(ctx, ids)
	if err != nil {
		return nil, dbError(err)
	}
	out := make([]string, 0, len(paths))
	for _, ep := range paths {
		if rel, ok := repo.Rel(ep.Path); ok && rel != "" && rel != ".git" && !strings.HasPrefix(rel, ".git/") {
			out = append(out, rel)
		}
	}
	return out, nil
}

func (s *indexService) gitBranches(ctx context.Context, p gitDirParams) (gitBranchesResult, error) {
	repo, err := s.gitRepoIn(ctx, p.DirID)
	if err != nil {
		return gitBranchesResult{}, err
	}
	branches, truncated, err := s.git.Branches(ctx, repo.Root)
	if err != nil {
		return gitBranchesResult{}, gitError(err)
	}
	if branches == nil {
		branches = []git.Branch{}
	}
	return gitBranchesResult{Branches: branches, Truncated: truncated}, nil
}

func (s *indexService) gitLog(ctx context.Context, p gitLogParams) (gitLogResult, error) {
	repo, err := s.gitRepoIn(ctx, p.DirID)
	if err != nil {
		return gitLogResult{}, err
	}
	entries, err := s.git.Log(ctx, repo.Root, p.Limit)
	if err != nil {
		return gitLogResult{}, gitError(err)
	}
	if entries == nil {
		entries = []git.LogEntry{}
	}
	return gitLogResult{Entries: entries}, nil
}
