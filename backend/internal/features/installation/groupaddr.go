package installation

// KNX group addresses (3e, D422): one per KNX communication object (catalog
// data on the function type) of each need connected to a KNX item. Three
// levels: main = floorplan, middle = zone, sub = the objects of the zone's
// needs. Assigned once and stored per version (group_address_groups,
// group_addresses), never renumbered: new zones take the next free middle
// group of their plan, new plans the next free main group, new needs or
// objects the next free sub of their zone's middle group. Rows of removed
// needs, zones and plans stay, so their numbers are never reused; the export
// leaves them out.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/installation/store"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// KNX 3-level ranges: main 0-31, middle 0-7, sub 0-255.
const (
	maxMain   = 31
	maxMiddle = 7
	maxSub    = 255
	// firstMain: main group 0 is left for central functions.
	firstMain = 1
	// maxGANameRunes: ETS allows 1-255 characters for a group name.
	maxGANameRunes = 255
)

// CSV formats of the group address export.
const (
	FormatETS11 = "1-1" // ETS "1/1": one name column, TAB separated (default)
	FormatETS31 = "3-1" // ETS "3/1": main/middle/sub name columns, comma separated
)

// objectsOf are the KNX communication objects of a function type (catalog
// data, D422).
func objectsOf(f functiontypes.FunctionType) []functiontypes.KNXObject { return f.KNXObjects }

// GroupAddress is one row of the group address list: a main group, a
// middle group or a group address (sub).
type GroupAddress struct {
	Level       int // 1 main, 2 middle, 3 sub
	Main        int
	Middle      int
	Sub         int
	Name        string
	Description string
	DPT         string
}

// Address in 3-level notation with "-" for the missing levels.
func (g GroupAddress) Address() string {
	switch g.Level {
	case 1:
		return fmt.Sprintf("%d/-/-", g.Main)
	case 2:
		return fmt.Sprintf("%d/%d/-", g.Main, g.Middle)
	}
	return fmt.Sprintf("%d/%d/%d", g.Main, g.Middle, g.Sub)
}

// gaKey identifies a group address: need and object.
type gaKey struct {
	planID, needID uuid.UUID
	object         string
}

// groupKey identifies a middle group: plan and zone (uuid.Nil: no zone).
type groupKey struct{ planID, zoneID uuid.UUID }

// gaCurrent is a group address the current data asks for.
type gaCurrent struct {
	key         gaKey
	group       groupKey
	zoneName    string
	name        string
	description string
	dpt         string
}

// gaPlan is the result of an assignment: the rows to write and the list.
type gaPlan struct {
	newGroups []store.GroupAddressGroup
	upserts   []store.GroupAddress // new rows and renamed ones
	added     int
	list      []GroupAddress
}

// zoneKey maps a zone id to the key's zone (uuid.Nil for none).
func zoneKey(id *uuid.UUID) uuid.UUID {
	if id == nil {
		return uuid.Nil
	}
	return *id
}

