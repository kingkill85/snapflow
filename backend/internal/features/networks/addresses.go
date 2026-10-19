package networks

// Device addresses (step 3e, D419): the programming address of every bus
// and wireless item of a version — KNX individual address, HDL Buspro subnet
// and device id, Zigbee IEEE address — with a note, set by hand (pinned) or
// assigned automatically per bus line.

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/networks/store"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Addressing schemes of a system (D419): by the product type's key (knx…,
// hdl…) for bus systems; every wireless system has IEEE addresses; other
// systems only a note.
const (
	SchemeKNX  = "knx"
	SchemeHDL  = "hdl"
	SchemeIEEE = "ieee"
	SchemeNone = "none"
	// MaxNoteLength of an address note.
	MaxNoteLength = 200
	// MaxAddressChanges per PUT.
	MaxAddressChanges = 2000
)

// SchemeOf is the addressing scheme of a system.
func SchemeOf(t producttypes.ProductType) string {
	key := strings.ToLower(t.Key)
	switch {
	case t.Topology == TopologyBus && strings.HasPrefix(key, "knx"):
		return SchemeKNX
	case t.Topology == TopologyBus && strings.HasPrefix(key, "hdl"):
		return SchemeHDL
	case t.Topology == TopologyWireless:
		return SchemeIEEE
	}
	return SchemeNone
}

// DeviceAddress is the stored address of an item.
type DeviceAddress struct {
	KNX    string `json:"knx,omitempty" doc:"KNX individual address area.line.device, e.g. 1.1.5"`
	HDL    string `json:"hdl,omitempty" doc:"HDL Buspro subnet.device id, e.g. 1.12"`
	IEEE   string `json:"ieee,omitempty" doc:"Zigbee IEEE address, 16 hex digits upper case"`
	Note   string `json:"note,omitempty"`
	Pinned bool   `json:"pinned" doc:"Set by hand; auto-assign never changes it"`
}

// AddressedItem is a bus or wireless item with its address.
type AddressedItem struct {
	ItemRef
	SystemID uuid.UUID `json:"systemId" doc:"The item's product type"`
	Scheme   string    `json:"scheme" enum:"knx,hdl,ieee,none"`
	// BusLineID is a bus item's line, absent without one.
	BusLineID     *uuid.UUID     `json:"busLineId,omitempty"`
	GatewayPlanID *uuid.UUID     `json:"gatewayPlanId,omitempty" doc:"A wireless device's gateway"`
	GatewayItemID *uuid.UUID     `json:"gatewayItemId,omitempty"`
	Gateway       bool           `json:"gateway"`
	PowerSupply   bool           `json:"powerSupply" doc:"Power supplies get no address (D419)"`
	Address       *DeviceAddress `json:"address,omitempty" doc:"Absent: no address"`
}

// LinePrefix is the address prefix of a bus line: parsed from its address
// field, else the default (D419).
type LinePrefix struct {
	BusLineID uuid.UUID `json:"busLineId"`
	Scheme    string    `json:"scheme" enum:"knx,hdl,none"`
	Prefix    string    `json:"prefix,omitempty" doc:"KNX area.line or HDL subnet the line's devices get; empty for scheme none or a malformed address"`
	Default   bool      `json:"default" doc:"The line's address field is empty: the prefix is the default (KNX 1.<n>, HDL <n> for the n-th line of the system)"`
	Invalid   bool      `json:"invalid" doc:"The line's address field cannot be parsed (no automatic addresses)"`
}

// Addresses are the addresses of a version's bus and wireless items.
type Addresses struct {
	VersionID uuid.UUID        `json:"versionId"`
	Items     []AddressedItem  `json:"items" doc:"In plan and item order"`
	Lines     []LinePrefix     `json:"lines" doc:"In line order"`
	Can       AddressesActions `json:"can"`
}

// AddressesActions say what the caller may do.
type AddressesActions struct {
	Update bool `json:"update" doc:"Edit, assign and clear addresses (projects.write, project active)"`
}

