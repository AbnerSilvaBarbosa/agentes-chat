import type { IssueProject, IssueProjectRef, IssueProjects, IssueSpaceRef } from "@agenteschat/client";
import { useIssueProjectAction, useIssueProjects, useIssueSpaceAction } from "@agenteschat/client";
import {
  boardFilterRows,
  NO_PROJECT,
  PROJECT_COLORS,
  PROJECT_NAME_MAX,
  pickableProjects,
  SPACE_NAME_MAX,
} from "@agenteschat/client/lib/issue-projects";
import {
  Button,
  ColorDot,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  Field,
  FilterChip,
  type FilterOption,
  Input,
  Locked,
  Select,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFilterCopy } from "@/components/filters";
import { useOrg } from "@/components/org-context";
import "@/components/roles/roles.css";

/** The first color no project wears yet, so a new one stands apart without a choice. */
const freeColor = (worn: { color: string }[]) =>
  PROJECT_COLORS.find((c) => !worn.some((p) => p.color === c)) ?? PROJECT_COLORS[0] ?? "graphite";

/** No space: a board that belongs to no company (the empty option of a space picker). */
export const NO_SPACE = "";

/** "Nova empresa" and "Editar empresa": a name and one of the roles' colors, as a board has. Mounted while open. */
export function SpaceDialog({
  space,
  onClose,
  onDone,
}: {
  /** The space to edit. None: a new one. */
  space?: IssueSpaceRef;
  onClose: () => void;
  onDone?: (space: IssueSpaceRef) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueSpaceAction(org.id);
  const spaces = useIssueProjects(org.id).data?.spaces ?? [];
  const [name, setName] = useState(space?.name ?? "");
  const [picked, setPicked] = useState<string | null>(space?.color ?? null);
  const color = picked ?? freeColor(spaces);
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    if (space && value === space.name && color === space.color) return onClose();
    action.mutate(
      space ? { type: "update", spaceId: space.id, name: value, color } : { type: "create", name: value, color },
      {
        onSuccess: (saved) => {
          if (saved) onDone?.(saved);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(space ? "issues.spaces.edit" : "issues.spaces.new")}
      description={space ? undefined : t("issues.spaces.newHint")}
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
            <Field label={t("rolesPage.name")} id="issue-space-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={SPACE_NAME_MAX}
                autoComplete="off"
                autoFocus
                placeholder={t("issues.spaces.namePlaceholder")}
              />
            </Field>
            <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
              {PROJECT_COLORS.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t("rolesPage.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c, 8)}")` }}
                  onClick={() => setPicked(c)}
                />
              ))}
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={action.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {space ? t("common.save") : t("issues.spaces.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir a empresa X?": its boards stay, with no company. Mounted while open. */
export function DeleteSpaceDialog({
  space,
  onClose,
  onDeleted,
}: {
  space: IssueSpaceRef;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueSpaceAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title={t("issues.spaces.deleteTitle", { name: space.name })}
      description={t("issues.spaces.deleteBody")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={action.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "delete", spaceId: space.id },
              {
                onSuccess: () => {
                  onDeleted();
                  onClose();
                },
              },
            )
          }
        >
          {t("issues.spaces.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Novo board" and "Editar board": a name, one of the roles' colors, and the company it belongs to. Mounted while open.
 * `onDone` gets the board as saved, so whoever opened it from a task's field can put the task in it.
 */
export function ProjectDialog({
  project,
  onClose,
  onDone,
}: {
  /** The project to edit. None: a new one. */
  project?: IssueProjectRef;
  onClose: () => void;
  onDone?: (project: IssueProjectRef) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  const data = useIssueProjects(org.id).data;
  const projects = data?.projects ?? [];
  const spaces = data?.spaces ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [picked, setPicked] = useState<string | null>(project?.color ?? null);
  const [spaceId, setSpaceId] = useState<string>(project?.spaceId ?? NO_SPACE);
  const color = picked ?? freeColor(projects);
  const pickableSpaces = spaces.filter((s) => !s.archived || s.id === project?.spaceId);
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    const space = spaceId || null;
    if (project && value === project.name && color === project.color && space === project.spaceId) return onClose();
    action.mutate(
      project
        ? { type: "update", projectId: project.id, name: value, color, spaceId: space }
        : { type: "create", name: value, color, spaceId: space },
      {
        onSuccess: (saved) => {
          if (saved) onDone?.(saved);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(project ? "issues.projects.edit" : "issues.projects.new")}
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
            <Field label={t("rolesPage.name")} id="issue-project-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={PROJECT_NAME_MAX}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
              {PROJECT_COLORS.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t("rolesPage.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c, 8)}")` }}
                  onClick={() => setPicked(c)}
                />
              ))}
            </div>
            <Field label={t("issues.spaces.label")} id="issue-project-space">
              <Select
                id="issue-project-space"
                aria-label={t("issues.spaces.label")}
                value={spaceId}
                onValueChange={setSpaceId}
                options={[
                  { value: NO_SPACE, label: t("issues.spaces.none"), leading: <ColorDot /> },
                  ...pickableSpaces.map((s) => ({
                    value: s.id,
                    label: s.name,
                    leading: <ColorDot color={s.color} />,
                  })),
                ]}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={action.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {project ? t("common.save") : t("issues.projects.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir o projeto X?": its tasks stay, with no project. Mounted while open. */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: IssueProjectRef;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title={t("issues.projects.deleteTitle", { name: project.name })}
      description={t("issues.projects.deleteBody")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={action.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "delete", projectId: project.id },
              {
                onSuccess: () => {
                  onDeleted();
                  onClose();
                },
              },
            )
          }
        >
          {t("issues.projects.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The toolbar's "Board" chip, which is the whole boards list: each company as a heading over its boards, each board
 * with its color and its open tasks, "Sem board", the archived ones under their own heading, and "Novo board" (with
 * "Nova empresa" beside it) for who may create one. Picking one opens its board. With one picked the chip wears its dot
 * and name, and × goes back to every task.
 */
export function ProjectChip({
  data,
  value,
  onChange,
  onNew,
}: {
  data: IssueProjects | undefined;
  /** A project's id, `none`, or nothing. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Who may create tasks: "Novo board" at the menu's end. */
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const copy = useFilterCopy();
  const projects = data?.projects ?? [];
  const row = (p: IssueProject, group: string | null): FilterOption => ({
    value: p.id,
    label: p.name,
    leading: <ColorDot color={p.color} />,
    count: p.open,
    ...(group ? { group } : {}),
  });
  // Before the first board there is nothing to filter by: the menu is "Novo board" alone, and who can't make one has
  // no chip.
  if (projects.length === 0 && !onNew) return null;
  const options: FilterOption[] =
    projects.length === 0
      ? []
      : [
          ...boardFilterRows(projects, data?.spaces).flatMap((g) => g.rows.map((p) => row(p, g.group))),
          {
            value: NO_PROJECT,
            label: t("issues.projects.none"),
            leading: <ColorDot />,
            count: data?.unfiled ?? 0,
          },
        ];
  return (
    <FilterChip
      label={t("issues.projects.label")}
      icon="layers"
      options={options}
      value={value ? [value] : []}
      onChange={(next) => onChange(next[0])}
      valueText={(o) => o.label}
      valueLeading
      clearLabel={copy.clearOf(t("issues.projects.label"))}
      searchLabel={t("issues.projects.label")}
      action={onNew && { label: t("issues.projects.new"), icon: "plus", onSelect: onNew }}
    />
  );
}

/**
 * The toolbar's "Empresa" chip: the companies, each with the open tasks in its boards, and "Nova empresa" for who may
 * create one. Picking one shows every task of that company's boards.
 */
export function SpaceChip({
  data,
  value,
  onChange,
  onNew,
}: {
  data: IssueProjects | undefined;
  /** A space's id, or nothing. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Who may create tasks: "Nova empresa" at the menu's end. */
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const copy = useFilterCopy();
  const spaces = data?.spaces ?? [];
  if (spaces.length === 0 && !onNew) return null;
  const options: FilterOption[] = spaces.map((s) =>
    s.archived
      ? {
          value: s.id,
          label: s.name,
          leading: <ColorDot color={s.color} />,
          group: t("issues.projects.archived"),
        }
      : { value: s.id, label: s.name, leading: <ColorDot color={s.color} />, count: s.open },
  );
  return (
    <FilterChip
      label={t("issues.spaces.label")}
      icon="grid"
      options={options}
      value={value ? [value] : []}
      onChange={(next) => onChange(next[0])}
      valueText={(o) => o.label}
      valueLeading
      clearLabel={copy.clearOf(t("issues.spaces.label"))}
      searchLabel={t("issues.spaces.label")}
      action={onNew && { label: t("issues.spaces.new"), icon: "plus", onSelect: onNew }}
    />
  );
}

/** In a task's project select: opens "Novo projeto" instead of choosing. */
export const NEW_PROJECT = "new";

/** What a task's "Projeto" select offers: the projects in use (and the task's own, even archived), none, a new one. */
export function useProjectOptions(current: IssueProjectRef | null | undefined, mayCreate: boolean) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const projects = useIssueProjects(org.id).data?.projects ?? (current ? [{ ...current, open: 0 }] : []);
  return [
    ...pickableProjects(projects, current).map((p) => ({
      value: p.id,
      label: p.name,
      leading: <ColorDot color={p.color} />,
    })),
    { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot /> },
    ...(mayCreate ? [{ value: NEW_PROJECT, label: t("issues.projects.new"), action: true }] : []),
  ];
}
