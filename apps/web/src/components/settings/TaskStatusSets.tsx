import type { IssueColumnTemplate, IssueStatus } from "@agenteschat/client";
import { useIssueColumnTemplateAction, useIssueColumnTemplates } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { CONFIGURABLE_STAGES, ColumnEditor, type EditorColumn } from "@/pages/BoardColumns";

/** A status set's name holds at most this (mirror of `TEMPLATE_NAME_MAX`, packages/engine/src/issue-columns.ts). */
const SET_NAME_MAX = 40;

type SetColumn = IssueColumnTemplate["columns"][number];

/** A set's columns grouped by stage, in board order: what the editor shows and what is saved after a gesture. */
const byStage = (columns: SetColumn[]): SetColumn[] => {
  const known = CONFIGURABLE_STAGES.flatMap((stage) => columns.filter((c) => c.stage === stage));
  return [...known, ...columns.filter((c) => !CONFIGURABLE_STAGES.includes(c.stage))];
};

/**
 * Configurações › Tarefas (ADR 0221): the status sets a board can start from, each with its columns by stage. Whoever
 * may create tasks makes, renames and deletes sets and edits their columns, each gesture saved at once; everyone else
 * reads them. A board made from a set keeps its own copy, so nothing here changes a board that already exists.
 */
export function TaskStatusSets() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const posts = can(org, "post");
  const sets = useIssueColumnTemplates(org.id);
  const action = useIssueColumnTemplateAction(org.id);
  const [dialog, setDialog] = useState<
    { kind: "new" } | { kind: "rename"; set: IssueColumnTemplate } | { kind: "delete"; set: IssueColumnTemplate } | null
  >(null);
  if (!sets.data) {
    return sets.isError ? (
      <ErrorState error={sets.error} onRetry={() => void sets.refetch()} />
    ) : (
      <LoadingList count={2} avatar={false} />
    );
  }
  return (
    <>
      {!posts && <p className="page__note">{t("settings.tasks.readOnly")}</p>}
      {posts && (
        <div>
          <Button icon="plus" onClick={() => setDialog({ kind: "new" })}>
            {t("settings.tasks.newSet")}
          </Button>
        </div>
      )}
      {action.isError && !dialog && <Alert>{errorText(t, action.error, i18n.language)}</Alert>}
      <div className="ac-groups">
        {sets.data.map((set) => (
          <SetCard
            key={set.id}
            set={set}
            posts={posts}
            busy={action.isPending}
            onSave={(columns) => action.mutate({ type: "update", templateId: set.id, columns })}
            onRename={() => setDialog({ kind: "rename", set })}
            onDelete={() => setDialog({ kind: "delete", set })}
          />
        ))}
      </div>
      {dialog && dialog.kind !== "delete" && (
        <SetNameDialog set={dialog.kind === "rename" ? dialog.set : undefined} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && <DeleteSetDialog set={dialog.set} onClose={() => setDialog(null)} />}
    </>
  );
}

function SetCard({
  set,
  posts,
  busy,
  onSave,
  onRename,
  onDelete,
}: {
  set: IssueColumnTemplate;
  posts: boolean;
  busy: boolean;
  onSave: (columns: SetColumn[]) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const columns = byStage(set.columns);
  // The editor names a column by its place in the set, and by what it holds so a half-typed name never follows
  // another column that took its place: the list is rebuilt from the saved set after each gesture.
  const shown: EditorColumn[] = columns.map((c, i) => ({
    id: `${i}:${c.stage}:${c.name}`,
    name: c.name,
    stage: c.stage,
    waits: c.waitsForPerson === true,
  }));
  const at = (id: string) => Number.parseInt(id, 10);
  const edit = (change: (list: SetColumn[]) => SetColumn[]) => onSave(byStage(change([...columns])));
  const titleId = `task-set-${set.id}`;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader
        id={titleId}
        icon="layers"
        title={set.name}
        action={
          posts ? (
            <span className="ac-acts">
              <Button size="sm" iconOnly icon="edit" aria-label={t("settings.tasks.rename")} onClick={onRename} />
              {!set.seeded && (
                <Button size="sm" iconOnly icon="trash" aria-label={t("settings.tasks.delete")} onClick={onDelete} />
              )}
            </span>
          ) : undefined
        }
      />
      {columns.length === 0 && <p className="page__note">{t("settings.tasks.noColumns")}</p>}
      <ColumnEditor
        columns={shown}
        busy={busy}
        readOnly={!posts}
        canDelete={() => columns.length > 1}
        onRename={(id, name) => edit((list) => list.map((c, i) => (i === at(id) ? { ...c, name } : c)))}
        onStage={(id, stage) =>
          edit((list) => {
            const [moved] = list.splice(at(id), 1);
            return moved ? [...list, { ...moved, stage }] : list;
          })
        }
        onMove={(id, index) =>
          edit((list) => {
            const moved = list[at(id)];
            if (!moved) return list;
            const rest = list.filter((_, i) => i !== at(id));
            const inStage = rest.filter((c) => c.stage === moved.stage);
            inStage.splice(index, 0, moved);
            return [...rest.filter((c) => c.stage !== moved.stage), ...inStage];
          })
        }
        onAdd={(stage: IssueStatus, name) => onSave(byStage([...columns, { name, stage }]))}
        onDelete={(id) => edit((list) => list.filter((_, i) => i !== at(id)))}
        onWaits={(id, on) =>
          edit((list) =>
            list.map((c, i) => {
              if (i !== at(id)) return c;
              // A set keeps the flag only as `true`: switching it off takes the key away.
              const { waitsForPerson: _was, ...rest } = c;
              return on ? { ...rest, waitsForPerson: true } : rest;
            }),
          )
        }
      />
    </Card>
  );
}

/** "Novo conjunto" and the rename of one: a name, 1 to 40 characters. A new set starts with a column per stage. */
function SetNameDialog({ set, onClose }: { set?: IssueColumnTemplate; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const action = useIssueColumnTemplateAction(org.id);
  const [name, setName] = useState(set?.name ?? "");
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    if (set && value === set.name) return onClose();
    action.mutate(
      set
        ? { type: "update", templateId: set.id, name: value }
        : {
            type: "create",
            name: value,
            columns: CONFIGURABLE_STAGES.map((stage) => ({ name: t(`issues.status.${stage}`), stage })),
          },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={set ? t("settings.tasks.renameTitle", { name: set.name }) : t("settings.tasks.newTitle")}
      description={set ? undefined : t("settings.tasks.newHint")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("settings.tasks.name")} id="task-set-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={SET_NAME_MAX}
                autoComplete="off"
                autoFocus
                placeholder={t("settings.tasks.namePlaceholder")}
              />
            </Field>
            {action.isError && <Alert>{errorText(t, action.error, i18n.language)}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={action.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={action.isPending}
            disabled={!name.trim() || action.isPending}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Deleting a set leaves the columns of every board that was made from it. */
function DeleteSetDialog({ set, onClose }: { set: IssueColumnTemplate; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const action = useIssueColumnTemplateAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title={t("settings.tasks.deleteTitle", { name: set.name })}
      description={t("settings.tasks.deleteBody")}
      closeLabel={t("common.close")}
      width={440}
    >
      {action.isError && (
        <DialogBody>
          <Alert>{errorText(t, action.error, i18n.language)}</Alert>
        </DialogBody>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={action.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() => action.mutate({ type: "delete", templateId: set.id }, { onSuccess: onClose })}
        >
          {t("settings.tasks.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
