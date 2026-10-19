package proposals

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// ProposalProductType names the product type of a split proposal.
type ProposalProductType struct {
	ID   uuid.UUID `json:"id"`
	Name i18n.Text `json:"name"`
}

// NullableProposalProductType may be null (the combined proposal, D245).
type NullableProposalProductType struct {
	_ struct{} `nullable:"true"`
	ProposalProductType
}

// ProposalActions are what the caller may do with a proposal.
type ProposalActions struct {
	Delete bool `json:"delete" doc:"projects.delete"`
}

// Proposal is a generated proposal document (immutable).
type Proposal struct {
	ID            uuid.UUID                    `json:"id"`
	VersionID     uuid.UUID                    `json:"versionId"`
	Number        string                       `json:"number" example:"2026-0007-V2-03" doc:"<project number>-<version name>-<sequence>; split documents add the product type abbreviation"`
	Sequence      int32                        `json:"sequence" doc:"Per version; the documents of one split run share it"`
	Exporter      string                       `json:"exporter" example:"docx"`
	Language      string                       `json:"language" example:"de" doc:"The project's language when it was generated"`
	ProductType   *NullableProposalProductType `json:"productType" doc:"The product type of a split document; null for the combined proposal"`
	FileName      string                       `json:"fileName" example:"2026-0007-V2-03 Villa Sommer.docx"`
	DownloadURL   string                       `json:"downloadUrl" doc:"GET it to download the file"`
	Totals        bom.BOMTotals                `json:"totals" doc:"The totals printed in the document (USD and converted)"`
	CreatedBy     *uuid.UUID                   `json:"createdBy" nullable:"true"`
	CreatedByName string                       `json:"createdByName" doc:"Full name or email; empty when the user was deleted"`
	CreatedAt     time.Time                    `json:"createdAt"`
	Can           ProposalActions              `json:"can"`
}

// GenerateInput asks for proposals of a version.
type GenerateInput struct {
	Exporter       string      `json:"exporter" example:"docx" doc:"An exporter key (GET /api/exporters)"`
	Split          bool        `json:"split,omitempty" doc:"One document per product type in productTypeIds instead of one combined proposal"`
	ProductTypeIDs []uuid.UUID `json:"productTypeIds,omitempty" maxItems:"100" doc:"Split: the product types (each must have lines in the BOM); ignored otherwise"`
}

// PreviewInput asks for the totals the documents of a run would have.
type PreviewInput struct {
	Split          bool        `json:"split,omitempty"`
	ProductTypeIDs []uuid.UUID `json:"productTypeIds,omitempty" maxItems:"100"`
}

// PreviewDocument is one document of a preview.
type PreviewDocument struct {
	ProductType *NullableProposalProductType `json:"productType" doc:"Null for the combined proposal"`
	Totals      bom.BOMTotals                `json:"totals"`
}

// ExporterInfo describes an output format.
type ExporterInfo struct {
	Key           string    `json:"key" example:"docx"`
	Name          i18n.Text `json:"name" doc:"Display name per content language"`
	FileExtension string    `json:"fileExtension" example:"docx"`
	ContentType   string    `json:"contentType"`
}