// AddressInput sets the address of an item; every field empty clears it.
type AddressInput struct {
	PlanID uuid.UUID `json:"planId"`
	ItemID uuid.UUID `json:"itemId"`
	KNX    string    `json:"knx,omitempty" doc:"area.line.device (0-15.0-15.0-255); only for KNX items"`
	HDL    string    `json:"hdl,omitempty" doc:"subnet.device (0-254 each); only for HDL items"`
	IEEE   string    `json:"ieee,omitempty" doc:"16 hex digits (separators : - and spaces ignored); only for wireless items"`
	Note   string    `json:"note,omitempty" doc:"At most 200 characters"`
}

// AddressesInput is a batch of address changes (set by hand: pinned).
type AddressesInput struct {
	Addresses []AddressInput `json:"addresses" maxItems:"2000"`
}

// AssignInput says which lines auto-assign handles.
type AssignInput struct {
	BusLineIDs []uuid.UUID `json:"busLineIds,omitempty" maxItems:"1000" doc:"Empty or absent: every line"`
}

// AssignResult is the addresses after an auto-assign.
type AssignResult struct {
	Addresses
	Assigned   int `json:"assigned" doc:"Items that got an automatic address"`
	Unassigned int `json:"unassigned" doc:"Items left without address (line full or its address field malformed)"`
}

// ---------------------------------------------------------------- parsing

var (
	knxLineRe   = regexp.MustCompile(`^(\d{1,2})[./](\d{1,2})$`)
	knxDeviceRe = regexp.MustCompile(`^(\d{1,2})[./](\d{1,2})[./](\d{1,3})$`)
	hdlDeviceRe = regexp.MustCompile(`^(\d{1,3})[./](\d{1,3})$`)
	hdlSubnetRe = regexp.MustCompile(`^(\d{1,3})$`)
)

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// knxAddr is a KNX individual address.
type knxAddr struct{ area, line, device int }

func (a knxAddr) String() string { return fmt.Sprintf("%d.%d.%d", a.area, a.line, a.device) }

// hdlAddr is an HDL subnet and device id.
type hdlAddr struct{ subnet, device int }

func (a hdlAddr) String() string { return fmt.Sprintf("%d.%d", a.subnet, a.device) }

// ParseKNX parses area.line.device (0-15.0-15.0-255; "/" also separates).
func ParseKNX(s string) (knxAddr, bool) {
	m := knxDeviceRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return knxAddr{}, false
	}
	a := knxAddr{atoi(m[1]), atoi(m[2]), atoi(m[3])}
	return a, a.area <= 15 && a.line <= 15 && a.device <= 255
}

// ParseHDL parses subnet.device (0-254 each).
func ParseHDL(s string) (hdlAddr, bool) {
	m := hdlDeviceRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return hdlAddr{}, false
	}
	a := hdlAddr{atoi(m[1]), atoi(m[2])}
	return a, a.subnet <= 254 && a.device <= 254
}

