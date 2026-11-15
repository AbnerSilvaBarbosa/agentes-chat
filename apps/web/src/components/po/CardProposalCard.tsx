import type { CardProposalEdits, CardProposalView, Message } from "@agenteschat/client";
import { useCardProposal, useIssueProjects } from "@agenteschat/client";
import type { CardProposalCard } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { Alert, Button, EventPillAction, Field, FormStack, Icon, Input, Select, Textarea } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import "./po-card.css";

/** A card of the workspace by its number, as a link to its page. */
function CardLink({ number }: { number: number }) {
  const { org } = useOrg();
  return (
    <Link to="/org/$orgId/issues/$number" params={{ orgId: org.id, number: String(number) }} className="ac-link">
      #{number}
    </Link>
  );
}

/** Why a spec did not finish: the codes the server writes are said in words, any other text is the run's own. */
const SPEC_REASONS = {
  po_missing: "poCard.specReason.po_missing",
  card_gone: "poCard.specReason.card_gone",
  no_spec_page: "poCard.specReason.no_spec_page",
  run_missing: "poCard.specReason.run_missing",
  stopped: "poCard.specReason.stopped",
  failed: "poCard.specReason.failed",
} as const;

/** How the spec of a confirmed card stands: it follows the card's snapshot (`card.proposal.updated`), never polls. */
function SpecLine({ spec }: { spec: NonNullable<CardProposalView["spec"]> }) {
  const { t } = useTranslation();
  if (spec.state === "queued") return <>{t("poCard.specQueued")}</>;
  if (spec.state === "running") return <>{t("poCard.specRunning")}</>;
  if (spec.state === "done") return <>{t("poCard.specDone")}</>;
  const known = spec.error ? SPEC_REASONS[spec.error as keyof typeof SPEC_REASONS] : SPEC_REASONS.stopped;
  const reason = known ? t(known) : spec.error;
  return <>{t("poCard.specFailed", { reason })}</>;
}

/** "Ver spec": the wiki page the PO wrote. */
function SpecOpen({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  return (
    <EventPillAction onClick={() => void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug } })}>
      {t("poCard.specOpen")}
    </EventPillAction>
  );
}

/**
 * The PO's card proposal in its chat (ADR 0185): the person it was written for creates the card there, as they edited
 * it, or drops it; anyone else reads who decides. Editar turns the fields into inputs and Criar sends what is in them.
 * A refusal (an archived board, no right to post) shows under the buttons and the proposal stays, so another board can
 * be picked. Decided, it is one line: the card made with its number as a link, or the proposal dropped.
 */
