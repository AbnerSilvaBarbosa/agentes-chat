import { useChannels, useIssues } from "@agenteschat/client";
import { pickOptions } from "@agenteschat/client/lib/card-refs";
import { type ComposerSuggestion, Icon } from "@agenteschat/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/**
 * "#" suggestions (`pickOptions`): the channels I can see, each with its topic (the ones I'm not in say so), then the
 * cards (ADR 0183) from the issues list already loaded, which the server filters to the ones I may see.
 */
export function useChannelSearch() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id).data;
  const cards = useIssues(org.id).data;
  return useCallback(
    (query: string): ComposerSuggestion[] => {
      const picked = pickOptions(query, channels ?? [], cards ?? []);
      return [
        ...picked.channels.map((c) => ({
          key: `channel:${c.id}`,
          insert: c.name,
          label: `#${c.name}`,
          description: c.topic || undefined,
          leading: <Icon name={c.visibility === "private" ? "lock" : "channel"} size={16} />,
          note: c.isMember ? undefined : t("channelRefs.notMember"),
        })),
        ...picked.cards.map((c) => ({
          key: `card:${c.number}`,
          insert: String(c.number),
          label: `#${c.number}`,
          description: c.title,
          leading: <Icon name="issues" size={16} />,
          note: t(`issues.status.${c.status}`),
        })),
      ];
    },
    [channels, cards, t],
  );
}
