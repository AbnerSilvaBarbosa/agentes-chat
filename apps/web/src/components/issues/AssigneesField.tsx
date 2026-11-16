import type { Actor, IssuePatch } from "@agenteschat/client";
import { assignmentWith, peopleOn } from "@agenteschat/client/lib/issue-assignees";
import {
  AvatarStack,
  Button,
  Menu,
  MenuCheckboxItem,
  MenuHeading,
  MenuItem,
  MenuNote,
  MenuSeparator,
} from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { actorFromKey, useActors } from "@/components/actors";

/** What the picker asks for: the whole list in order, or one person made the principal (ADR 0186). */
export type AssigneesChange = Pick<IssuePatch, "assignees" | "principal">;

type OnCard = { assignee: Actor | null; alsoWith?: Actor[] };

const same = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id;
/** Faces on the trigger: the principal and two more. */
const FACES = 3;

/**
 * Who is responsible on a card (ADR 0186): the principal and the people also with it, in one menu. The trigger shows up
 * to three faces, the principal's name and how many are also with it. The menu names the principal, lists the people
 * also with it (a row makes one the principal) and checks every person and agent of the workspace: a tick adds, taking
 * it off removes. The agent, when the card has one, is its principal, so no person is made the principal then, and
 * choosing another agent takes the card from the first. Each change is the whole list in order (`assignees`) or
 * `principal`; what the server computed comes back and is shown, and the picker never builds what the server refuses.
 */
export function AssigneesField({
  value,
  onChange,
  agents = true,
  block,
}: {
  value: OnCard;
  onChange: (change: AssigneesChange) => void;
  /** Whether agents are offered (default yes, the new-card dialog too: the card is made with its agent). Off for a field that only names people. */
  agents?: boolean;
  /** The trigger fills its row (a form's field). */
  block?: boolean;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const on = peopleOn(value);
  const [principal, ...rest] = on;
  const hasAgent = principal?.type === "agent";
  const named = (list: Actor[]) => list.map((a) => actors.name(a)).join(", ");
  const label = !principal
    ? t("issues.assignees.label")
    : rest.length === 0
      ? t("issues.assignees.described", { principal: actors.name(principal) })
      : t("issues.assignees.describedWith", { principal: actors.name(principal), people: named(rest) });

  const options = actors
    .options(false, hasAgent ? `agent:${principal.id}` : undefined)
    .map((o) => ({ option: o, actor: actorFromKey(o.value) }))
    .filter(
      (o): o is { option: typeof o.option; actor: Actor } => o.actor !== null && (agents || o.actor.type !== "agent"),
    );
  /** The list a tick would leave: an agent goes first (it is the principal), a person goes last. */
  const withTick = (a: Actor): Actor[] => {
    if (on.some((x) => same(x, a))) return on.filter((x) => !same(x, a));
    return a.type === "agent" ? [a, ...on.filter((x) => x.type === "person")] : [...on, a];
  };
  const refused = (a: Actor) =>
    !on.some((x) => same(x, a)) && assignmentWith(value, { assignees: withTick(a) }) === null;
  const full = options.some(({ actor }) => actor.type === "person" && refused(actor));

  return (
    <Menu
      label={t("issues.assignees.label")}
      className="ac-menu--wrap"
      trigger={
        <Button
          size="sm"
          block={block}
          icon={principal ? undefined : "person"}
          aria-label={label}
          className="issue-assignees"
        >
          {principal ? (
            <>
              <AvatarStack>{on.slice(0, FACES).map((a) => actors.avatar(a))}</AvatarStack>
              <span className="issue-assignees__name">{actors.name(principal)}</span>
              {rest.length > 0 && (
                <span className="muted tabular" aria-hidden="true">
                  {t("issues.assignees.more", { count: rest.length })}
                </span>
              )}
            </>
          ) : (
            t("issues.assignees.label")
          )}
        </Button>
      }
    >
      {principal && (
        <>
          <MenuHeading>{t("issues.assignees.label")}</MenuHeading>
          <MenuItem leading={actors.avatar(principal, "sm")} hint={t("issues.assignees.principal")}>
            {actors.name(principal)}
          </MenuItem>
        </>
      )}
      {rest.length > 0 && (
        <>
          <MenuHeading>{t("issues.assignees.alsoWith")}</MenuHeading>
          {rest.map((a) => (
            <MenuItem
              key={`${a.type}:${a.id}`}
              leading={actors.avatar(a, "sm")}
              hint={hasAgent ? undefined : t("issues.assignees.makePrincipal")}
              onSelect={hasAgent ? undefined : () => onChange({ principal: a })}
            >
              {actors.name(a)}
            </MenuItem>
          ))}
        </>
      )}
      {principal && <MenuSeparator />}
      <MenuHeading>{t("issues.assignees.add")}</MenuHeading>
      {options.map(({ option, actor }) => {
        const checked = on.some((x) => same(x, actor));
        return (
          <MenuCheckboxItem
            key={option.value}
            checked={checked}
            disabled={refused(actor)}
            leading={option.leading}
            description={
              actor.type === "agent" && hasAgent && !checked ? t("issues.assignees.swapsAgent") : option.description
            }
            onCheckedChange={() => onChange({ assignees: withTick(actor) })}
          >
            {option.label}
          </MenuCheckboxItem>
        );
      })}
      {full && <MenuNote>{t("issues.assignees.max")}</MenuNote>}
    </Menu>
  );
}
