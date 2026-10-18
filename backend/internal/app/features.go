package app

import (
	"github.com/danielgtaylor/huma/v2"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	functiontypesstore "github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	// scaffold:imports
)

// registerFeatures is the one place where feature modules are wired in.
// `make feature` adds new features above the marker.
func registerFeatures(api huma.API, deps Deps) {
	functiontypes.Register(api, functiontypes.NewService(functiontypesstore.New(deps.DB)))
	// scaffold:features
}