// truncateRunes cuts s to at most n characters (rune-safe).
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// currentGroupAddresses lists what the data asks for, in plan, zone, need
// and object order, and the zones (middle groups) in order per plan: every
// zone of a floorplan with KNX needs, then "No zone" when needs outside
// zones are on KNX.
func currentGroupAddresses(d *data) ([]gaCurrent, map[uuid.UUID][]groupKey) {
	knx := map[[2]uuid.UUID]bool{}
	for _, a := range d.addresses.Items {
		if a.Scheme == networks.SchemeKNX {
			knx[[2]uuid.UUID{a.PlanID, a.ItemID}] = true
		}
	}
	onKNX := map[[2]uuid.UUID][]wiring.Connection{}
	for _, c := range d.wiring.Connections {
		if knx[[2]uuid.UUID{c.TargetPlanID, c.TargetItemID}] {
			k := [2]uuid.UUID{c.NeedPlanID, c.NeedID}
			onKNX[k] = append(onKNX[k], c)
		}
	}
	var out []gaCurrent
	zonesOf := map[uuid.UUID][]groupKey{}
	for _, p := range d.plans {
		if p.Kind != "floorplan" {
			continue
		}
		type zone struct {
			id   *uuid.UUID
			name string
		}
		var zones []zone
		for _, z := range d.checks.Zones {
			if z.PlanID == p.ID && z.ZoneID != nil {
				zones = append(zones, zone{z.ZoneID, z.Name})
			}
		}
		zones = append(zones, zone{nil, d.lang.t("noZone")})
		var planOut []gaCurrent
		usedZone := map[uuid.UUID]bool{}
		for _, z := range zones {
			if z.name == "" {
				z.name = d.lang.t("noZone")
			}
			// Needs of the zone on KNX, with their names; a name that
			// repeats in the zone gets its number (1, 2, ...).
			var needs []*wiring.NeedInfo
			count := map[string]int{}
			for i := range d.wiring.Needs {
				n := &d.wiring.Needs[i]
				if n.PlanID != p.ID || !sameZone(n.ZoneID, z.id) || len(onKNX[[2]uuid.UUID{n.PlanID, n.NeedID}]) == 0 {
					continue
				}
				needs = append(needs, n)
				count[d.needName(n)]++
			}
			seen := map[string]int{}
			for _, n := range needs {
				name := d.needName(n)
				if count[name] > 1 {
					seen[name]++
					name = fmt.Sprintf("%s %d", name, seen[name])
				}
				var targets []string
				for _, c := range onKNX[[2]uuid.UUID{n.PlanID, n.NeedID}] {
					targets = append(targets, d.itemName(d.item(c.TargetPlanID, c.TargetItemID))+" "+d.channelText(c.OutputKindID, c.ChannelNo))
				}
				for _, o := range objectsOf(d.functions[n.FunctionTypeID]) {
					usedZone[zoneKey(z.id)] = true
					planOut = append(planOut, gaCurrent{
						key:         gaKey{n.PlanID, n.NeedID, o.Key},
						group:       groupKey{p.ID, zoneKey(z.id)},
						zoneName:    z.name,
						name:        truncateRunes(z.name+" "+name+" "+text(o.Name, d.lang), maxGANameRunes),
						description: strings.Join(targets, ", "),
						dpt:         o.DPST,
					})
				}
			}
		}
		if len(planOut) == 0 {
			continue
		}
		out = append(out, planOut...)
		// Every zone keeps its place (middle groups in zone order on the
		// first assignment); "No zone" only when used (D422).
		for _, z := range zones {
			if z.id != nil || usedZone[uuid.Nil] {
				zonesOf[p.ID] = append(zonesOf[p.ID], groupKey{p.ID, zoneKey(z.id)})
			}
		}
	}
	return out, zonesOf
}

