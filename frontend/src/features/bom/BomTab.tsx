import { RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGetBom } from "@/api/generated/bom/bom";
import type { Bom, BOMLine } from "@/api/generated/model";
import {
  Badge,
  Button,
  type Column,
  DataTable,
  EmptyState,
  ErrorMessage,
  Loading,
  Notice,
  SelectField,
  type TableGroup,
  TextLink,
  Thumbnail,
  TypeBadge,
} from "@/components/ui";
import { editorPath } from "@/features/plans/paths";
import { useLocalized } from "@/i18n/localized";

import { CatalogChangesDialog } from "./CatalogChangesDialog";
import { fresh, useFormatMoney, useLineName } from "./format";
import { ManualLinesSection } from "./ManualLinesSection";
import { TotalsBlock } from "./TotalsBlock";

type Props = {
  projectId: string;
  versionId: string;
  /** The project may be changed (active, projects.write). */
  canWrite: boolean;
  /** The project's product types: what the manual-line picker offers. */
  productTypeIds: string[];
};

/** The zone filter's value for placements outside every zone. */
const noZone = "none";
const all = "all";

/**
 * The bill of materials of a version (step 2c): lines grouped by product type
 * and category with the API's subtotals, filters by plan and zone, status
 * badges, warnings, totals, manual lines and "Update from catalog".
 */
export function BomTab({
  projectId,
  versionId,
  canWrite,
  productTypeIds,
}: Props) {
  const { t } = useTranslation("bom");
  const query = useGetBom(versionId, { query: fresh });
  const [plan, setPlan] = useState(all);
  const [zone, setZone] = useState(all);
  const [changesOpen, setChangesOpen] = useState(false);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorMessage error={query.error} />;
  const bom = query.data;
  const planRef = bom.plans.find((p) => p.id === plan);
  const filter: Filter | undefined = planRef
    ? { planId: planRef.id, zone: zone === all ? undefined : zone }
    : undefined;
  const needsUpdate = bom.lines.some((l) => l.status?.outdated);

  return (
    <div className="space-y-6">
      {bom.warnings.map((w) => (
        <Notice key={w.placementId} tone="warning">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("bom.warning", {
                plan: bom.plans.find((p) => p.id === w.planId)?.name ?? "",
              })}
            </span>
            <TextLink to={editorPath(projectId, versionId, w.planId)}>
              {t("bom.openPlan")}
            </TextLink>
          </span>
        </Notice>
      ))}

      {/* Nothing listed yet: no filters and nothing to update (the empty state says what to do). */}
      {bom.lines.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-56">
            <SelectField
              label={t("bom.filterPlan")}
              value={plan}
              options={[
                { value: all, label: t("bom.allPlans") },
                ...bom.plans.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onValueChange={(v) => {
                setPlan(v);
                setZone(all);
              }}
            />
          </div>
          <div className="w-full sm:w-56">
            <SelectField
              label={t("bom.filterZone")}
              value={zone}
              disabled={!planRef}
              options={[
                { value: all, label: t("bom.allZones") },
                ...(planRef?.zones ?? []).map((z) => ({
                  value: z.id,
                  label: z.name,
                })),
                { value: noZone, label: t("bom.noZone") },
              ]}
              onValueChange={setZone}
            />
          </div>
          {canWrite && (
            <Button
              variant={needsUpdate ? "primary" : "secondary"}
              className="sm:ml-auto"
              onClick={() => setChangesOpen(true)}
            >
              <RefreshCw /> {t("bom.updateFromCatalog")}
            </Button>
          )}
        </div>
      )}

      {filter && <Notice tone="warning">{t("bom.filtered")}</Notice>}
      <BomTable
        bom={bom}
        filter={filter}
        onUpdate={canWrite ? () => setChangesOpen(true) : undefined}
      />

      <TotalsBlock
        totals={bom.totals}
        servicesLabel={bom.pricing.servicesLabel}
      />

      <ManualLinesSection
        versionId={versionId}
        lines={bom.manualLines}
        canWrite={canWrite}
        productTypeIds={productTypeIds}
      />

      {canWrite && (
        <CatalogChangesDialog
          open={changesOpen}
          onOpenChange={setChangesOpen}
          versionId={versionId}
        />
      )}
    </div>
  );
}

