import type { IssueProject, IssueProjectRef, IssueProjects, IssueSpaceRef } from "@agenteschat/client";
import {
  useIssueColumnTemplateAction,
  useIssueColumnTemplates,
  useIssueProjectAction,
  useIssueProjects,
  useIssueSpaceAction,
} from "@agenteschat/client";
import {
  boardFilterRows,
  boardLabels,
  NO_PROJECT,
  PROJECT_COLORS,
  PROJECT_NAME_MAX,
  pickableProjects,
  SPACE_NAME_MAX,
  spaceImageRefusal,
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
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  Select,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFilterCopy } from "@/components/filters";
import { useOrg } from "@/components/org-context";
import { ImageCropDialog } from "@/components/ProfilePhoto";
import "@/components/roles/roles.css";

/** The first color no project wears yet, so a new one stands apart without a choice. */
const freeColor = (worn: { color: string }[]) =>
  PROJECT_COLORS.find((c) => !worn.some((p) => p.color === c)) ?? PROJECT_COLORS[0] ?? "graphite";

/** No space: a board that belongs to no company (the empty option of a space picker). */
export const NO_SPACE = "";

/** No template: a board that keeps the workspace's own columns. */
export const NO_TEMPLATE = "";

/**
 * A company's mark, drawn in one place for its card, the chip and the picker (ADR 0180): its image when it has one,
 * else its color as the dot a board wears. The box is the dot's, so it sits where the dot sat in every row.
 */
