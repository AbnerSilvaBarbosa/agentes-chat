import { type CompanyDashboard as CompanyNumbers, useCompanyDashboard } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { formatSpan } from "@agenteschat/client/lib/span";
import { Button, EmptyState, Segmented, WidgetCard } from "@agenteschat/ui";
import type { WidgetSpec } from "@agenteschat/ui/widgets/spec";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import "./company-dashboard.css";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** The most weeks a period holds (90 days touch up to 14), so every week keeps its bar. */
const WEEKS_MAX = 14;

/**
 * A company's Painel (ADR 0226): the numbers of the tasks on its boards for the last 7, 30 or 90 days, 30 at first,
 * drawn with the Painéis' own cards. Read when it opens and when the period changes; nothing here is built or
 * refreshed by anyone. `onNewBoard`: the empty company's way in.
 */
export function CompanyDashboard({
  orgId,
  spaceId,
  onNewBoard,
}: {
  orgId: string;
  spaceId: string;
  onNewBoard?: () => void;
}) {
  const { t } = useTranslation();
  const [days, setDays] = useState<Period>(30);
  const query = useCompanyDashboard(orgId, spaceId, days);
  const data = query.data;
  return (
    <div className="cdash">
      <Segmented
        size="sm"
        label={t("issues.dashboard.periodLabel")}
        value={String(days)}
        onValueChange={(v) => setDays(Number(v) as Period)}
        options={PERIODS.map((d) => ({ value: String(d), label: t("issues.dashboard.days", { count: d }) }))}
      />
      {query.isLoading && <LoadingList count={4} avatar={false} />}
      {query.isError && !data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {data &&
        (data.total === 0 ? (
          <EmptyState
            size="panel"
            actions={
              onNewBoard && (
                <Button variant="primary" icon="plus" onClick={onNewBoard}>
                  {t("issues.projects.new")}
                </Button>
              )
            }
          >
            {t("issues.dashboard.empty")}
          </EmptyState>
        ) : (
          <Cards data={data} />
        ))}
    </div>
  );
}

/** A week's first day, as the language writes a day and month ("9 de nov.", "Nov 9"). */
function weekLabel(locale: string, day: string) {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00`));
}

function Cards({ data }: { data: CompanyNumbers }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const number = (title: string, value: number, note?: string): ReactNode => (
    <Cell key={title}>
      <WidgetCard
        title={title}
        spec={{ kind: "kpi", value, note }}
        status="ok"
        color="sky"
        size={{ w: 1, h: 1 }}
        locale={locale}
        footer={null}
      />
    </Cell>
  );
  const weekly: WidgetSpec = {
    kind: "bars",
    labels: data.weekly.map((w) => weekLabel(locale, w.weekStart)),
    values: data.weekly.map((w) => w.count),
    unit: t("issues.dashboard.weeklyUnit"),
  };
  return (
    <div className="wgrid cdash__grid">
      {number(t("issues.status.todo"), data.stages.todo)}
      {number(t("issues.status.in_progress"), data.stages.in_progress)}
      {number(t("issues.status.in_review"), data.stages.in_review)}
      {number(t("issues.dashboard.done"), data.stages.done, t("issues.dashboard.doneNote", { days: data.days }))}
      {number(t("issues.dashboard.late"), data.late, t("issues.dashboard.lateNote"))}
      {number(t("issues.dashboard.unassigned"), data.unassigned, t("issues.dashboard.unassignedNote"))}
      <Cell w={2}>
        <WidgetCard
          title={t("issues.dashboard.weekly")}
          spec={weekly}
          status="ok"
          color="sky"
          size={{ w: 2, h: 1 }}
          locale={locale}
          maxBars={WEEKS_MAX}
          footer={null}
        />
      </Cell>
      <SpanBlock title={t("issues.dashboard.leadTime")} stats={data.leadTime} />
      <SpanBlock title={t("issues.dashboard.workTime")} stats={data.workTime} />
      <People data={data} />
      {data.cost && (
        <Block title={t("issues.dashboard.cost")}>
          <div className="wk-num">
            <span>{formatUsd(locale, data.cost.totalUsd)}</span>
          </div>
          <div className="wk-sub">{t("issues.dashboard.costNote")}</div>
          {data.cost.byAgent.length > 0 && (
            <ul className="wk-list cdash__rows">
              {data.cost.byAgent.map((a) => (
                <li key={a.agentId}>
                  <ActorAvatar size="xs" actor={{ type: "agent", id: a.agentId }} name={a.name} />
                  <span className="wk-list__t">{a.name}</span>
                  <span className="wk-list__s">{formatUsd(locale, a.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      )}
    </div>
  );
}

function Cell({ w = 1, children }: { w?: 1 | 2; children: ReactNode }) {
  return (
    <div className="wb-cell" data-w={w}>
      {children}
    </div>
  );
}

/** A card of the Painéis' look that holds more than a widget spec draws (a face, a time): same head, same body. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Cell w={2}>
      <article className="ac-card wg" data-w="2" data-h="1" aria-label={title}>
        <div className="wg__head">
          <span className="wg__title">{title}</span>
        </div>
        <div className="wg__body">{children}</div>
        <div className="wg__foot" />
      </article>
    </Cell>
  );
}

/** How long tasks took: the median as the number, the average and how many were measured under it. */
function SpanBlock({ title, stats }: { title: string; stats: CompanyNumbers["leadTime"] }) {
  const { t } = useTranslation();
  return (
    <Block title={title}>
      <div className="wk-num">
        <span>{formatSpan(stats.medianMs)}</span>
        <small className="wk-num__suf">{t("issues.dashboard.median")}</small>
      </div>
      <ul className="wk-list cdash__rows">
        <li>
          <span className="wk-list__t">{t("issues.dashboard.average")}</span>
          <span className="wk-list__s">{formatSpan(stats.averageMs)}</span>
        </li>
        <li>
          <span className="wk-list__t">{t("issues.dashboard.measured", { count: stats.count })}</span>
        </li>
      </ul>
    </Block>
  );
}

/** Who carries the tasks, agents and people together, "Sem responsável" last. */
function People({ data }: { data: CompanyNumbers }) {
  const { t } = useTranslation();
  return (
    <Block title={t("issues.dashboard.people")}>
      <ul className="wk-list cdash__rows cdash__people">
        <li className="cdash__headrow" aria-hidden="true">
          <span className="wk-list__t" />
          <span className="cdash__n">{t("issues.dashboard.open")}</span>
          <span className="cdash__n">{t("issues.dashboard.concluded")}</span>
        </li>
        {data.assignees.map((a) => (
          <li key={`${a.type}:${a.id}`}>
            {a.type === "removed" ? null : <ActorAvatar size="xs" actor={{ type: a.type, id: a.id }} name={a.name} />}
            <span className="wk-list__t">{a.type === "removed" ? t("issues.dashboard.removed") : a.name}</span>
            <span className="cdash__n">{a.open}</span>
            <span className="cdash__n">{a.done}</span>
          </li>
        ))}
        <li>
          <span className="wk-list__t">{t("issues.dashboard.unassigned")}</span>
          <span className="cdash__n">{data.unassigned}</span>
          <span className="cdash__n" />
        </li>
      </ul>
    </Block>
  );
}
