import { useAgents, useSettings, useUpdateSettings } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { Alert, Card, Field, Select } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

/**
 * Configurações › Tarefas, the workspace's PO (ADR 0185): the agent the PO chats are with and who proposes the cards
 * in them. Who configures the workspace picks or clears it, saved at once; everyone else reads it. The options are the
 * agents that are neither archived nor the right hand, which the server refuses too; the one set now stays listed even
 * when it no longer qualifies, so the select never shows empty.
 */
export function PoSetting() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const agents = useAgents(org.id);
  const editable = can(org, "configure");
  if (!settings.data) {
    return settings.isError ? (
      <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
    ) : (
      <LoadingList count={1} avatar={false} />
    );
  }
  const all = agents.data ?? [];
  // What is being saved shows at once.
  const chosen = (update.isPending ? update.variables?.poAgentId : settings.data.poAgentId) ?? "";
  const eligible = all.filter((a) => !a.former && !isRightHand(a));
  const current = all.find((a) => a.id === chosen);
  const listed = current && !eligible.some((a) => a.id === current.id) ? [current, ...eligible] : eligible;
  const face = (id: string, name: string) => <AgentAvatar agentId={id} name={name} size="xs" />;
  return (
    <Card>
      <Field
        label={t("settings.tasks.po")}
        id="po-agent"
        hint={{ name: t("common.about", { label: t("settings.tasks.po") }), text: t("settings.tasks.poHint") }}
      >
        {editable ? (
          <Select
            id="po-agent"
            value={chosen}
            onValueChange={(next) => update.mutate({ poAgentId: next || null })}
            options={[
              { value: "", label: t("settings.tasks.poNone") },
              ...listed.map((a) => ({ value: a.id, label: a.name, leading: face(a.id, a.name) })),
            ]}
            disabled={update.isPending}
          />
        ) : (
          <p>{current?.name ?? t("settings.tasks.poNone")}</p>
        )}
      </Field>
      {update.isError && <Alert>{errorText(t, update.error, i18n.language)}</Alert>}
    </Card>
  );
}