// ParseIEEE normalises an IEEE address: 16 hex digits, upper case;
// separators ":", "-" and spaces and a "0x" prefix are ignored.
func ParseIEEE(s string) (string, bool) {
	s = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "0x")
	s = strings.Map(func(r rune) rune {
		if r == ':' || r == '-' || unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
	if len(s) != 16 || strings.Trim(s, "0123456789abcdef") != "" {
		return "", false
	}
	return strings.ToUpper(s), true
}

// parseLinePrefix parses a bus line's address field: KNX "area.line"
// (0-15 each, "/" also separates), HDL "subnet" (0-254). ok is false for a
// malformed field; empty is ok with set false.
func parseLinePrefix(scheme, address string) (prefix [2]int, set, ok bool) {
	address = strings.TrimSpace(address)
	if address == "" || scheme == SchemeNone || scheme == SchemeIEEE {
		return prefix, false, true
	}
	switch scheme {
	case SchemeKNX:
		m := knxLineRe.FindStringSubmatch(address)
		if m == nil {
			return prefix, false, false
		}
		prefix = [2]int{atoi(m[1]), atoi(m[2])}
		return prefix, true, prefix[0] <= 15 && prefix[1] <= 15
	case SchemeHDL:
		m := hdlSubnetRe.FindStringSubmatch(address)
		if m == nil {
			return prefix, false, false
		}
		prefix[0] = atoi(m[1])
		return prefix, true, prefix[0] <= 254
	}
	return prefix, false, true
}

// validateLineAddress is the bus line address rule for a system (D419).
func validateLineAddress(t producttypes.ProductType, address string) error {
	scheme := SchemeOf(t)
	if _, _, ok := parseLinePrefix(scheme, address); !ok {
		code := "bus_line.address_knx"
		if scheme == SchemeHDL {
			code = "bus_line.address_hdl"
		}
		return apperr.Invalid("body.address", code, "malformed line address").With("address", strings.TrimSpace(address))
	}
	return nil
}

// ---------------------------------------------------------------- state

// lineInfo is a bus line with its scheme and prefix.
type lineInfo struct {
	line    store.BusLine
	scheme  string
	prefix  [2]int
	set     bool // from the address field
	invalid bool
}

// lineInfos are the version's lines with their prefixes: the address field,
// else KNX 1.n / HDL n for the n-th line of the system (n ≤ 15 resp. 254).
func (st state) lineInfos() []lineInfo {
	n := map[uuid.UUID]int{}
	out := make([]lineInfo, 0, len(st.lines))
	for _, l := range st.lines {
		n[l.ProductTypeID]++
		li := lineInfo{line: l, scheme: SchemeOf(st.types[l.ProductTypeID])}
		p, set, ok := parseLinePrefix(li.scheme, l.Address)
		switch {
		case !ok:
			li.invalid = true
		case set:
			li.prefix, li.set = p, true
		case li.scheme == SchemeKNX:
			li.prefix = [2]int{1, min(n[l.ProductTypeID], 15)}
		case li.scheme == SchemeHDL:
			li.prefix = [2]int{min(n[l.ProductTypeID], 254), 0}
		}
		out = append(out, li)
	}
	return out
}

func (li lineInfo) prefixString() string {
	if li.invalid {
		return ""
	}
	switch li.scheme {
	case SchemeKNX:
		return fmt.Sprintf("%d.%d", li.prefix[0], li.prefix[1])
	case SchemeHDL:
		return strconv.Itoa(li.prefix[0])
	}
	return ""
}

func (st state) schemeOfItem(it item) string {
	if t, ok := st.types[it.system]; ok {
		return SchemeOf(t)
	}
	return SchemeOf(st.variants[it.ref.VariantID].ProductType)
}

func addressOf(r store.DeviceAddress) DeviceAddress {
	a := DeviceAddress{Note: r.Note, Pinned: r.Pinned}
	if r.KnxArea != nil && r.KnxLine != nil && r.KnxDevice != nil {
		a.KNX = knxAddr{int(*r.KnxArea), int(*r.KnxLine), int(*r.KnxDevice)}.String()
	}
	if r.HdlSubnet != nil && r.HdlDevice != nil {
		a.HDL = hdlAddr{int(*r.HdlSubnet), int(*r.HdlDevice)}.String()
	}
	if r.Ieee != nil {
		a.IEEE = *r.Ieee
	}
	return a
}

func isPowerSupply(it item) bool {
	return it.caps.BusCurrentSuppliedMa != nil && *it.caps.BusCurrentSuppliedMa > 0
}

// addressed lists the members with their addresses.
func (st state) addressed() []AddressedItem {
	members := st.members()
	out := make([]AddressedItem, 0, len(members))
	for _, m := range members {
		ai := AddressedItem{
			ItemRef: m.item.ref, SystemID: m.SystemID, Scheme: st.schemeOfItem(m.item), BusLineID: m.LineID,
			GatewayPlanID: m.GatewayPlanID, GatewayItemID: m.GatewayItemID, Gateway: m.Gateway,
			PowerSupply: m.Topology == TopologyBus && isPowerSupply(m.item),
		}
		if r, ok := st.addresses[[2]uuid.UUID{m.PlanID, m.ItemID}]; ok {
			a := addressOf(r)
			ai.Address = &a
		}
		out = append(out, ai)
	}
	return out
}

func (st state) addressesView(can bool) Addresses {
	out := Addresses{VersionID: st.ref.ID, Items: st.addressed(), Lines: []LinePrefix{}, Can: AddressesActions{Update: can}}
	for _, li := range st.lineInfos() {
		if li.scheme != SchemeKNX && li.scheme != SchemeHDL {
			out.Lines = append(out.Lines, LinePrefix{BusLineID: li.line.ID, Scheme: SchemeNone})
			continue
		}
		out.Lines = append(out.Lines, LinePrefix{BusLineID: li.line.ID, Scheme: li.scheme, Prefix: li.prefixString(),
			Default: !li.set && !li.invalid, Invalid: li.invalid})
	}
	return out
}

// ---------------------------------------------------------------- reading

// GetAddresses returns the addresses of a version's bus and wireless items.
func (s *Service) GetAddresses(ctx context.Context, versionID uuid.UUID) (Addresses, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Addresses{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Addresses{}, err
	}
	return st.addressesView(actor.Can(auth.PermProjectsWrite) && st.ref.Writable()), nil
}

// AddressIssue is a finding of the address rules for the checks engine.
type AddressIssue struct {
	// Code: address_duplicate (error), address_outside_line (warning),
	// bus_line_address_invalid (warning), address_missing (info, one per
	// line with the count).
	Code           string
	Severity       string
	PlanID, ItemID *uuid.UUID
	BusLineID      *uuid.UUID
	Params         map[string]any
}

// AddressIssues evaluates the addresses of a version (checks engine, D419).
func (s *Service) AddressIssues(ctx context.Context, versionID uuid.UUID) ([]AddressIssue, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return nil, err
	}
	return st.addressIssues(), nil
}