type Filter = { planId: string; zone?: string };

/** The quantity a filter shows: the API's number for that plan, zone or the plan's unzoned placements (no client maths). */
function filteredQuantity(line: BOMLine, filter: Filter) {
  if (filter.zone === undefined)
    return line.quantities.plans[filter.planId] ?? 0;
  if (filter.zone === noZone)
    return line.quantities.unzoned[filter.planId] ?? 0;
  return line.quantities.zones[filter.zone] ?? 0;
}

function BomTable({
  bom,
  filter,
  onUpdate,
}: {
  bom: Bom;
  filter?: Filter;
  onUpdate?: () => void;
}) {
  const { t } = useTranslation("bom");
  const localize = useLocalized();
  const money = useFormatMoney();
  const lineName = useLineName();
  const currency = bom.totals.currency;
  const byKey = new Map(bom.lines.map((l) => [l.key, l]));
  const visible = (l: BOMLine) => !filter || filteredQuantity(l, filter) > 0;

  const amount = (usdValue: string, converted: string | null | undefined) => (
    <span className="block text-right whitespace-nowrap tabular-nums max-md:text-left">
      {money(usdValue)}
      {converted != null && (
        <span className="block text-xs text-muted">
          {money(converted, currency)}
        </span>
      )}
    </span>
  );
  const subtotal = (usdValue: string, converted: string | null) =>
    filter ? null : (
      <span className="ml-auto text-right whitespace-nowrap tabular-nums">
        {money(usdValue)}
        {converted != null && (
          <span className="ml-2 text-xs text-muted">
            {money(converted, currency)}
          </span>
        )}
      </span>
    );
  const header = (title: ReactNode, total: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className="flex min-w-0 items-center gap-2">{title}</span>
      {total}
    </div>
  );

  const groups: TableGroup<BOMLine>[] = [];
  for (const g of bom.groups) {
    if (g.kind === "freeText") {
      const rows = g.lines
        .map((k) => byKey.get(k))
        .filter((l): l is BOMLine => !!l && visible(l));
      if (rows.length)
        groups.push({
          key: "free-text",
          header: header(t("bom.freeText"), subtotal(g.subtotal, g.converted)),
          rows,
        });
      continue;
    }
    const type = g.productType;
    if (!type) continue;
    const categories = g.categories
      .map((c) => ({
        c,
        rows: c.lines
          .map((k) => byKey.get(k))
          .filter((l): l is BOMLine => !!l && visible(l)),
      }))
      .filter((c) => c.rows.length > 0);
    if (!categories.length) continue;
    groups.push({
      key: type.id,
      header: header(
        <TypeBadge color={type.color} abbreviation={type.abbreviation}>
          {localize(type.name)}
        </TypeBadge>,
        subtotal(g.subtotal, g.converted),
      ),
      rows: [],
    });
    for (const { c, rows } of categories) {
      groups.push({
        key: `${type.id}-${c.category.id}`,
        level: 2,
        header: header(
          <span>{localize(c.category.name)}</span>,
          subtotal(c.subtotal, c.converted),
        ),
        rows,
      });
    }
  }
  const rows = groups.flatMap((g) => g.rows);

  const columns: Column<BOMLine>[] = [
    {
      header: t("bom.columns.image"),
      mobile: "media",
      className: "w-12",
      cell: (l) =>
        l.snapshot ? (
          <Thumbnail src={l.snapshot.imageUrl ?? undefined} />
        ) : null,
    },
    {
      header: t("bom.columns.product"),
      mobile: "title",
      className: "min-w-56",
      cell: (l) => {
        const name = lineName(l);
        return (
          <div className="space-y-1">
            <p className="font-medium">{name}</p>
            {l.snapshot?.modelNumber && (
              <p className="text-xs text-muted">{l.snapshot.modelNumber}</p>
            )}
            {l.addOnOf.length > 0 && (
              <p className="text-xs text-muted">
                {t("bom.addOnFor", {
                  names: l.addOnOf
                    .map((k) => (byKey.get(k) ? lineName(byKey.get(k)!) : ""))
                    .filter(Boolean)
                    .join(", "),
                })}
              </p>
            )}
            <StatusBadges line={l} name={name} onUpdate={onUpdate} />
          </div>
        );
      },
    },
  ];
  const quantity = (value: number) => (
    <span className="block text-right tabular-nums max-md:text-left">
      {value}
    </span>
  );
  if (filter) {
    const plan = bom.plans.find((p) => p.id === filter.planId);
    const zoneName =
      filter.zone === noZone
        ? t("bom.noZone")
        : plan?.zones.find((z) => z.id === filter.zone)?.name;
    columns.push({
      key: "filtered",
      header: zoneName ?? plan?.name ?? "",
      className: "text-right",
      cell: (l) => quantity(filteredQuantity(l, filter)),
    });
    columns.push({
      header: t("bom.columns.unitPrice"),
      className: "text-right",
      cell: (l) => amount(l.unitPrice, l.converted?.unitPrice),
    });
  } else {
    for (const p of bom.plans) {
      columns.push({
        key: `plan-${p.id}`,
        header: p.name,
        className: "text-right",
        cell: (l) => quantity(l.quantities.plans[p.id] ?? 0),
      });
    }
    columns.push(
      {
        header: t("bom.columns.manual"),
        className: "text-right",
        cell: (l) => quantity(l.quantities.manual),
      },
      {
        header: t("bom.columns.quantity"),
        className: "text-right font-medium",
        cell: (l) => quantity(l.quantity),
      },
      {
        header: t("bom.columns.unitPrice"),
        className: "text-right",
        cell: (l) => amount(l.unitPrice, l.converted?.unitPrice),
      },
      {
        header: t("bom.columns.total"),
        className: "text-right",
        cell: (l) => amount(l.total, l.converted?.total),
      },
    );
  }

  return (
    <DataTable
      label={t("bom.title")}
      rows={rows}
      groups={groups}
      columns={columns}
      rowKey={(l) => l.key}
      empty={
        <EmptyState title={filter ? t("bom.noneInFilter") : t("bom.empty")} />
      }
    />
  );
}