export function SpaceMark({ space }: { space: Pick<IssueSpaceRef, "color" | "image"> }) {
  if (!space.image) return <ColorDot color={space.color} />;
  return (
    <span className="ac-colordot space-mark" aria-hidden="true">
      <img src={space.image} alt="" draggable={false} />
    </span>
  );
}

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
  // The image is cropped square here (512×512) and sent once the company exists: a new one, one chosen, or "removed".
  const [image, setImage] = useState<{ url: string; imageBase64: string; contentType: string } | "removed" | null>(
    null,
  );
  const [choosing, setChoosing] = useState(false);
  const shownImage = image === "removed" ? null : image ? image.url : (space?.image ?? null);
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    const unchanged = space && value === space.name && color === space.color;
    if (unchanged && image === null) return onClose();
    const finish = (saved: IssueSpaceRef) => {
      onDone?.(saved);
      onClose();
    };
    // The company is saved either way: an image the server refuses is said, never a second company.
    const withImage = (saved: IssueSpaceRef) => {
      if (image === null) return finish(saved);
      action.mutate(
        image === "removed"
          ? { type: "clear-image", spaceId: saved.id }
          : { type: "image", spaceId: saved.id, imageBase64: image.imageBase64, contentType: image.contentType },
        { onSuccess: (done) => finish(done ?? saved), onError: () => finish(saved) },
      );
    };
    if (unchanged) return withImage(space);
    action.mutate(
      space ? { type: "update", spaceId: space.id, name: value, color } : { type: "create", name: value, color },
      { onSuccess: (saved) => (saved ? withImage(saved) : onClose()) },
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
            <Field label={t("issues.spaces.image")} id="issue-space-image">
              <div className="space-image">
                <SpaceMark space={{ color, image: shownImage }} />
                <Button type="button" size="sm" icon="image" onClick={() => setChoosing(true)}>
                  {t(shownImage ? "issues.spaces.imageChange" : "issues.spaces.imageChoose")}
                </Button>
                {shownImage && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="trash"
                    aria-label={t("issues.spaces.imageRemove")}
                    onClick={() => setImage("removed")}
                  />
                )}
              </div>
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
            {space ? t("common.save") : t("issues.spaces.create")}
          </Button>
        </DialogFooter>
      </form>
      <ImageCropDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t("issues.spaces.imageTitle")}
        help={t("issues.spaces.imageHelp")}
        placeholder={<SpaceMark space={{ color, image: shownImage }} />}
        hasImage={false}
        removeLabel={t("issues.spaces.imageRemove")}
        format="image/png"
        showRefusal
        save={async (sent) => {
          const refusal = spaceImageRefusal(sent);
          if (refusal) throw refusal;
          setImage({ ...sent, url: `data:${sent.contentType};base64,${sent.imageBase64}` });
        }}
        remove={async () => undefined}
        onSaved={() => undefined}
        onRemoved={() => undefined}
      />
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
  lockedSpace,
  onClose,
  onDone,
}: {
  /** The project to edit. None: a new one. */
  project?: IssueProjectRef;
  /** A new board opened from a company's page is made in that company: the dialog asks nothing about it. */
  lockedSpace?: string;
  onClose: () => void;
  onDone?: (project: IssueProjectRef) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  const data = useIssueProjects(org.id).data;
  const templateAction = useIssueColumnTemplateAction(org.id);
  const templates = useIssueColumnTemplates(org.id).data ?? [];
  const projects = data?.projects ?? [];
  const spaces = data?.spaces ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [picked, setPicked] = useState<string | null>(project?.color ?? null);
  const [spaceId, setSpaceId] = useState<string>(project?.spaceId ?? lockedSpace ?? NO_SPACE);
  // A new board starts from a set of columns (ADR 0177); editing one keeps the columns it has.
  const [template, setTemplate] = useState<string>(NO_TEMPLATE);
  const color = picked ?? freeColor(projects);
  // An archived company takes no new board; the one a board is already in stays in its own picker.
  const pickableSpaces = spaces.filter((s) => !s.archived || s.id === project?.spaceId);
  // The workspace's own columns first, then the status sets by name.
  const sets = [...templates].sort((a, b) => a.name.localeCompare(b.name));
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
          // The board exists either way: a template that fails is said, never a second board.
          if (!project && saved && template !== NO_TEMPLATE)
            templateAction.mutate({ type: "apply", projectId: saved.id, templateId: template });
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
            {!project && (
              <Field label={t("issues.columns.template")} id="issue-project-template">
                <Select
                  id="issue-project-template"
                  aria-label={t("issues.columns.template")}
                  value={template}
                  onValueChange={setTemplate}
                  options={[
                    { value: NO_TEMPLATE, label: t("issues.columns.templateWorkspace") },
                    ...sets.map((tpl) => ({ value: tpl.id, label: tpl.name })),
                  ]}
                />
              </Field>
            )}
            {!(lockedSpace && !project) && (
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
                      leading: <SpaceMark space={s} />,
                    })),
                  ]}
                />
              </Field>
            )}
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
          leading: <SpaceMark space={s} />,
          group: t("issues.projects.archived"),
        }
      : { value: s.id, label: s.name, leading: <SpaceMark space={s} />, count: s.open },
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
  const data = useIssueProjects(org.id).data;
  const projects = data?.projects ?? (current ? [{ ...current, open: 0 }] : []);
  // Two boards may share a name in different companies: the picker says which company each one is in (ADR 0178).
  const label = boardLabels(projects, data?.spaces);
  return [
    ...pickableProjects(projects, current).map((p) => ({
      value: p.id,
      label: label(p),
      leading: <ColorDot color={p.color} />,
    })),
    { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot /> },
    ...(mayCreate ? [{ value: NEW_PROJECT, label: t("issues.projects.new"), action: true }] : []),
  ];
}

/**
 * A company's own page (ADR 0177): its boards, each with the tasks open in it, and "Novo board" beside them. Picking a
 * board opens its kanban; the company itself holds no task, so this is where a person chooses what to look at.
 */
