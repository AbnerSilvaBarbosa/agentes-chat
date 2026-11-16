import type { PoProgress, PoProgressCard, PoProgressGroup } from "@agenteschat/client";
import { useIssueAction, usePoProgress } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  columnsParam,
  hasLiveSpec,
  isBacklog,
  type LiveSpec,
  liveSpecs,
  releaseTarget,
  specBadge,
  specElapsed,
  specReasonKey,
} from "@agenteschat/client/lib/po-progress";
import { formatSpan } from "@agenteschat/client/lib/span";
import { Button, cx, GroupHeading, Icon, SkeletonList } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useEscClose } from "@/hooks/useEscClose";
import { useNow } from "@/hooks/useNow";
import { STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";
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

/**
 * "Liberar para dev": moves the card to its board's Ready for dev column as the person, through the board's own move
 * (the issue update). The panel reads again when it settles, so the card shows in its new group. A refusal is said
 * under the row and the card stays where it was.
 */
function ReleaseButton({ card, group }: { card: PoProgressCard; group: PoProgressGroup }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const move = useIssueAction(org.id, { silent: true });
  const target = releaseTarget(card, group);
  if (!target) return null;
  return (
    <div className="po-row__release">
      <Button
        size="sm"
        disabled={move.isPending}
        loading={move.isPending}
        onClick={() => move.mutate({ type: "update", id: card.id, patch: { columnId: target.id } })}
      >
        {t("poProgress.release")}
      </Button>
      {move.isError && (
        <p className="po-row__spec po-row__spec--failed ac-iconline" role="alert">
          <Icon name="alert" size={14} />
          <span>{t("poProgress.releaseFailed", { reason: errorText(t, move.error, i18n.language) })}</span>
        </p>
      )}
    </div>
  );
}

function Row({
  card,
  group,
  now,
  settled,
}: {
  card: PoProgressCard;
  group: PoProgressGroup;
  now: number;
  settled: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <li className={cx("po-row", settled && "po-row--settled")}>
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
      <ReleaseButton card={card} group={group} />
    </li>
  );
}

/** The groups the person opened (a Backlog starts closed), saved per person and workspace; storage may be blocked. */
function useOpenGroups() {
  const { org, me } = useOrg();
  const key = `${STORAGE_KEYS.poGroups}.${me.user.id}.${org.id}`;
  const [opened, setOpened] = useState(() => ({ key, keys: storedStrings(key) }));
  const keys = opened.key === key ? opened.keys : storedStrings(key);
  const toggle = useCallback(
    (group: string) => {
      const next = keys.includes(group) ? keys.filter((k) => k !== group) : [...keys, group];
      storage.set(key, JSON.stringify(next));
      setOpened({ key, keys: next });
    },
    [key, keys],
  );
  return { keys, toggle };
}

/** The cards whose spec just finished (queued or running, now done): each gets one short highlight, never again. */
function useSettled(groups: readonly PoProgressGroup[]) {
  const before = useRef(new Map<string, string>());
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Map<string, string>();
    const done: string[] = [];
    for (const g of groups)
      for (const c of g.items) {
        if (!c.spec) continue;
        now.set(c.id, c.spec.state);
        const was = before.current.get(c.id);
        if (c.spec.state === "done" && (was === "queued" || was === "running")) done.push(c.id);
      }
    before.current = now;
    if (done.length > 0) setSettled((s) => new Set([...s, ...done]));
  }, [groups]);
  return settled;
}

function Group({
  group,
  spaceId,
  now,
  settled,
  opened,
  toggle,
}: {
  group: PoProgressGroup;
  spaceId: string;
  now: number;
  settled: ReadonlySet<string>;
  opened: readonly string[];
  toggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = useGroupName()(group);
  // A Backlog starts closed; a group with a spec being written never closes.
  const collapsible = isBacklog(group) && !hasLiveSpec(group);
  const open = !collapsible || opened.includes(group.key);
  const listId = `po-group-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <section className="po-group" aria-label={name}>
      <GroupHeading
        level={3}
        title={name}
        count={group.count}
        aside={
          collapsible ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={open ? "chevronUp" : "chevronDown"}
              aria-expanded={open}
              aria-controls={listId}
              aria-label={t(open ? "poProgress.collapseGroup" : "poProgress.expandGroup", { name })}
              title={t(open ? "poProgress.collapseGroup" : "poProgress.expandGroup", { name })}
              onClick={() => toggle(group.key)}
            />
          ) : undefined
        }
      />
      {open && group.items.length > 0 && (
        <ul className="list-card po-list" id={listId}>
          {group.items.map((card) => (
            <Row key={card.id} card={card} group={group} now={now} settled={settled.has(card.id)} />
          ))}
        </ul>
      )}
      {open && group.count > group.items.length && (
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

/** The five cells of the working mark: a pixel bar that sweeps while the spec runs, still when queued or reduced. */
function Pixels({ running }: { running: boolean }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  return (
    <span
      className={cx("po-pix", running && !reduced && "po-pix--run")}
      data-state={running ? "running" : "queued"}
      aria-hidden
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} style={{ "--i": i } as CSSProperties} />
      ))}
    </span>
  );
}

/**
 * "Gerando spec": above every group, one row per card whose spec is queued or running, with the time it has waited and a
 * working mark that moves only while it runs. Not drawn at all when nothing is being written, so it costs nothing.
 */
function LiveSpecs({ items, now }: { items: LiveSpec[]; now: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const elapsed = (card: PoProgressCard, at: number) => {
    const { hours, minutes } = specElapsed(card, at);
    if (hours > 0) return t("poProgress.elapsedHour", { hours, minutes });
    return minutes > 0 ? t("poProgress.elapsedMin", { minutes }) : t("poProgress.elapsedNow");
  };
  return (
    <section className="po-live" aria-label={t("poProgress.liveTitle")}>
      <GroupHeading level={3} title={t("poProgress.liveTitle")} count={items.length} />
      <ul className="list-card po-list">
        {items.map(({ card, state }) => (
          <li key={card.id} className="po-live__row" data-state={state}>
            <Pixels running={state === "running"} />
            <Link
              className="po-row__main po-live__main"
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(card.number) }}
            >
              <span className="po-row__title">
                <span className="po-row__number">#{card.number}</span> {card.title}
              </span>
              <span className="po-live__state">
                {state === "running" ? t("poProgress.liveRunning") : t("poProgress.specQueued")} · {elapsed(card, now)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Body({ data }: { data: PoProgress }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // One minute clock for the whole panel.
  const now = useNow(60_000);
  const { keys: opened, toggle } = useOpenGroups();
  const settled = useSettled(data.groups);
  const live = liveSpecs(data.groups);
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
          {live.length > 0 && <LiveSpecs items={live} now={now} />}
          {data.groups.map((g) => (
            <Group
              key={g.key}
              group={g}
              spaceId={data.space.id}
              now={now}
              settled={settled}
              opened={opened}
              toggle={toggle}
            />
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