func (st state) addressIssues() []AddressIssue {
	var out []AddressIssue
	infos := st.lineInfos()
	byLine := map[uuid.UUID]lineInfo{}
	for _, li := range infos {
		byLine[li.line.ID] = li
		if li.invalid {
			id := li.line.ID
			out = append(out, AddressIssue{Code: "bus_line_address_invalid", Severity: "warning", BusLineID: &id,
				Params: map[string]any{"name": li.line.Name, "address": li.line.Address}})
		}
	}
	items := st.addressed()
	seen := map[string][]int{}
	missing := map[uuid.UUID]int{}
	for i, it := range items {
		a := it.Address
		key := func(k string) { seen[k] = append(seen[k], i) }
		if a != nil {
			switch {
			case it.Scheme == SchemeKNX && a.KNX != "":
				key("knx:" + a.KNX)
			case it.Scheme == SchemeHDL && a.HDL != "":
				key("hdl:" + a.HDL)
			case it.Scheme == SchemeIEEE && a.IEEE != "":
				key("ieee:" + a.IEEE)
			}
		}
		if it.BusLineID == nil || (it.Scheme != SchemeKNX && it.Scheme != SchemeHDL) || it.PowerSupply {
			continue
		}
		li := byLine[*it.BusLineID]
		has := a != nil && ((it.Scheme == SchemeKNX && a.KNX != "") || (it.Scheme == SchemeHDL && a.HDL != ""))
		if !has {
			missing[*it.BusLineID]++
			continue
		}
		if !li.set || li.invalid {
			continue // without an address field any prefix is the user's choice
		}
		outside := false
		if it.Scheme == SchemeKNX {
			k, _ := ParseKNX(a.KNX)
			outside = k.area != li.prefix[0] || k.line != li.prefix[1]
		} else {
			h, _ := ParseHDL(a.HDL)
			outside = h.subnet != li.prefix[0]
		}
		if outside {
			pl, id, line := it.PlanID, it.ItemID, *it.BusLineID
			out = append(out, AddressIssue{Code: "address_outside_line", Severity: "warning", PlanID: &pl, ItemID: &id, BusLineID: &line,
				Params: map[string]any{"address": cmp.Or(a.KNX, a.HDL), "line": li.line.Name, "prefix": li.prefixString()}})
		}
	}
	keys := make([]string, 0, len(seen))
	for k, idx := range seen {
		if len(idx) > 1 {
			keys = append(keys, k)
		}
	}
	slices.SortFunc(keys, func(a, b string) int { return cmp.Compare(seen[a][0], seen[b][0]) })
	for _, k := range keys {
		for _, i := range seen[k] {
			it := items[i]
			pl, id := it.PlanID, it.ItemID
			out = append(out, AddressIssue{Code: "address_duplicate", Severity: "error", PlanID: &pl, ItemID: &id,
				Params: map[string]any{"address": k[strings.IndexByte(k, ':')+1:], "count": len(seen[k])}})
		}
	}
	for _, li := range infos {
		if n := missing[li.line.ID]; n > 0 {
			id := li.line.ID
			out = append(out, AddressIssue{Code: "address_missing", Severity: "info", BusLineID: &id,
				Params: map[string]any{"name": li.line.Name, "count": n}})
		}
	}
	return out
}

