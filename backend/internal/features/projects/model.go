package projects

import (
	"time"

	"github.com/google/uuid"
)

// Status is a project's state. Completed and cancelled projects are read-only.
type ProjectStatus string

const (
	StatusActive    ProjectStatus = "active"
	StatusCompleted ProjectStatus = "completed"
	StatusCancelled ProjectStatus = "cancelled"
)

// Limits.
const (
	MaxNameLength            = 200
	MaxCustomerNameLength    = 200
	MaxCustomerCompanyLength = 200
	MaxCustomerEmailLength   = 254
	MaxCustomerPhoneLength   = 50
	MaxCustomerAddressLength = 500
	MaxNotesLength           = 5000
	MaxVersionNameLength     = 100
	MaxVersionNotesLength    = 2000
	MaxProductTypes          = 100
	MaxPageSize              = 200
	DefaultPageSize          = 50
	MaxSearchLength          = 200
	// FirstVersionName is the name of the version every new project gets.
	FirstVersionName = "V1"
	// DefaultCurrency is the catalog's currency (D19).
	DefaultCurrency = "USD"
)

// Actions are the changes the caller may make to a project, computed from
// the permissions and the project's status.
type ProjectActions struct {
	Update bool `json:"update" doc:"Change the project and its versions (projects.write, project active)"`
	Delete bool `json:"delete" doc:"Delete the project (projects.delete)"`
	Reopen bool `json:"reopen" doc:"Set a completed or cancelled project back to active (projects.write)"`
}

// TenantRef names a project's tenant; only for callers who see every tenant.
type ProjectTenant struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Archived bool      `json:"archived" doc:"The tenant is archived (deleted, kept for its projects)"`
}

// Customer is the customer a project is for. Empty strings are no value.
type ProjectCustomer struct {
	Name    string `json:"name"`
	Company string `json:"company"`
	Email   string `json:"email"`
	Phone   string `json:"phone"`
	Address string `json:"address"`
}

// ProjectCustomerInput changes the customer. A field left out keeps the
// stored value (create: empty); an empty string clears it (D170).
type ProjectCustomerInput struct {
	Name    *string `json:"name,omitempty" doc:"At most 200 characters; empty clears, left out keeps"`
	Company *string `json:"company,omitempty" doc:"At most 200 characters; empty clears, left out keeps"`
	Email   *string `json:"email,omitempty" doc:"A valid email address; empty clears, left out keeps"`
	Phone   *string `json:"phone,omitempty" doc:"At most 50 characters; empty clears, left out keeps"`
	Address *string `json:"address,omitempty" doc:"At most 500 characters, may have several lines; empty clears, left out keeps"`
}