// planGroupAddresses assigns numbers to what is new (when add) and builds
// the list from the stored and new rows. Without add only the stored rows
// count.
func planGroupAddresses(d *data, groups []store.GroupAddressGroup, rows []store.GroupAddress, add bool) (gaPlan, error) {
	var res gaPlan
	cur, zonesOf := currentGroupAddresses(d)
	tenant, version := d.ref.TenantID, d.ref.ID

	// Groups: by key, used numbers, the mains of each plan.
	byGroup := map[groupKey][2]int{}
	used := map[[2]int]bool{}
	usedMain := map[int]bool{}
	planMains := map[uuid.UUID][]int{}
	addGroup := func(g store.GroupAddressGroup) {
		k := groupKey{g.PlanID, g.ZoneID}
		mm := [2]int{int(g.Main), int(g.Middle)}
		byGroup[k] = mm
		used[mm] = true
		usedMain[mm[0]] = true
		if !slices.Contains(planMains[g.PlanID], mm[0]) {
			planMains[g.PlanID] = append(planMains[g.PlanID], mm[0])
			slices.Sort(planMains[g.PlanID])
		}
	}
	for _, g := range groups {
		addGroup(g)
	}
	byKey := map[gaKey]store.GroupAddress{}
	maxSubOf := map[[2]int]int{}
	for _, r := range rows {
		byKey[gaKey{r.NeedPlanID, r.NeedID, r.ObjectKey}] = r
		mm := [2]int{int(r.Main), int(r.Middle)}
		maxSubOf[mm] = max(maxSubOf[mm], int(r.Sub))
	}

	if add {
		// New groups: every zone of a plan with group addresses, in order.
		for _, p := range d.plans {
			for _, k := range zonesOf[p.ID] {
				if _, ok := byGroup[k]; ok {
					continue
				}
				mm, ok := [2]int{}, false
				for _, m := range planMains[k.planID] {
					for mid := 0; mid <= maxMiddle && !ok; mid++ {
						if !used[[2]int{m, mid}] {
							mm, ok = [2]int{m, mid}, true
						}
					}
					if ok {
						break
					}
				}
				if !ok {
					m := firstMain
					for usedMain[m] {
						m++
					}
					if m > maxMain {
						return res, apperr.New(http.StatusUnprocessableEntity, "export.too_many_group_addresses", "more floors and zones than KNX main groups").
							With("max", maxMain)
					}
					mm = [2]int{m, 0}
				}
				g := store.GroupAddressGroup{TenantID: tenant, VersionID: version, PlanID: k.planID, ZoneID: k.zoneID,
					Main: int16(mm[0]), Middle: int16(mm[1])}
				addGroup(g)
				res.newGroups = append(res.newGroups, g)
			}
		}
	}

	// Group addresses: stored ones keep their numbers (renamed when the
	// name changed); new ones take the next free sub of their group.
	type listed struct {
		row store.GroupAddress
		cur gaCurrent
	}
	var items []listed
	for _, c := range cur {
		r, ok := byKey[c.key]
		switch {
		case ok:
			if add && r.Name != c.name {
				r.Name = c.name
				res.upserts = append(res.upserts, r)
			}
		case add:
			mm := byGroup[c.group]
			sub := maxSubOf[mm] + 1
			if sub > maxSub {
				return res, apperr.New(http.StatusUnprocessableEntity, "export.too_many_group_addresses", "more group addresses in a zone than KNX allows").
					With("zone", c.zoneName).With("max", maxSub)
			}
			maxSubOf[mm] = sub
			r = store.GroupAddress{TenantID: tenant, VersionID: version, NeedPlanID: c.key.planID, NeedID: c.key.needID,
				ObjectKey: c.key.object, Main: int16(mm[0]), Middle: int16(mm[1]), Sub: int16(sub), Name: c.name}
			res.upserts = append(res.upserts, r)
			res.added++
		default:
			continue
		}
		items = append(items, listed{r, c})
	}
	slices.SortFunc(items, func(a, b listed) int {
		return int(a.row.Main)*65536 + int(a.row.Middle)*256 + int(a.row.Sub) - (int(b.row.Main)*65536 + int(b.row.Middle)*256 + int(b.row.Sub))
	})

	// The list: main and middle group rows before their group addresses.
	planOf := map[int]uuid.UUID{}
	groupOf := map[[2]int]groupKey{}
	for k, mm := range byGroup {
		planOf[mm[0]] = k.planID
		groupOf[mm] = k
	}
	planName := map[uuid.UUID]string{}
	for _, p := range d.plans {
		planName[p.ID] = p.Name
	}
	lastMain, lastMiddle := -1, [2]int{-1, -1}
	for _, it := range items {
		m, mid := int(it.row.Main), int(it.row.Middle)
		if m != lastMain {
			pid := planOf[m]
			name := planName[pid]
			if mains := planMains[pid]; len(mains) > 1 {
				name = fmt.Sprintf("%s (%d)", name, slices.Index(mains, m)+1)
			}
			res.list = append(res.list, GroupAddress{Level: 1, Main: m, Name: truncateRunes(name, maxGANameRunes)})
			lastMain = m
		}
		if mm := [2]int{m, mid}; mm != lastMiddle {
			g := groupOf[mm]
			name := d.lang.t("noZone")
			if g.zoneID != uuid.Nil {
				name = d.zoneName(g.planID, &g.zoneID)
			}
			if name == "" {
				name = it.cur.zoneName
			}
			res.list = append(res.list, GroupAddress{Level: 2, Main: m, Middle: mid, Name: truncateRunes(name, maxGANameRunes)})
			lastMiddle = mm
		}
		res.list = append(res.list, GroupAddress{Level: 3, Main: m, Middle: mid, Sub: int(it.row.Sub), Name: it.row.Name,
			Description: it.cur.description, DPT: it.cur.dpt})
	}
	return res, nil
}

