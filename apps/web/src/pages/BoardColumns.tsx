import type { BoardAlert, IssueColumn, IssueColumnTemplate, IssueStatus } from "@agenteschat/client";
import {
  useAgents,
  useBoardAlertAction,
  useBoardAlerts,
  useIssueColumnAction,
  useIssueColumnTemplateAction,
  useIssueColumnTemplates,
} from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  InfoHint,
  Input,
  Menu,
  MenuItem,
  Select,
  Switch,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** The stages a column can sit in, in board order; `canceled` is kept off the board and out of this screen. */
export const CONFIGURABLE_STAGES: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];

/** A column as the editor draws it: its name as shown, and the stage it sits in. `id` only has to be unique here. */
export interface EditorColumn {
  id: string;
  name: string;
  stage: IssueStatus;
  /** A task sitting here waits for a person (ADR 0184). */
  waits?: boolean;
}

/**
 * The columns of a board or of a status set, by stage: each renamed, moved up or down inside its stage, moved to
 * another stage, deleted, and one added at the end of any stage. It holds no data of its own: the board's dialog sends
 * each gesture to the server, the settings screen edits a set's list (ADR 0179).
 */
export function ColumnEditor({
  columns,
  busy = false,
  readOnly = false,
  canDelete = (_column, inStage) => inStage.length > 1,
  onRename,
  onStage,
  onMove,
  onAdd,
  onDelete,
  onWaits,
}: {
  /** In board order: by stage, then position. */
  columns: EditorColumn[];
  /** A write is on its way: the moves and the delete wait. */
  busy?: boolean;
  /** Only the names, by stage: no control that changes anything. */
  readOnly?: boolean;
  /** Whether a column may go; by default a stage keeps one. */
  canDelete?: (column: EditorColumn, inStage: EditorColumn[]) => boolean;
  onRename: (id: string, name: string) => void;
  onStage: (id: string, stage: IssueStatus) => void;
  /** `index`: its new place among its stage's columns. */
  onMove: (id: string, index: number) => void;
  /** A promise it returns settles when the column was added (the form closes); a rejection keeps the form open. */
  onAdd: (stage: IssueStatus, name: string, afterId: string | null) => unknown;
  /** `moveTo`: another column of its stage, for the board to send its tasks to. */
  onDelete: (id: string, moveTo: string | null) => void;
  /**
   * The switch "Espera uma pessoa" on each column (ADR 0184). Without it, or read only, the rows show no switch.
   */
  onWaits?: (id: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<IssueStatus | null>(null);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = (c: EditorColumn) => {
    const value = (draft[c.id] ?? "").trim();
    if (!value || value === c.name) return;
    onRename(c.id, value.slice(0, 40));
  };
  return (
    <div className="board-columns">
      {CONFIGURABLE_STAGES.map((stage) => {
        const inStage = columns.filter((c) => c.stage === stage);
        if (readOnly && inStage.length === 0) return null;
        return (
          <section key={stage} className="board-columns__stage" aria-label={t(`issues.status.${stage}`)}>
            <h3>{t(`issues.status.${stage}`)}</h3>
            {inStage.map((c, index) =>
              readOnly ? (
                <p key={c.id} className="board-columns__row">
                  {c.name}
                </p>
              ) : (
                <div key={c.id} className="board-columns__row">
                  <Input
                    aria-label={t("issues.columns.nameLabel")}
                    value={draft[c.id] ?? c.name}
                    maxLength={40}
                    onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                    onBlur={() => save(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <Select
                    size="sm"
                    aria-label={t("issues.columns.stage")}
                    value={c.stage}
                    onValueChange={(next) => onStage(c.id, next as IssueStatus)}
                    options={CONFIGURABLE_STAGES.map((s) => ({ value: s, label: t(`issues.status.${s}`) }))}
                  />
                  {onWaits && (
                    <div className="board-columns__waits">
                      <Switch
                        id={`column-waits-${c.id}`}
                        checked={c.waits === true}
                        onCheckedChange={(on) => onWaits(c.id, on)}
                        disabled={busy}
                      />
                      <span className="ac-hintline">
                        <label htmlFor={`column-waits-${c.id}`}>{t("issues.columns.waits")}</label>
                        <InfoHint name={t("common.about", { label: t("issues.columns.waits") })}>
                          {t("issues.columns.waitsHint")}
                        </InfoHint>
                      </span>
                    </div>
                  )}
                  <div className="board-columns__moves">
                    <Button
                      size="sm"
                      iconOnly
                      icon="arrowUp"
                      aria-label={t("issues.columns.moveLeft")}
                      disabled={index === 0 || busy}
                      onClick={() => onMove(c.id, index - 1)}
                    />
                    <Button
                      size="sm"
                      iconOnly
                      icon="arrowDown"
                      aria-label={t("issues.columns.moveRight")}
                      disabled={index === inStage.length - 1 || busy}
                      onClick={() => onMove(c.id, index + 1)}
                    />
                    <Button
                      size="sm"
                      iconOnly
                      icon="trash"
                      aria-label={t("issues.columns.delete")}
                      disabled={!canDelete(c, inStage) || busy}
                      onClick={() => onDelete(c.id, inStage.find((o) => o.id !== c.id)?.id ?? null)}
                    />
                  </div>
                </div>
              ),
            )}
            {readOnly ? null : adding === stage ? (
              <form
                className="board-columns__row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = newName.trim();
                  if (!value) return;
                  void Promise.resolve(onAdd(stage, value, inStage.at(-1)?.id ?? null)).then(
                    () => {
                      setNewName("");
                      setAdding(null);
                    },
                    () => {},
                  );
                }}
              >
                <Input
                  autoFocus
                  aria-label={t("issues.columns.nameLabel")}
                  value={newName}
                  maxLength={40}
                  placeholder={t("issues.columns.nameLabel")}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <Button type="submit" variant="primary" disabled={!newName.trim()}>
                  {t("common.save")}
                </Button>
              </form>
            ) : (
              <Button size="sm" icon="plus" onClick={() => setAdding(stage)}>
                {t("issues.columns.add")}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The "from" choice that names no column: a rule on any move into its destination. */
const ANY_STATUS = "any";

/**
 * "Avisos" (ADR 0175 addendum): the board's rules, each "from a status to a status, alert this agent", and the form
 * that adds one. A rule is a routine on `issue.moved`, so the list shows the ones people and agents made elsewhere too.
 */
function BoardAlerts({ projectId, columns }: { projectId: string; columns: IssueColumn[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const alerts = useBoardAlerts(org.id, projectId).data ?? [];
  const action = useBoardAlertAction(org.id, projectId);
  const agents = (useAgents(org.id).data ?? []).filter((a) => mayAsk(org, a));
  const [adding, setAdding] = useState(false);
  const [to, setTo] = useState("");
  const [from, setFrom] = useState(ANY_STATUS);
  const [agentId, setAgentId] = useState("");
  const nameOf = (id: string | null) => {
    const c = columns.find((col) => col.id === id);
    return c ? (c.name ?? t(`issues.status.${c.stage}`)) : t("issues.alerts.unknownStatus");
  };
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const toId = to || columns[0]?.id || "";
  const agent = agentId || agents[0]?.id || "";
  const reason = (a: BoardAlert) =>
    a.pausedReason === "agent_archived" ? t("issues.alerts.agentArchived") : t("issues.alerts.pausedOther");
  return (
    <section className="board-columns__stage board-alerts" aria-label={t("issues.alerts.title")}>
      <h3>{t("issues.alerts.title")}</h3>
      {alerts.length === 0 && !adding && <p className="board-columns__note">{t("issues.alerts.empty")}</p>}
      {alerts.map((a) => (
        <div key={a.id} className="board-columns__row board-alerts__row">
          <p className="board-alerts__text">
            <span>
              {t("issues.alerts.row", {
                from: a.fromColumnId ? nameOf(a.fromColumnId) : t("issues.alerts.any"),
                to: nameOf(a.columnId),
              })}
            </span>
            {" → "}
            <strong>{a.agentName}</strong>
            {a.paused && (
              <span className="board-alerts__paused">{t("issues.alerts.paused", { reason: reason(a) })}</span>
            )}
          </p>
          <Button
            size="sm"
            iconOnly
            icon="trash"
            aria-label={t("issues.alerts.remove")}
            disabled={action.isPending}
            onClick={() => action.mutate({ type: "remove", alertId: a.id }, { onError: failed })}
          />
        </div>
      ))}
      {adding ? (
        <form
          className="board-alerts__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!toId || !agent) return;
            action.mutate(
              { type: "add", agentId: agent, columnId: toId, fromColumnId: from === ANY_STATUS ? null : from },
              {
                onSuccess: () => {
                  setAdding(false);
                  setTo("");
                  setFrom(ANY_STATUS);
                  setAgentId("");
                },
                onError: failed,
              },
            );
          }}
        >
          <Field label={t("issues.alerts.to")} id="board-alert-to">
            <Select
              id="board-alert-to"
              aria-label={t("issues.alerts.to")}
              value={toId}
              onValueChange={setTo}
              options={columns.map((c) => ({ value: c.id, label: nameOf(c.id) }))}
            />
          </Field>
          <Field label={t("issues.alerts.from")} id="board-alert-from">
            <Select
              id="board-alert-from"
              aria-label={t("issues.alerts.from")}
              value={from}
              onValueChange={setFrom}
              options={[
                { value: ANY_STATUS, label: t("issues.alerts.any") },
                ...columns.filter((c) => c.id !== toId).map((c) => ({ value: c.id, label: nameOf(c.id) })),
              ]}
            />
          </Field>
          <Field label={t("issues.alerts.agent")} id="board-alert-agent">
            <Select
              id="board-alert-agent"
              aria-label={t("issues.alerts.agent")}
              value={agent}
              onValueChange={setAgentId}
              placeholder={t("issues.alerts.agentPlaceholder")}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <div className="board-alerts__actions">
            <Button type="button" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!toId || !agent || action.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" icon="plus" onClick={() => setAdding(true)} disabled={columns.length === 0}>
          {t("issues.alerts.add")}
        </Button>
      )}
    </section>
  );
}

/**
 * "Colunas do board" (ADR 0179): every column of a board, in its stage, where a column is renamed, moved up or down
 * inside its stage, moved to another stage (its tasks follow), added and deleted — and where a template is applied to
 * the board or saved from it. Before this, changing where a column sat meant deleting it and making another.
 */
export function BoardColumnsDialog({
  open,
  projectId,
  columns,
  onClose,
}: {
  open: boolean;
  /** The board whose columns these are; null: the workspace's own set. */
  projectId: string | null;
  columns: IssueColumn[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueColumnAction(org.id, projectId);
  const templateAction = useIssueColumnTemplateAction(org.id);
  const templates = useIssueColumnTemplates(org.id).data ?? [];
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  if (!open) return null;
  const nameOf = (c: IssueColumn) => c.name ?? t(`issues.status.${c.stage}`);
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t("issues.columns.configTitle")}
      description={t("issues.columns.configBody")}
      closeLabel={t("common.close")}
      width={760}
    >
      <DialogBody>
        <ColumnEditor
          columns={columns.map((c) => ({
            id: c.id,
            name: nameOf(c),
            stage: c.stage,
            waits: c.waitsForPerson,
          }))}
          busy={action.isPending}
          onRename={(id, name) => action.mutate({ type: "update", columnId: id, name: name.slice(0, 40) })}
          onStage={(id, stage) => action.mutate({ type: "update", columnId: id, stage })}
          onMove={(id, index) => action.mutate({ type: "update", columnId: id, index })}
          onWaits={(id, on) => action.mutate({ type: "update", columnId: id, waitsForPerson: on })}
          onAdd={(stage, name, afterId) => action.mutateAsync({ type: "add", name, stage, afterId })}
          onDelete={(id, moveTo) => {
            if (moveTo) action.mutate({ type: "delete", columnId: id, moveTo });
          }}
        />
        {!projectId && <p className="board-columns__note">{t("issues.columns.workspaceNote")}</p>}
        {projectId && <BoardAlerts projectId={projectId} columns={columns} />}
      </DialogBody>
      <DialogFooter>
        {projectId && (
          <>
            <Button onClick={() => setSavingTemplate(true)} disabled={templateAction.isPending || savingTemplate}>
              {t("issues.columns.saveTemplate")}
            </Button>
            <Menu
              label={t("issues.columns.applyTemplate")}
              trigger={<Button icon="layers">{t("issues.columns.applyTemplate")}</Button>}
            >
              {templates.map((tpl: IssueColumnTemplate) => (
                <MenuItem
                  key={tpl.id}
                  icon="layers"
                  onSelect={() =>
                    templateAction.mutate(
                      { type: "apply", projectId, templateId: tpl.id },
                      {
                        onSuccess: () => toast.show(t("issues.columns.applied", { name: tpl.name }), "info"),
                      },
                    )
                  }
                >
                  {tpl.name}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
        <Button variant="primary" onClick={onClose}>
          {t("common.done")}
        </Button>
      </DialogFooter>
      {savingTemplate && (
        <Dialog
          open
          onOpenChange={(next) => !next && setSavingTemplate(false)}
          title={t("issues.columns.templateName")}
          closeLabel={t("common.close")}
          width={420}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = templateName.trim();
              if (!value) return;
              templateAction.mutate(
                { type: "save", name: value, projectId },
                {
                  onSuccess: () => {
                    setSavingTemplate(false);
                    setTemplateName("");
                    toast.show(t("issues.columns.templateSaved", { name: value }), "info");
                  },
                },
              );
            }}
          >
            <DialogBody>
              <Input
                autoFocus
                aria-label={t("issues.columns.templateName")}
                value={templateName}
                maxLength={60}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => setSavingTemplate(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={!templateName.trim()}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
    </Dialog>
  );
}
