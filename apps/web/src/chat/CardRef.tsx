import { useIssue } from "@agenteschat/client";
import { STATUS_ICON } from "@agenteschat/client/lib/issues";
import { Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useInPlace } from "@/components/InPlace";
import { useOrg } from "@/components/org-context";
import type { CardRenderer } from "@/lib/markdown";
import { inPlaceClick } from "@/lib/navigate";

/**
 * `#128` in a message (ADR 0183): the card of that number in this workspace as a chip, "#128 title · status", opening
 * it. The server answers 404 for a card the reader may not see (and for one that is gone), so the number then stays the
 * text as written; the card's query is the one its page keeps, so a change of title or status shows at once. A long
 * title wraps inside the chip, as the task pill's does.
 */
export function CardRef({ number, text }: { number: number; text: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const inPlace = useInPlace();
  const query = useIssue(org.id, number);
  const issue = query.data;
  if (!issue || query.isError) return <>{text}</>;
  const status = t(`issues.status.${issue.status}`);
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(number) }}
      className="channel-ref id-ref"
      aria-label={t("cardRefs.label", { number, title: issue.title, status })}
      onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(number)) : undefined}
    >
      <Icon name={STATUS_ICON[issue.status]} />#{number} {issue.title}
      <span className="muted"> · {status}</span>
    </Link>
  );
}

/** The renderer to pass to `<Markdown card>` where people name cards: chat. */
export const renderCardRef: CardRenderer = (number, text, key) => <CardRef key={key} number={number} text={text} />;