func sameZone(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// csvSafe guards against formula injection: a value starting with = + - @
// gets a leading apostrophe (D422).
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@", rune(s[0])) {
		return "'" + s
	}
	return s
}

// groupAddressCSV writes the ETS group address import file (D422): UTF-8
// with BOM, CRLF line ends, every field quoted ("" inside a field doubled).
//
// FormatETS11 (default) is the ETS "1/1" export layout, TAB separated, with
// the header "Group name","Address","Central","Unfiltered","Description",
// "DatapointType","Security": a row per main group ("m/-/-"), middle group
// ("m/n/-") and group address ("m/n/s"); Central and Unfiltered empty,
// Security "Auto".
//
// FormatETS31 is the "3/1" layout, comma separated: the header
// "Main","Middle","Sub","Address",... with the name in the level's column.
func groupAddressCSV(gs []GroupAddress, format string) []byte {
	var b bytes.Buffer
	b.WriteString("\ufeff")
	sep := byte('\t')
	if format == FormatETS31 {
		sep = ','
	}
	row := func(fields ...string) {
		for i, f := range fields {
			if i > 0 {
				b.WriteByte(sep)
			}
			b.WriteString(`"` + strings.ReplaceAll(csvSafe(f), `"`, `""`) + `"`)
		}
		b.WriteString("\r\n")
	}
	if format == FormatETS31 {
		row("Main", "Middle", "Sub", "Address", "Central", "Unfiltered", "Description", "DatapointType", "Security")
		for _, g := range gs {
			switch g.Level {
			case 1:
				row(g.Name, "", "", g.Address(), "", "", "", "", "Auto")
			case 2:
				row("", g.Name, "", g.Address(), "", "", "", "", "Auto")
			default:
				row("", "", g.Name, g.Address(), "", "", g.Description, g.DPT, "Auto")
			}
		}
		return b.Bytes()
	}
	row("Group name", "Address", "Central", "Unfiltered", "Description", "DatapointType", "Security")
	for _, g := range gs {
		row(g.Name, g.Address(), "", "", g.Description, g.DPT, "Auto")
	}
	return b.Bytes()
}

// Export is a generated file.
type Export struct {
	FileName    string
	ContentType string
	Data        []byte
}

// GroupAddressSummary is the result of an assignment.
type GroupAddressSummary struct {
	Added int `json:"added" doc:"Group addresses assigned now"`
	Total int `json:"total" doc:"Group addresses in the export"`
}

// readGroupAddresses reads the stored groups and group addresses.
func (s *Service) readGroupAddresses(ctx context.Context, q *store.Queries, versionID uuid.UUID) ([]store.GroupAddressGroup, []store.GroupAddress, error) {
	groups, err := q.ListGroupAddressGroups(ctx, versionID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := q.ListGroupAddresses(ctx, versionID)
	return groups, rows, err
}

// assign plans and stores the group addresses of d in one transaction that
// locks the version (concurrent assignments run one after the other).
func (s *Service) assign(ctx context.Context, actor auth.Actor, d *data) (gaPlan, error) {
	var res gaPlan
	err := s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, d.ref.ID, true); err != nil {
			return err
		}
		groups, rows, err := s.readGroupAddresses(ctx, q, d.ref.ID)
		if err != nil {
			return err
		}
		if res, err = planGroupAddresses(d, groups, rows, true); err != nil {
			return err
		}
		for _, g := range res.newGroups {
			if err := q.InsertGroupAddressGroup(ctx, store.InsertGroupAddressGroupParams(g)); err != nil {
				return err
			}
		}
		for _, r := range res.upserts {
			if err := q.UpsertGroupAddress(ctx, store.UpsertGroupAddressParams{TenantID: r.TenantID, VersionID: r.VersionID,
				NeedPlanID: r.NeedPlanID, NeedID: r.NeedID, ObjectKey: r.ObjectKey, Main: r.Main, Middle: r.Middle, Sub: r.Sub, Name: r.Name}); err != nil {
				return err
			}
		}
		return nil
	})
	return res, err
}

