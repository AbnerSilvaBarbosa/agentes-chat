import type { PoProgress, PoProgressCard, PoProgressGroup } from "@agenteschat/client";
import { usePoProgress } from "@agenteschat/client";
import { columnsParam, specBadge, specReasonKey } from "@agenteschat/client/lib/po-progress";
import { formatSpan } from "@agenteschat/client/lib/span";
import { Button, GroupHeading, Icon, SkeletonList } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useEscClose } from "@/hooks/useEscClose";
import { useNow } from "@/hooks/useNow";
import "./po-progress.css";

/** The words of a group: the tail's label, a column's own name, or its stage's name when it has none. */
function useGroupName() {
  const { t } = useTranslation();
  return (g: PoProgressGroup) => (g.kind === "tail" ? t("poProgress.tail") : (g.name ?? t(`issues.status.${g.stage}`)));
}

/** A row's spec line: queued, running, ready with "Ver spec", or failed with why. Words, never colour alone. */
function SpecLine({ card, group }: { card: PoProgressCard; group: PoProgressGroup }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const badge = specBadge(card, group);
  if (!badge) return null;
  if (badge.kind === "queued") return <p className="po-row__spec">{t("poProgress.specQueued")}</p>;
  if (badge.kind === "running") return <p className="po-row__spec">{t("poProgress.specRunning")}</p>;
  if (badge.kind === "ready")
    return (
      <p className="po-row__spec ac-actline">
        <span className="ac-iconline">
          <Icon name="check" size={14} />
          {t("poProgress.specReady")}
        </span>
        {badge.page && (
          <Link className="ac-link" to="/org/$orgId/wiki/$slug" params={{ orgId: org.id, slug: badge.page.slug }}>
            {t("poProgress.viewSpec")}
          </Link>
        )}
      </p>
    );
  return (
    <p className="po-row__spec po-row__spec--failed ac-iconline">
      <Icon name="alert" size={14} />
      <span>{t("poProgress.specFailed", { reason: t(specReasonKey(badge.reason)) })}</span>
    </p>
  );
}

function Row({ card, group }: { card: PoProgressCard; group: PoProgressGroup }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const now = useNow(60_000);
  return (
    <li className="po-row">
      <Link
        className="po-row__main"
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(card.number) }}
      >
        <span className="po-row__title">
          <span className="po-row__number">#{card.number}</span> {card.title}
        </span>
        <span className="po-row__meta">
          {card.boardName} · {t("poProgress.since", { span: formatSpan(now - Date.parse(card.since)) })}
        </span>
      </Link>
      <SpecLine card={card} group={group} />
    </li>
  );
}

function Group({ group, spaceId }: { group: PoProgressGroup; spaceId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = useGroupName()(group);
  return (
    <section className="po-group" aria-label={name}>
      <GroupHeading level={3} title={name} count={group.count} />
      {group.items.length > 0 && (
        <ul className="list-card po-list">
          {group.items.map((card) => (
            <Row key={card.id} card={card} group={group} />
          ))}
        </ul>
      )}
      {group.count > group.items.length && (
        <Link
          className="home-sec__more po-group__more"
          to="/org/$orgId/issues"
          params={{ orgId: org.id }}
          search={{ space: spaceId, columns: columnsParam(group) } as never}
        >
          {t("poProgress.seeAll")}
        </Link>
      )}
    </section>
  );
}

function Body({ data }: { data: PoProgress }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const empty = data.groups.every((g) => g.count === 0) && data.done === 0;
  return (
    <>
      <header className="po-prog__head">
        <h2 className="po-prog__title">{t("poProgress.title")}</h2>
        <p className="po-prog__company">{data.space.name}</p>
        <Link
          className="ac-link po-prog__board"
          to="/org/$orgId/issues"
          params={{ orgId: org.id }}
          search={{ space: data.space.id } as never}
        >
          {t("poProgress.openBoard")}
        </Link>
      </header>
      {empty ? (
        <p className="po-prog__empty">{t("poProgress.empty")}</p>
      ) : (
        <>
          {data.groups.map((g) => (
            <Group key={g.key} group={g} spaceId={data.space.id} />
          ))}
          <p className="po-prog__done">{t("poProgress.done", { count: data.done })}</p>
        </>
      )}
    </>
  );
}

function Content({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const progress = usePoProgress(org.id, spaceId);
  if (progress.isError) return <ErrorState error={progress.error} onRetry={() => void progress.refetch()} />;
  if (!progress.data) return <SkeletonList label={t("poProgress.loading")} count={3} avatar={false} />;
  return <Body data={progress.data} />;
}

/**
 * The right column of a company's PO chat (ADR 0185 addendum): its cards by stage, following the board's columns, live
 * through the events the app already hears. Beside the conversation on a wide window; with `onClose` it floats over
 * the chat as the app's panels do, opened by the header's button.
 */
export function PoProgressPanel({ spaceId, onClose }: { spaceId: string; onClose?: () => void }) {
  const { t } = useTranslation();
  if (!onClose) {
    return (
      <aside className="members-side po-side" aria-label={t("poProgress.label")}>
        <div className="po-side__scroll">
          <Content spaceId={spaceId} />
        </div>
      </aside>
    );
  }
  return <Floating spaceId={spaceId} onClose={onClose} />;
}

function Floating({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  return (
    <SidePanel className="po-side po-side--float" label={t("poProgress.label")} onClose={onClose}>
      <Button
        size="sm"
        iconOnly
        icon="close"
        className="agp-glass po-side__close"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={onClose}
      />
      <div className="po-side__scroll">
        <Content spaceId={spaceId} />
      </div>
    </SidePanel>
  );
}