export function SpaceBoards({
  space,
  data,
  mayCreate,
  onOpen,
  onNew,
  onEdit,
  onDelete,
  onArchive,
}: {
  space: IssueSpaceRef | null;
  data: IssueProjects | undefined;
  mayCreate: boolean;
  onOpen: (projectId: string) => void;
  onNew?: () => void;
  /** Who may create tasks edits, archives and deletes a board from its own card (ADR 0179). */
  onEdit?: (board: IssueProjectRef) => void;
  onDelete?: (board: IssueProjectRef) => void;
  onArchive?: (board: IssueProjectRef) => void;
}) {
  const { t } = useTranslation();
  const boards = (data?.projects ?? []).filter((p) => p.spaceId === space?.id && !p.archived);
  return (
    <div className="space-boards">
      {boards.length === 0 ? (
        <div className="space-boards__empty">
          <p>{t("issues.spaces.noBoards")}</p>
          {mayCreate && onNew && (
            <Button variant="primary" icon="plus" onClick={onNew}>
              {t("issues.projects.new")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-boards__grid">
          {boards.map((b) => (
            <div key={b.id} className="space-board-wrap">
              <button type="button" className="space-board" onClick={() => onOpen(b.id)}>
                <span className="space-board__name">
                  <ColorDot color={b.color} />
                  {b.name}
                </span>
                <span className="space-board__count">{t("issues.spaces.boardCount", { count: b.open })}</span>
              </button>
              {onEdit && (
                <Menu
                  label={t("issues.projects.boardOptions", { name: b.name })}
                  trigger={
                    <Button
                      size="sm"
                      iconOnly
                      icon="more"
                      aria-label={t("issues.projects.boardOptions", { name: b.name })}
                    />
                  }
                >
                  <MenuItem icon="edit" onSelect={() => onEdit(b)}>
                    {t("issues.projects.edit")}
                  </MenuItem>
                  <MenuItem icon="archive" onSelect={() => onArchive?.(b)}>
                    {t("issues.projects.archive")}
                  </MenuItem>
                  <MenuItem icon="trash" danger onSelect={() => onDelete?.(b)}>
                    {t("issues.projects.delete")}
                  </MenuItem>
                </Menu>
              )}
            </div>
          ))}
          {mayCreate && onNew && (
            <button type="button" className="space-board space-board--new" onClick={onNew}>
              <Icon name="plus" />
              {t("issues.projects.new")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tarefas opens here (ADR 0179): the companies, each with the open tasks in its boards and how many boards it has, the
 * boards in no company after them, and "todas as tarefas" for the workspace's whole board. Picking a company opens its
 * boards; picking a board opens its kanban.
 */
export function SpaceList({
  data,
  mayCreate,
  onOpen,
  onAll,
  onNew,
}: {
  data: IssueProjects | undefined;
  mayCreate: boolean;
  onOpen: (spaceId: string) => void;
  onAll: () => void;
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const spaces = (data?.spaces ?? []).filter((sp) => !sp.archived);
  const boards = data?.projects ?? [];
  const loose = boards.filter((b) => !b.spaceId && !b.archived);
  return (
    <div className="space-boards">
      <div className="space-boards__grid">
        {spaces.map((sp) => (
          <button key={sp.id} type="button" className="space-board" onClick={() => onOpen(sp.id)}>
            <span className="space-board__name">
              <SpaceMark space={sp} />
              {sp.name}
            </span>
            <span className="space-board__count">{t("issues.spaces.boardCount", { count: sp.open })}</span>
            <span className="space-board__boards">
              {t("issues.spaces.boardsInside", {
                count: boards.filter((b) => b.spaceId === sp.id && !b.archived).length,
              })}
            </span>
          </button>
        ))}
        {mayCreate && onNew && (
          <button type="button" className="space-board space-board--new" onClick={onNew}>
            <Icon name="plus" />
            {t("issues.spaces.new")}
          </button>
        )}
        {loose.length > 0 && (
          <button type="button" className="space-board" onClick={onAll}>
            <span className="space-board__name">
              <ColorDot />
              {t("issues.spaces.none")}
            </span>
            <span className="space-board__count">
              {t("issues.spaces.boardCount", { count: loose.reduce((n, b) => n + b.open, 0) })}
            </span>
          </button>
        )}
        <button type="button" className="space-board" onClick={onAll}>
          <span className="space-board__name">
            <Icon name="layers" />
            {t("issues.allTasks")}
          </span>
        </button>
      </div>
    </div>
  );
}