// ---------------------------------------------------------------- writing

// SetAddresses sets or clears addresses by hand (pinned). Rows of items
// that are no longer bus or wireless items of the version are removed.
func (s *Service) SetAddresses(ctx context.Context, versionID uuid.UUID, in AddressesInput) (Addresses, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Addresses{}, err
	}
	if len(in.Addresses) > MaxAddressChanges {
		return Addresses{}, apperr.Validation(apperr.Field("body.addresses", "validation.too_many", "too many addresses").With("max", MaxAddressChanges))
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Addresses{}, err
	}
	if !st.ref.Writable() {
		return Addresses{}, apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
	}
	byKey := map[[2]uuid.UUID]AddressedItem{}
	for _, it := range st.addressed() {
		byKey[[2]uuid.UUID{it.PlanID, it.ItemID}] = it
	}
	// The resulting addresses, for the uniqueness rule.
	result := map[[2]uuid.UUID]store.DeviceAddress{}
	for k, r := range st.addresses {
		if _, ok := byKey[k]; ok {
			result[k] = r
		}
	}
	var errs []apperr.FieldError
	changed := map[[2]uuid.UUID]int{}
	for i, a := range in.Addresses {
		loc := fmt.Sprintf("body.addresses[%d]", i)
		key := [2]uuid.UUID{a.PlanID, a.ItemID}
		row := store.DeviceAddress{PlanID: a.PlanID, ItemID: a.ItemID, VersionID: versionID, Pinned: true, Note: strings.TrimSpace(a.Note)}
		empty := strings.TrimSpace(a.KNX) == "" && strings.TrimSpace(a.HDL) == "" && strings.TrimSpace(a.IEEE) == "" && row.Note == ""
		if empty {
			delete(result, key)
			changed[key] = i
			continue
		}
		it, ok := byKey[key]
		if !ok {
			errs = append(errs, apperr.Field(loc+".itemId", "address.item_not_found", "no bus or wireless item of the version"))
			continue
		}
		switch {
		case len([]rune(row.Note)) > MaxNoteLength:
			errs = append(errs, apperr.Field(loc+".note", "validation.too_long", "too long").With("max", MaxNoteLength))
		case strings.ContainsFunc(row.Note, unicode.IsControl):
			errs = append(errs, apperr.Field(loc+".note", "validation.control_chars", "control characters are not allowed"))
		}
		if v := strings.TrimSpace(a.KNX); v != "" {
			k, ok := ParseKNX(v)
			switch {
			case it.Scheme != SchemeKNX:
				errs = append(errs, apperr.Field(loc+".knx", "address.scheme_mismatch", "the item has no KNX address").With("scheme", it.Scheme))
			case !ok:
				errs = append(errs, apperr.Field(loc+".knx", "address.knx_invalid", "area.line.device, 0-15.0-15.0-255").With("value", v))
			default:
				a, l, d := int16(k.area), int16(k.line), int16(k.device)
				row.KnxArea, row.KnxLine, row.KnxDevice = &a, &l, &d
			}
		}
		if v := strings.TrimSpace(a.HDL); v != "" {
			h, ok := ParseHDL(v)
			switch {
			case it.Scheme != SchemeHDL:
				errs = append(errs, apperr.Field(loc+".hdl", "address.scheme_mismatch", "the item has no HDL address").With("scheme", it.Scheme))
			case !ok:
				errs = append(errs, apperr.Field(loc+".hdl", "address.hdl_invalid", "subnet.device, 0-254 each").With("value", v))
			default:
				sn, d := int16(h.subnet), int16(h.device)
				row.HdlSubnet, row.HdlDevice = &sn, &d
			}
		}
		if v := strings.TrimSpace(a.IEEE); v != "" {
			ieee, ok := ParseIEEE(v)
			switch {
			case it.Scheme != SchemeIEEE:
				errs = append(errs, apperr.Field(loc+".ieee", "address.scheme_mismatch", "the item has no IEEE address").With("scheme", it.Scheme))
			case !ok:
				errs = append(errs, apperr.Field(loc+".ieee", "address.ieee_invalid", "16 hex digits").With("value", v))
			default:
				row.Ieee = &ieee
			}
		}
		result[key] = row
		changed[key] = i
	}
	if len(errs) == 0 {
		// Uniqueness per version among the resulting addresses: reported at
		// the changed entry.
		owner := map[string][2]uuid.UUID{}
		keys := make([][2]uuid.UUID, 0, len(result))
		for k := range result {
			keys = append(keys, k)
		}
		// Unchanged rows first, so the changed entry is the one refused.
		slices.SortFunc(keys, func(a, b [2]uuid.UUID) int {
			_, ca := changed[a]
			_, cb := changed[b]
			if ca != cb {
				if ca {
					return 1
				}
				return -1
			}
			return cmp.Or(strings.Compare(a[0].String(), b[0].String()), strings.Compare(a[1].String(), b[1].String()))
		})
		for _, k := range keys {
			a := addressOf(result[k])
			for field, v := range map[string]string{"knx": a.KNX, "hdl": a.HDL, "ieee": a.IEEE} {
				if v == "" {
					continue
				}
				if _, taken := owner[field+":"+v]; taken {
					if i, ok := changed[k]; ok {
						errs = append(errs, apperr.Field(fmt.Sprintf("body.addresses[%d].%s", i, field), "address.taken", "another device has this address").With("address", v))
					}
					continue
				}
				owner[field+":"+v] = k
			}
		}
	}
	if len(errs) > 0 {
		return Addresses{}, apperr.Validation(errs...)
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		if err := s.dropDangling(ctx, q, st, byKey); err != nil {
			return err
		}
		for _, a := range in.Addresses {
			key := [2]uuid.UUID{a.PlanID, a.ItemID}
			row, ok := result[key]
			if !ok {
				if err := q.DeleteAddress(ctx, store.DeleteAddressParams{VersionID: versionID, PlanID: a.PlanID, ItemID: a.ItemID}); err != nil {
					return err
				}
				continue
			}
			row.TenantID = ref.TenantID
			if err := upsert(ctx, q, row); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Addresses{}, mapAddressErr(err)
	}
	return s.GetAddresses(ctx, versionID)
}

