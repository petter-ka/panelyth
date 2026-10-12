package rpc

import (
	"context"
	"encoding/json"
	"errors"
)

// ProtocolVersion is announced in the hello frame. Electron refuses to talk
// to a sidecar with a different version.
const ProtocolVersion = 1

// Frame type discriminators ("t" field).
const (
	typeRequest  = "req"
	typeCancel   = "cancel"
	typeResponse = "res"
	typeEvent    = "evt"
	typeHello    = "hello"
)

// ErrorCode is the stable, renderer-visible error category. Mirrors
// src/shared/contracts/src/errors.ts.
type ErrorCode string

const (
	CodeInvalidArgument    ErrorCode = "INVALID_ARGUMENT"
	CodeInvalidPath        ErrorCode = "INVALID_PATH"
	CodeNotFound           ErrorCode = "NOT_FOUND"
	CodePermissionDenied   ErrorCode = "PERMISSION_DENIED"
	CodeUnsupportedMedia   ErrorCode = "UNSUPPORTED_MEDIA"
	CodeCorruptMedia       ErrorCode = "CORRUPT_MEDIA"
	CodeCacheError         ErrorCode = "CACHE_ERROR"
	CodeDBError            ErrorCode = "DB_ERROR"
	CodeCancelled          ErrorCode = "CANCELLED"
	CodeBusy               ErrorCode = "BUSY"
	CodeTimeout            ErrorCode = "TIMEOUT"
	CodeSidecarUnavailable ErrorCode = "SIDECAR_UNAVAILABLE"
	CodeProtocolMismatch   ErrorCode = "PROTOCOL_MISMATCH"
	CodeMethodNotFound     ErrorCode = "METHOD_NOT_FOUND"
	CodeInternal           ErrorCode = "INTERNAL"
	// The image editor (Stage 12, ADR-0035).
	CodeEditTooLarge     ErrorCode = "EDIT_TOO_LARGE"
	CodeEditUnsupported  ErrorCode = "EDIT_UNSUPPORTED"
	CodeEditSessionGone  ErrorCode = "EDIT_SESSION_GONE"
	CodeTrashUnavailable ErrorCode = "TRASH_UNAVAILABLE"
	// CodeEditAssetInvalid: a file picked as a logo, mask or texture is not
	// a picture the editor can use (wrong type, too large, not a file).
	CodeEditAssetInvalid ErrorCode = "EDIT_ASSET_INVALID"
)

// Error is the explicit error envelope returned to callers.
type Error struct {
	Code      ErrorCode `json:"code"`
	Message   string    `json:"message"`
	Retryable bool      `json:"retryable"`
	Details   any       `json:"details,omitempty"`
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// Errorf-style constructor for handlers.
func NewError(code ErrorCode, message string) *Error {
	return &Error{Code: code, Message: message, Retryable: code == CodeBusy || code == CodeTimeout}
}

// toError maps any handler error onto the envelope.
func toError(err error) *Error {
	var rpcErr *Error
	switch {
	case errors.As(err, &rpcErr):
		return rpcErr
	case errors.Is(err, context.Canceled):
		return NewError(CodeCancelled, "request cancelled")
	case errors.Is(err, context.DeadlineExceeded):
		return NewError(CodeTimeout, "request deadline exceeded")
	default:
		return NewError(CodeInternal, err.Error())
	}
}

// inbound is any frame main sends to the sidecar.
type inbound struct {
	T          string          `json:"t"`
	ID         uint64          `json:"id"`
	M          string          `json:"m"`
	P          json.RawMessage `json:"p"`
	DeadlineMs int64           `json:"deadlineMs"`
}

type responseOK struct {
	T  string `json:"t"`
	ID uint64 `json:"id"`
	OK bool   `json:"ok"`
	R  any    `json:"r"`
}

type responseErr struct {
	T  string `json:"t"`
	ID uint64 `json:"id"`
	OK bool   `json:"ok"`
	E  *Error `json:"e"`
}

type eventFrame struct {
	T   string `json:"t"`
	Ch  string `json:"ch"`
	Seq uint64 `json:"seq"`
	P   any    `json:"p"`
}

// Hello is the first frame the sidecar writes.
type Hello struct {
	T          string `json:"t"`
	Protocol   int    `json:"protocol"`
	PID        int    `json:"pid"`
	Version    string `json:"version"`
	GoVersion  string `json:"goVersion"`
	CacheRoot  string `json:"cacheRoot"`
	ConfigRoot string `json:"configRoot"`
	// ThumbnailRoot is where Electron main resolves panelyth-thumb URLs.
	ThumbnailRoot string `json:"thumbnailRoot"`
}