// AssignGroupAddresses assigns group addresses to new needs and objects of
// a version and renames the stored ones; numbers never change (D422).
func (s *Service) AssignGroupAddresses(ctx context.Context, versionID uuid.UUID) (GroupAddressSummary, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return GroupAddressSummary{}, err
	}
	d, err := s.load(ctx, actor, versionID)
	if err != nil {
		return GroupAddressSummary{}, err
	}
	if !d.ref.Writable() {
		return GroupAddressSummary{}, apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
	}
	res, err := s.assign(ctx, actor, d)
	if err != nil {
		return GroupAddressSummary{}, err
	}
	return GroupAddressSummary{Added: res.added, Total: countSubs(res.list)}, nil
}

func countSubs(gs []GroupAddress) int {
	n := 0
	for _, g := range gs {
		if g.Level == 3 {
			n++
		}
	}
	return n
}

// GroupAddressesCSV exports the KNX group addresses of a version: the
// stored ones; when none are stored yet they are assigned now (stored when
// the caller may write the version, else only for this file).
func (s *Service) GroupAddressesCSV(ctx context.Context, versionID uuid.UUID, format string) (Export, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Export{}, err
	}
	switch format {
	case "":
		format = FormatETS11
	case FormatETS11, FormatETS31:
	default:
		return Export{}, apperr.Invalid("format", "export.format_unknown", "unknown format").With("formats", FormatETS11+", "+FormatETS31)
	}
	d, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Export{}, err
	}
	var groups []store.GroupAddressGroup
	var rows []store.GroupAddress
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		groups, rows, err = s.readGroupAddresses(ctx, q, versionID)
		return err
	})
	if err != nil {
		return Export{}, err
	}
	var res gaPlan
	switch {
	case len(groups) > 0 || len(rows) > 0:
		res, err = planGroupAddresses(d, groups, rows, false)
	case actor.Can(auth.PermProjectsWrite) && d.ref.Writable():
		res, err = s.assign(ctx, actor, d)
	default:
		res, err = planGroupAddresses(d, nil, nil, true)
	}
	if err != nil {
		return Export{}, err
	}
	return Export{FileName: exportName(d, d.lang.t("fileGroupAddresses"), "csv"), ContentType: "text/csv; charset=utf-8",
		Data: groupAddressCSV(res.list, format)}, nil
}

// copyPlans copies the group addresses of a version copy with the plan ids
// mapped (plans.Service.OnCopyPlans; need and zone ids are kept, D339).
func (s *Service) copyPlans(ctx context.Context, tx pgx.Tx, planIDs map[uuid.UUID]uuid.UUID, source, target projects.VersionRef) error {
	if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
		return err
	}
	m := make(map[string]string, len(planIDs))
	for k, v := range planIDs {
		m[k.String()] = v.String()
	}
	planMap, err := json.Marshal(m)
	if err != nil {
		return err
	}
	q := store.New(tx)
	if err := q.CopyGroupAddressGroups(ctx, store.CopyGroupAddressGroupsParams{TenantID: target.TenantID, TargetID: target.ID,
		SourceID: source.ID, PlanMap: planMap}); err != nil {
		return err
	}
	return q.CopyGroupAddresses(ctx, store.CopyGroupAddressesParams{TenantID: target.TenantID, TargetID: target.ID,
		SourceID: source.ID, PlanMap: planMap})
}

// exportName: "<project number>-<version> <what> <project name>.<ext>".
func exportName(d *data, what, ext string) string {
	return proposals.FileName(d.project.Number+"-"+d.version.Name+" "+what, d.project.Name, ext)
}