func upsert(ctx context.Context, q *store.Queries, r store.DeviceAddress) error {
	return q.UpsertAddress(ctx, store.UpsertAddressParams{
		TenantID: r.TenantID, VersionID: r.VersionID, PlanID: r.PlanID, ItemID: r.ItemID, KnxArea: r.KnxArea, KnxLine: r.KnxLine,
		KnxDevice: r.KnxDevice, HdlSubnet: r.HdlSubnet, HdlDevice: r.HdlDevice, Ieee: r.Ieee, Note: r.Note, Pinned: r.Pinned,
	})
}

// dropDangling removes the rows of items that are no longer bus or
// wireless items of the version (their addresses would block reuse).
func (s *Service) dropDangling(ctx context.Context, q *store.Queries, st state, current map[[2]uuid.UUID]AddressedItem) error {
	for k := range st.addresses {
		if _, ok := current[k]; !ok {
			if err := q.DeleteAddress(ctx, store.DeleteAddressParams{VersionID: st.ref.ID, PlanID: k[0], ItemID: k[1]}); err != nil {
				return err
			}
		}
	}
	return nil
}

func mapAddressErr(err error) error {
	if isFKViolation(err) {
		return apperr.Conflict("network.changed", "the plan was changed meanwhile; reload")
	}
	return err
}

