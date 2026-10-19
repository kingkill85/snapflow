package installation

import (
	"time"

	"github.com/google/uuid"
)

// DocumentActions are what the caller may do with a generated document.
type DocumentActions struct {
	Delete bool `json:"delete" doc:"projects.delete"`
}

// GeneratedDocument is a generated installation manual or channel labels
// document (immutable).
type GeneratedDocument struct {
	ID            uuid.UUID       `json:"id"`
	VersionID     uuid.UUID       `json:"versionId"`
	Kind          string          `json:"kind" enum:"installation_manual,channel_labels"`
	Number        string          `json:"number" example:"2026-0007-V2-IM01" doc:"<project number>-<version name>-<IM|LB><sequence per version and kind>"`
	Sequence      int32           `json:"sequence"`
	Exporter      string          `json:"exporter" example:"docx"`
	Language      string          `json:"language" example:"de" doc:"The project's language when it was generated"`
	FileName      string          `json:"fileName" example:"2026-0007-V2-IM01 Villa Sommer.docx"`
	DownloadURL   string          `json:"downloadUrl" doc:"GET it to download the file"`
	CreatedBy     *uuid.UUID      `json:"createdBy,omitempty"`
	CreatedByName string          `json:"createdByName,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	Can           DocumentActions `json:"can"`
}

// DocumentInput asks for a document.
type DocumentInput struct {
	Kind string `json:"kind" enum:"installation_manual,channel_labels"`
}