// ProjectListItem is one row of the project list.
type ProjectListItem struct {
	ID              uuid.UUID      `json:"id"`
	TenantID        uuid.UUID      `json:"tenantId"`
	Tenant          *ProjectTenant `json:"tenant,omitempty" doc:"Only for callers who see every tenant"`
	Number          string         `json:"number" example:"2026-0007"`
	Name            string         `json:"name"`
	CustomerName    string         `json:"customerName"`
	CustomerCompany string         `json:"customerCompany"`
	Status          ProjectStatus  `json:"status" enum:"active,completed,cancelled"`
	VersionCount    int64          `json:"versionCount"`
	ProductTypeIDs  []uuid.UUID    `json:"productTypeIds" doc:"In catalog order"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	Can             ProjectActions `json:"can"`
}

type ProjectPage struct {
	Items []ProjectListItem `json:"items"`
	Total int64             `json:"total" doc:"Matching projects, all pages"`
}

// Project is a project with its versions.
type Project struct {
	ID           uuid.UUID      `json:"id"`
	TenantID     uuid.UUID      `json:"tenantId"`
	Tenant       *ProjectTenant `json:"tenant,omitempty" doc:"Only for callers who see every tenant"`
	Number       string         `json:"number" example:"2026-0007" doc:"<year>-<sequence of the tenant in that year>; generated, not editable"`
	Name         string         `json:"name"`
	Status       ProjectStatus  `json:"status" enum:"active,completed,cancelled"`
	Language     string         `json:"language" doc:"Content language of proposals" example:"en"`
	Currency     string         `json:"currency" example:"EUR"`
	ExchangeRate *string        `json:"exchangeRate" nullable:"true" doc:"Units of the currency per 1 USD, decimal string; null: a non-USD project without a rate yet (amounts are shown in USD only)" example:"0.92"`
	// The rate's origin (spec "Exchange rates online").
	ExchangeRateDate       *time.Time       `json:"exchangeRateDate" nullable:"true" doc:"Online: the provider's update time; manual: when it was entered; null for USD and without a rate"`
	ExchangeRateSource     string           `json:"exchangeRateSource" enum:"none,online,manual" doc:"none for USD projects and without a rate"`
	ExchangeRateProvider   string           `json:"exchangeRateProvider" doc:"The online provider (host name); empty unless online"`
	ExchangeRateAgeDays    int              `json:"exchangeRateAgeDays" doc:"Whole days since exchangeRateDate (0 without a date)"`
	ExchangeRateStale      bool             `json:"exchangeRateStale" doc:"An online rate older than EXCHANGE_RATE_MAX_AGE_DAYS (manual rates never are)"`
	ExchangeRateMaxAgeDays int              `json:"exchangeRateMaxAgeDays" doc:"Days after which an online rate counts as stale (server configuration)"`
	Customer               ProjectCustomer  `json:"customer"`
	Notes                  string           `json:"notes"`
	ProductTypeIDs         []uuid.UUID      `json:"productTypeIds" doc:"In catalog order; may contain types deactivated since they were chosen"`
	Versions               []ProjectVersion `json:"versions" doc:"In creation order"`
	// NextVersionName is what a new version should be called.
	NextVersionName string         `json:"nextVersionName" doc:"The first free name V<n>, to pre-fill a new version" example:"V2"`
	CreatedBy       *uuid.UUID     `json:"createdBy,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	Can             ProjectActions `json:"can"`
}

// VersionActions are the changes the caller may make to a version.
type ProjectVersionActions struct {
	Update bool `json:"update"`
	Delete bool `json:"delete" doc:"False for the project's last version"`
}

// Version is one version of a project: an alternative offer or a round of
// changes.
type ProjectVersion struct {
	ID        uuid.UUID             `json:"id"`
	ProjectID uuid.UUID             `json:"projectId"`
	Name      string                `json:"name"`
	Notes     string                `json:"notes"`
	Position  int32                 `json:"position" doc:"Creation order"`
	CreatedAt time.Time             `json:"createdAt"`
	UpdatedAt time.Time             `json:"updatedAt"`
	Can       ProjectVersionActions `json:"can"`
}

// ProjectInput is what create and update share.
type ProjectInput struct {
	Name               string                `json:"name" doc:"1-200 characters"`
	TenantID           *uuid.UUID            `json:"tenantId,omitempty" doc:"Defaults to the caller's tenant (create) or the project's (update). Only callers with tenants.access_all may choose another tenant; a moved project gets a new number in its new tenant"`
	Language           string                `json:"language,omitempty" doc:"A content language; defaults to en"`
	Currency           string                `json:"currency,omitempty" doc:"ISO 4217, three upper-case letters; defaults to USD"`
	ExchangeRate       string                `json:"exchangeRate,omitempty" doc:"Units of the currency per 1 USD: up to 8 digits and 6 decimals, above 0; exactly 1 for USD. A changed value is stored as entered manually (today). Left out: the stored rate stays while the currency stays; a new non-USD currency then has no rate yet"`
	ExchangeRateSource string                `json:"exchangeRateSource,omitempty" doc:"online: ignore exchangeRate and store the provider's current rate (503 exchange_rate.unavailable when it is not reachable); manual or left out: exchangeRate as above"`
	ExchangeRateConfirmed bool `json:"exchangeRateConfirmed,omitempty" doc:"With a new currency, a manual exchangeRate more than 10 times off the cached online rate is refused (422 project.exchange_rate_implausible) unless this is true"`
	Customer           *ProjectCustomerInput `json:"customer,omitempty" doc:"Left out: the stored customer stays (create: none)"`
	Notes              *string               `json:"notes,omitempty" doc:"At most 5000 characters; empty clears, left out keeps the stored notes"`
	ProductTypeIDs     []uuid.UUID           `json:"productTypeIds,omitempty" maxItems:"1000" doc:"At least one; new choices must be active. Create without it: every active product type"`
}