export function CardProposalCardView({ message, card }: { message: Message; card: CardProposalCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const actors = useActors();
  const decide = useCardProposal(org.id, { channelId: message.channelId, messageId: message.id });
  const p = card.proposal;
  const label = t("chat.body.card_proposal", { title: p.title });
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (p.status !== "pending") {
    return (
      <RequestDone
        done={p.status === "confirmed"}
        label={label}
        action={p.spec?.state === "done" && p.spec.page ? <SpecOpen slug={p.spec.page.slug} /> : undefined}
        note={p.status === "confirmed" && p.spec ? <SpecLine spec={p.spec} /> : undefined}
      >
        <b>{p.title}</b> ·{" "}
        {p.status === "confirmed" && p.issue ? (
          <>
            {t("poCard.created")} <CardLink number={p.issue.number} />
          </>
        ) : (
          t("poCard.dismissed")
        )}
      </RequestDone>
    );
  }
  const mine = p.requesterUserId === me.user.id;
  const run = (action: Parameters<typeof decide.mutate>[0]) => {
    setRefusal(null);
    decide.mutate(action, { onError: (error) => setRefusal(errorText(t, error, i18n.language)) });
  };
  const asker = actors.name({ type: "person", id: p.requesterUserId });
  return (
    <ProposalEditor
      key={editing ? "edit" : "read"}
      p={p}
      label={label}
      mine={mine}
      editing={editing}
      busy={decide.isPending}
      refusal={refusal}
      asker={asker}
      onEdit={() => setEditing(true)}
      onCancel={() => {
        setEditing(false);
        setRefusal(null);
      }}
      onCreate={(edits) => run({ id: p.id, decision: "confirm", edits })}
      onDiscard={() => run({ id: p.id, decision: "dismiss" })}
    />
  );
}

function ProposalEditor({
  p,
  label,
  mine,
  editing,
  busy,
  refusal,
  asker,
  onEdit,
  onCancel,
  onCreate,
  onDiscard,
}: {
  p: CardProposalView;
  label: string;
  mine: boolean;
  editing: boolean;
  busy: boolean;
  refusal: string | null;
  asker: string;
  onEdit: () => void;
  onCancel: () => void;
  onCreate: (edits?: CardProposalEdits) => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const boards = useIssueProjects(org.id).data?.projects ?? [];
  const [title, setTitle] = useState(p.title);
  const [summary, setSummary] = useState(p.summary);
  const [criteria, setCriteria] = useState(p.criteria);
  const [draft, setDraft] = useState("");
  const [projectId, setProjectId] = useState(p.project.id);
  const options = boards
    .filter((b) => b.spaceId === p.spaceId && !b.archived)
    .map((b) => ({ value: b.id, label: b.name }));
  // The board the PO chose stays an option even when it went away: Criar then says why and another is picked.
  if (!options.some((o) => o.value === p.project.id)) options.unshift({ value: p.project.id, label: p.project.name });
  const create = () => {
    if (!editing) return onCreate();
    const rest = draft.trim();
    onCreate({
      title: title.trim(),
      summary: summary.trim(),
      criteria: [...criteria, ...(rest ? [rest] : [])].map((c) => c.trim()).filter(Boolean),
      projectId,
    });
  };
  const actions = mine ? (
    <>
      <EventPillAction primary disabled={busy || (editing && !title.trim())} onClick={create}>
        {t("poCard.create")}
      </EventPillAction>
      {editing ? (
        <EventPillAction disabled={busy} onClick={onCancel}>
          {t("poCard.cancelEdit")}
        </EventPillAction>
      ) : (
        <EventPillAction disabled={busy} onClick={onEdit}>
          {t("poCard.edit")}
        </EventPillAction>
      )}
      <EventPillAction disabled={busy} onClick={onDiscard}>
        {t("poCard.discard")}
      </EventPillAction>
    </>
  ) : undefined;
  return (
    <RequestOpen
      mine={mine}
      icon="issues"
      label={label}
      action={actions}
      below={
        <>
          {p.duplicateOf && (
            <p className="po-card__dup ac-iconline">
              <Icon name="alert" size={14} />
              <span>
                {t("poCard.duplicate", { number: p.duplicateOf.number })}{" "}
                <Link
                  to="/org/$orgId/issues/$number"
                  params={{ orgId: org.id, number: String(p.duplicateOf.number) }}
                  className="ac-link"
                >
                  #{p.duplicateOf.number}
                </Link>
              </span>
            </p>
          )}
          {editing ? (
            <FormStack className="po-card__form">
              <Field label={t("poCard.fieldTitle")}>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label={t("poCard.fieldSummary")}>
                <Textarea value={summary} rows={3} onChange={(e) => setSummary(e.target.value)} />
              </Field>
              <Field label={t("issues.criteria")} group>
                <ul className="po-card__edits">
                  {criteria.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the list is edited in place, by position
                    <li key={i}>
                      <Input
                        value={c}
                        aria-label={t("issues.criteria")}
                        onChange={(e) => setCriteria((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon="close"
                        aria-label={t("issues.form.removeCriterion")}
                        onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))}
                      />
                    </li>
                  ))}
                  <li>
                    <Input
                      value={draft}
                      placeholder={t("issues.form.addCriterion")}
                      aria-label={t("issues.form.addCriterion")}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !draft.trim()) return;
                        e.preventDefault();
                        setCriteria((all) => [...all, draft.trim()]);
                        setDraft("");
                      }}
                    />
                  </li>
                </ul>
              </Field>
              <Field label={t("poCard.fieldBoard")}>
                <Select value={projectId} onValueChange={setProjectId} options={options} />
              </Field>
            </FormStack>
          ) : (
            <>
              {p.summary && <p>{p.summary}</p>}
              {p.criteria.length > 0 && (
                <ul className="po-card__criteria" aria-label={t("issues.criteria")}>
                  {p.criteria.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a criterion repeats, the list never reorders
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              <p>{t("poCard.board", { name: p.project.name })}</p>
            </>
          )}
          {!mine && asker && <p>{t("poCard.waits", { name: asker })}</p>}
          {refusal && <Alert>{refusal}</Alert>}
        </>
      }
    >
      {p.title}
    </RequestOpen>
  );
}