/**
 * Deleted / inactive / outdated. An outdated line (there are changes to take
 * over) is a button to "Update from catalog" when the user may change the
 * version; a deleted or inactive line has nothing to take over (D234).
 */
function StatusBadges({
  line,
  name,
  onUpdate,
}: {
  line: BOMLine;
  name: string;
  onUpdate?: () => void;
}) {
  const { t } = useTranslation("bom");
  const s = line.status;
  if (!s) return null;
  const statuses = [
    s.deleted && {
      key: "deleted",
      variant: "danger" as const,
      label: t("bom.status.deleted"),
    },
    s.inactive && {
      key: "inactive",
      variant: "warning" as const,
      label: t("bom.status.inactive"),
    },
    s.outdated && {
      key: "outdated",
      variant: "primary" as const,
      label: t("bom.status.outdated"),
    },
  ].filter((b) => !!b);
  if (!statuses.length) return null;
  const badges = statuses.map((b) => (
    <Badge key={b.key} variant={b.variant}>
      {b.label}
    </Badge>
  ));
  if (!onUpdate || !s.outdated)
    return <div className="flex flex-wrap gap-1">{badges}</div>;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto gap-1 px-0 py-0.5 hover:bg-transparent"
      aria-label={t("bom.statusAction", {
        statuses: statuses.map((b) => b.label).join(", "),
        name,
      })}
      title={t("bom.updateFromCatalog")}
      onClick={onUpdate}
    >
      {badges}
    </Button>
  );
}
