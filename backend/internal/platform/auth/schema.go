package auth

import "github.com/danielgtaylor/huma/v2"

// Schema publishes Role as a named enum, so the API validates it and the
// generated client gets a union type.
func (Role) Schema(r huma.Registry) *huma.Schema {
	values := make([]any, len(Roles))
	for i, role := range Roles {
		values[i] = string(role)
	}
	return namedEnum(r, "Role", "A user's role, highest first", values)
}

// Schema publishes Permission as a named enum.
func (Permission) Schema(r huma.Registry) *huma.Schema {
	values := make([]any, len(Permissions))
	for i, p := range Permissions {
		values[i] = string(p)
	}
	return namedEnum(r, "Permission", "One entry of the permission matrix", values)
}

func namedEnum(r huma.Registry, name, doc string, values []any) *huma.Schema {
	if _, ok := r.Map()[name]; !ok {
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Description: doc, Enum: values}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}
