import type { IssueColumn, IssueColumnTemplate, IssueStatus } from "@agenteschat/client";
import { useIssueColumnAction, useIssueColumnTemplateAction, useIssueColumnTemplates } from "@agenteschat/client";
import { Button, Dialog, DialogBody, DialogFooter, Input, Menu, MenuItem, Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** The stages a column can sit in, in board order; `canceled` is kept off the board and out of this screen. */
export const CONFIGURABLE_STAGES: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];

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
  const [adding, setAdding] = useState<IssueStatus | null>(null);
  const [newName, setNewName] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!open) return null;
  const byStage = (stage: IssueStatus) =>
    columns.filter((c) => c.stage === stage).sort((a, b) => a.position - b.position);
  const nameOf = (c: IssueColumn) => draft[c.id] ?? c.name ?? t(`issues.status.${c.stage}`);
  const save = (c: IssueColumn) => {
    const value = (draft[c.id] ?? "").trim();
    if (!value || value === (c.name ?? "")) return;
    action.mutate({ type: "update", columnId: c.id, name: value.slice(0, 40) });
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t("issues.columns.configTitle")}
      description={t("issues.columns.configBody")}
      closeLabel={t("common.close")}
      width={620}
    >
      <DialogBody>
        <div className="board-columns">
          {CONFIGURABLE_STAGES.map((stage) => {
            const inStage = byStage(stage);
            return (
              <section key={stage} className="board-columns__stage" aria-label={t(`issues.status.${stage}`)}>
                <h3>{t(`issues.status.${stage}`)}</h3>
                {inStage.map((c, index) => (
                  <div key={c.id} className="board-columns__row">
                    <Input
                      aria-label={t("issues.columns.nameLabel")}
                      value={nameOf(c)}
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
                      onValueChange={(next) =>
                        action.mutate({ type: "update", columnId: c.id, stage: next as IssueStatus })
                      }
                      options={CONFIGURABLE_STAGES.map((s) => ({ value: s, label: t(`issues.status.${s}`) }))}
                    />
                    <div className="board-columns__moves">
                      <Button
                        size="sm"
                        iconOnly
                        icon="arrowUp"
                        aria-label={t("issues.columns.moveLeft")}
                        disabled={index === 0 || action.isPending}
                        onClick={() => action.mutate({ type: "update", columnId: c.id, index: index - 1 })}
                      />
                      <Button
                        size="sm"
                        iconOnly
                        icon="arrowDown"
                        aria-label={t("issues.columns.moveRight")}
                        disabled={index === inStage.length - 1 || action.isPending}
                        onClick={() => action.mutate({ type: "update", columnId: c.id, index: index + 1 })}
                      />
                      <Button
                        size="sm"
                        iconOnly
                        icon="trash"
                        aria-label={t("issues.columns.delete")}
                        disabled={inStage.length === 1 || action.isPending}
                        onClick={() => {
                          const moveTo = inStage.find((o) => o.id !== c.id);
                          if (moveTo) action.mutate({ type: "delete", columnId: c.id, moveTo: moveTo.id });
                        }}
                      />
                    </div>
                  </div>
                ))}
                {adding === stage ? (
                  <form
                    className="board-columns__row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = newName.trim();
                      if (!value) return;
                      action.mutate(
                        { type: "add", name: value, stage, afterId: inStage.at(-1)?.id ?? null },
                        {
                          onSuccess: () => {
                            setNewName("");
                            setAdding(null);
                          },
                        },
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
        {!projectId && <p className="board-columns__note">{t("issues.columns.workspaceNote")}</p>}
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
