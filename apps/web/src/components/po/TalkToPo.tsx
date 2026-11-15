import { Button } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * "Conversar com o PO": opens the PO's chat about one company (ADR 0185), the PO's face before the words. A company's
 * page in Tarefas and its panel on Início both draw it, so the entry is one component.
 */
export function TalkToPo({ agentId, spaceId }: { agentId: string; spaceId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const name = useDirectory(org.id).agentById.get(agentId)?.name ?? "";
  return (
    <Button
      variant="ghost"
      onClick={() => void navigate({ to: "/org/$orgId/po/$spaceId", params: { orgId: org.id, spaceId } })}
    >
      <AgentAvatar agentId={agentId} name={name} size="xs" />
      {t("issues.spaces.talkToPo")}
    </Button>
  );
}