// Assign gives the bus devices of the lines in scope automatic addresses
// (D419): per line in line order, devices on boards first (board order,
// module order), then on floorplans (plan order, placement order); KNX
// device numbers and HDL device ids from 1 upwards, skipping numbers other
// items of the version hold. Addresses set by hand (pinned) are never
// changed; automatic ones in scope are recomputed. Power supplies and
// wireless items get none.
func (s *Service) Assign(ctx context.Context, versionID uuid.UUID, in AssignInput) (AssignResult, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return AssignResult{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return AssignResult{}, err
	}
	if !st.ref.Writable() {
		return AssignResult{}, apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
	}
	lines := map[uuid.UUID]bool{}
	for _, l := range st.lines {
		lines[l.ID] = true
	}
	for i, id := range in.BusLineIDs {
		if !lines[id] {
			return AssignResult{}, apperr.Invalid(fmt.Sprintf("body.busLineIds[%d]", i), "bus_line.not_found", "no such line in the version")
		}
	}
	rows, assigned, unassigned := st.assign(in.BusLineIDs)
	byKey := map[[2]uuid.UUID]AddressedItem{}
	for _, it := range st.addressed() {
		byKey[[2]uuid.UUID{it.PlanID, it.ItemID}] = it
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		if err := s.dropDangling(ctx, q, st, byKey); err != nil {
			return err
		}
		for _, r := range rows {
			if r.delete {
				if err := q.DeleteAddress(ctx, store.DeleteAddressParams{VersionID: versionID, PlanID: r.row.PlanID, ItemID: r.row.ItemID}); err != nil {
					return err
				}
				continue
			}
			r.row.TenantID = ref.TenantID
			if err := upsert(ctx, q, r.row); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return AssignResult{}, mapAddressErr(err)
	}
	out, err := s.GetAddresses(ctx, versionID)
	if err != nil {
		return AssignResult{}, err
	}
	return AssignResult{Addresses: out, Assigned: assigned, Unassigned: unassigned}, nil
}

type assignRow struct {
	row    store.DeviceAddress
	delete bool
}

// assign is the pure part of Assign: the rows to write.
func (st state) assign(scope []uuid.UUID) ([]assignRow, int, int) {
	inScope := func(id uuid.UUID) bool { return len(scope) == 0 || slices.Contains(scope, id) }
	items := st.addressed()
	planKind := map[uuid.UUID]string{}
	planPos := map[uuid.UUID]int{}
	for i, p := range st.plans {
		planKind[p.ID], planPos[p.ID] = p.Kind, i
	}
	// Taken numbers: every address that stays (outside scope or pinned).
	taken := map[string]bool{}
	var todo []AddressedItem
	for _, it := range items {
		a := it.Address
		auto := it.BusLineID != nil && inScope(*it.BusLineID) && (it.Scheme == SchemeKNX || it.Scheme == SchemeHDL) && !it.PowerSupply &&
			(a == nil || !a.Pinned)
		if auto {
			todo = append(todo, it)
			continue
		}
		if a != nil {
			if a.KNX != "" {
				taken["knx:"+a.KNX] = true
			}
			if a.HDL != "" {
				taken["hdl:"+a.HDL] = true
			}
		}
	}
	// Boards first, then floorplans; plan order; item order (stable).
	slices.SortStableFunc(todo, func(a, b AddressedItem) int {
		ba, bb := planKind[a.PlanID] == "board", planKind[b.PlanID] == "board"
		if ba != bb {
			if ba {
				return -1
			}
			return 1
		}
		return cmp.Compare(planPos[a.PlanID], planPos[b.PlanID])
	})
	infos := map[uuid.UUID]lineInfo{}
	for _, li := range st.lineInfos() {
		infos[li.line.ID] = li
	}
	next := map[uuid.UUID]int{}
	var out []assignRow
	assigned, unassigned := 0, 0
	for _, li := range st.lineInfos() { // line order
		for _, it := range todo {
			if *it.BusLineID != li.line.ID {
				continue
			}
			row := store.DeviceAddress{PlanID: it.PlanID, ItemID: it.ItemID, VersionID: st.ref.ID, Pinned: false}
			if it.Address != nil {
				row.Note = it.Address.Note
			}
			limit := 255
			if li.scheme == SchemeHDL {
				limit = 254
			}
			ok := false
			for n := max(next[li.line.ID], 1); !li.invalid && n <= limit; n++ {
				var k string
				if li.scheme == SchemeKNX {
					k = "knx:" + knxAddr{li.prefix[0], li.prefix[1], n}.String()
				} else {
					k = "hdl:" + hdlAddr{li.prefix[0], n}.String()
				}
				if taken[k] {
					continue
				}
				taken[k], next[li.line.ID], ok = true, n+1, true
				if li.scheme == SchemeKNX {
					a, l, d := int16(li.prefix[0]), int16(li.prefix[1]), int16(n)
					row.KnxArea, row.KnxLine, row.KnxDevice = &a, &l, &d
				} else {
					sn, d := int16(li.prefix[0]), int16(n)
					row.HdlSubnet, row.HdlDevice = &sn, &d
				}
				break
			}
			if ok {
				assigned++
				out = append(out, assignRow{row: row})
				continue
			}
			unassigned++
			if row.Note != "" {
				out = append(out, assignRow{row: row})
			} else if it.Address != nil {
				out = append(out, assignRow{row: row, delete: true})
			}
		}
	}
	return out, assigned, unassigned
}

// ClearAutomatic removes the automatic addresses of a version (auto must be
// true: addresses set by hand are cleared one by one with SetAddresses).
func (s *Service) ClearAutomatic(ctx context.Context, versionID uuid.UUID, auto bool) (Addresses, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Addresses{}, err
	}
	if !auto {
		return Addresses{}, apperr.Invalid("query.auto", "address.clear_auto_only", "only automatic addresses can be cleared (auto=true)")
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		_, err := q.DeleteAutoAddresses(ctx, versionID)
		return err
	})
	if err != nil {
		return Addresses{}, err
	}
	return s.GetAddresses(ctx, versionID)
}

// copyAddresses copies the addresses of a version copy (plan ids mapped).
func copyAddresses(ctx context.Context, q *store.Queries, planMap []byte, tenantID, sourceID, targetID uuid.UUID) error {
	return q.CopyAddresses(ctx, store.CopyAddressesParams{TenantID: tenantID, TargetID: targetID, SourceID: sourceID, PlanMap: json.RawMessage(planMap)})
}