type ProjectCreate struct {
	ProjectInput
}

type ProjectUpdate struct {
	ProjectInput
	Status            ProjectStatus `json:"status" enum:"active,completed,cancelled"`
	ExpectedUpdatedAt time.Time     `json:"expectedUpdatedAt" doc:"updatedAt as last read; if the project changed since, the update fails with project.stale"`
}

// VersionCreate adds a version: a full copy of SourceVersionID, or empty
// without it.
type ProjectVersionCreate struct {
	SourceVersionID *uuid.UUID `json:"sourceVersionId,omitempty" doc:"The version to copy (everything it owns); leave out for an empty version"`
	Name            string     `json:"name" doc:"1-100 characters, unique in the project ignoring case"`
}

type ProjectVersionUpdate struct {
	Name              string    `json:"name" doc:"1-100 characters, unique in the project ignoring case"`
	Notes             *string   `json:"notes,omitempty" doc:"At most 2000 characters; empty clears, left out keeps the stored notes"`
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; project_version.stale otherwise"`
}

// ListParams filter and page the project list.
type ListParams struct {
	Search string
	// Status is a status or "all"; empty means active.
	Status   string
	TenantID *uuid.UUID
	Limit    int
	Offset   int
}

// Currency is a currency a project may use.
type Currency struct {
	Code       string `json:"code" example:"EUR" doc:"ISO 4217"`
	MinorUnits int32  `json:"minorUnits" example:"2"`
	Online     bool   `json:"online" doc:"The online provider has a rate for it (false for all while the provider is not reachable)"`
}

// CurrencyList are the currencies a project may use.
type CurrencyList struct {
	Items       []Currency `json:"items" doc:"Sorted by code"`
	Recent      []string   `json:"recent" doc:"Currencies other than USD of the tenant's projects (tenantId, else the caller's), most recently changed first (at most 5)"`
	OnlineKnown bool       `json:"onlineKnown" doc:"false while the provider's rates are not loaded (online is then false for all but USD; they are being fetched, ask again)"`
}

// ExchangeRate is a provider's current rate of a currency.
type ExchangeRate struct {
	Currency string    `json:"currency" example:"EUR"`
	Rate     string    `json:"rate" example:"0.9237" doc:"Units of the currency per 1 USD, 6 decimals at most"`
	Date     time.Time `json:"date" doc:"The provider's last update"`
	Provider string    `json:"provider" example:"open.er-api.com"`
}

// ExchangeRateSet enters a project's rate by hand.
type ExchangeRateSet struct {
	Rate     string `json:"rate" doc:"Units of the currency per 1 USD: up to 8 digits and 6 decimals, above 0"`
	Currency string `json:"currency" pattern:"^[A-Z]{3}$" doc:"The project's currency as the client saw it: 409 project.stale when it changed meanwhile"`
}

// ExchangeRateRefresh asks for the provider's current rate.
type ExchangeRateRefresh struct {
	Currency string `json:"currency,omitempty" doc:"The project's currency as the client saw it: 409 project.stale when it changed meanwhile"`
}
