package tenants

// The letterhead of a tenant (step 2d): optional company details and a logo
// printed on its proposals. Admins edit every tenant's, a tenant admin their
// own (tenants.profile).

import (
	"context"
	"io"
	"net/mail"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Letterhead is what a tenant's proposals print in their header.
type Letterhead struct {
	CompanyName string     `json:"companyName" doc:"Empty: the tenant name is printed"`
	Address     string     `json:"address" doc:"May have several lines"`
	Phone       string     `json:"phone"`
	Email       string     `json:"email"`
	Website     string     `json:"website"`
	LogoFileID  *uuid.UUID `json:"logoFileId" nullable:"true" doc:"An image of the tenant's scope (POST /api/tenants/{id}/logo); null for none"`
	LogoURL     *string    `json:"logoUrl" nullable:"true" doc:"Download path of the logo; null for none"`
}

// LetterheadInput replaces a letterhead: a field left out or empty is cleared.
type LetterheadInput struct {
	CompanyName string     `json:"companyName,omitempty" doc:"At most 200 characters"`
	Address     string     `json:"address,omitempty" doc:"At most 500 characters, may have several lines"`
	Phone       string     `json:"phone,omitempty" doc:"At most 50 characters"`
	Email       string     `json:"email,omitempty" doc:"A valid email address or empty"`
	Website     string     `json:"website,omitempty" doc:"At most 200 characters"`
	LogoFileID  *uuid.UUID `json:"logoFileId,omitempty" nullable:"true" doc:"An uploaded logo of this tenant, null for none"`
}

// logoLimits: logos are small images (5 MB, 25 MP, stored at most 1600 px
// wide, WebP re-encoded as PNG so documents can embed it).
var logoLimits = files.ImageLimits{MaxSize: 5 << 20, MaxMegapixels: files.MaxMegapixels, MaxWidth: files.MaxWidth, ReencodeWebP: true}

// LogoMaxSize is the largest logo upload in bytes.
const LogoMaxSize = 5 << 20

// UseFiles sets where logos are stored (app wiring; files are created after
// the core services).
func (s *Service) UseFiles(f *files.Service) { s.files = f }

func letterheadOf(r store.Tenant) Letterhead {
	l := Letterhead{
		CompanyName: r.CompanyName, Address: r.Address, Phone: r.Phone, Email: r.Email, Website: r.Website,
		LogoFileID: r.LogoFileID,
	}
	if r.LogoFileID != nil {
		u := "/api/files/" + r.LogoFileID.String()
		l.LogoURL = &u
	}
	return l
}

// profileActor checks that the caller may edit the letterhead of tenant id.
func profileActor(ctx context.Context, id uuid.UUID) (auth.Actor, error) {
	actor, err := auth.Require(ctx, auth.PermTenantsProfile)
	if err != nil {
		return actor, err
	}
	if !actor.SeesTenant(id) {
		return actor, apperr.NotFound("tenant.not_found")
	}
	return actor, nil
}

// GetLetterhead returns a tenant's letterhead.
func (s *Service) GetLetterhead(ctx context.Context, id uuid.UUID) (Letterhead, error) {
	if _, err := profileActor(ctx, id); err != nil {
		return Letterhead{}, err
	}
	row, err := s.q.GetTenant(ctx, id)
	if err != nil {
		return Letterhead{}, mapErr(err, "")
	}
	return letterheadOf(row), nil
}

// UpdateLetterhead replaces a tenant's letterhead.
func (s *Service) UpdateLetterhead(ctx context.Context, id uuid.UUID, in LetterheadInput) (Letterhead, error) {
	if _, err := profileActor(ctx, id); err != nil {
		return Letterhead{}, err
	}
	p := store.UpdateLetterheadParams{
		ID: id, CompanyName: strings.TrimSpace(in.CompanyName), Address: strings.TrimSpace(in.Address),
		Phone: strings.TrimSpace(in.Phone), Email: strings.TrimSpace(in.Email), Website: strings.TrimSpace(in.Website),
		LogoFileID: in.LogoFileID,
	}
	var errs []apperr.FieldError
	for _, f := range []struct {
		loc, v string
		max    int
	}{{"body.companyName", p.CompanyName, 200}, {"body.address", p.Address, 500}, {"body.phone", p.Phone, 50}, {"body.email", p.Email, 200}, {"body.website", p.Website, 200}} {
		if utf8.RuneCountInString(f.v) > f.max {
			errs = append(errs, apperr.Field(f.loc, "validation.too_long", "too long").With("max", f.max))
		}
	}
	if p.Email != "" {
		if a, err := mail.ParseAddress(p.Email); err != nil || a.Address != p.Email {
			errs = append(errs, apperr.Field("body.email", "validation.email", "not a valid email address"))
		}
	}
	if p.LogoFileID != nil {
		ok, err := s.files.Exists(ctx, files.TenantScope(id), *p.LogoFileID)
		if err != nil {
			return Letterhead{}, err
		}
		if !ok {
			errs = append(errs, apperr.Field("body.logoFileId", "tenant.logo_not_found", "no logo of this tenant with this id"))
		}
	}
	if len(errs) > 0 {
		return Letterhead{}, apperr.Validation(errs...)
	}
	row, err := s.q.UpdateLetterhead(ctx, p)
	if err != nil {
		return Letterhead{}, mapErr(err, "")
	}
	return letterheadOf(row), nil
}

// UploadLogo stores an image in the tenant's scope for its letterhead (set
// it with UpdateLetterhead).
func (s *Service) UploadLogo(ctx context.Context, id uuid.UUID, r io.Reader) (files.File, error) {
	if _, err := profileActor(ctx, id); err != nil {
		return files.File{}, err
	}
	if _, err := s.Lookup(ctx, id); err != nil {
		return files.File{}, err
	}
	return s.files.UploadImage(ctx, files.TenantScope(id), r, logoLimits)
}
