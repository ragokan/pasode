// Agent profiles: named launch bundles (provider, model, mode, thinking, features) kept in the daemon's config. Read-only
// here; the logic follows the Paseo app's profile picker (materialize-profile, profile-summary).
import type { AgentProfile } from "@getpaseo/protocol/agent-profile"
import { dialog, DialogSelect } from "../dialog"
import { api, daemon, findModel, modelLabel, PROVIDERS, providerName, type PaseoAgent } from "../paseo"
import { current, draft, notify, rememberDraft, showError, type Draft } from "../state"

const trim = (value?: string) => value?.trim() || undefined

/** A profile's set fields; a blank one means "leave that setting alone". */
export function materialize(profile: AgentProfile) {
  const features = profile.featureValues
  return {
    provider: profile.provider.trim(),
    model: trim(profile.model),
    modeId: trim(profile.modeId),
    thinking: trim(profile.thinkingOptionId),
    featureValues: features && Object.keys(features).length ? features : undefined,
  }
}

/** "Claude Code · Opus 5.5 · bypassPermissions · xhigh · 2 features" */
export function profileSummary(profile: AgentProfile) {
  const { provider, model, modeId, thinking, featureValues } = materialize(profile)
  const effort = thinking && (findModel(provider, model)?.thinkingOptions?.find((option) => option.id === thinking)?.label ?? thinking)
  const features = featureValues && Object.keys(featureValues).length
  return [providerName(provider), model && modelLabel(provider, model), modeId, effort, features && `${features} feature${features === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
}

/** The home screen's next session: the profile's provider, model and effort, and (kept in `profile`) its mode and features. */
export function profileDraft(profile: AgentProfile, base: Draft): Draft {
  const { provider, model, modeId, thinking, featureValues } = materialize(profile)
  return {
    ...base,
    provider,
    model,
    label: model && modelLabel(provider, model),
    thinking,
    // The profile's mode replaces the Build/Plan choice.
    agent: undefined,
    profile: { name: profile.name, provider, config: { ...(modeId && { modeId }), ...(featureValues && { featureValues }) } },
  }
}

/** applyAgentConfig's payload for a running session; a mode the session doesn't offer is skipped. */
export function applyConfig(profile: AgentProfile, agent: Pick<PaseoAgent, "availableModes">) {
  const { model, modeId, thinking, featureValues } = materialize(profile)
  const offered = !agent.availableModes || agent.availableModes.some((mode) => mode.id === modeId)
  return {
    ...(model && { modelId: model }),
    ...(modeId && offered && { modeId }),
    ...(thinking && { thinkingOptionId: thinking }),
    ...(featureValues && { featureValues }),
  }
}

export async function openProfiles() {
  const features = daemon.getLastServerInfoMessage()?.features
  if (!features?.agentProfiles || !features.agentConfigApply) return notify("This daemon doesn't support agent profiles; update Paseo", "warning")
  const result = await api.config.get().catch(showError)
  if (!result) return
  const agent = current()
  // A running session can't change provider, and pasode only drives Claude and Codex.
  const providers: readonly string[] = agent ? [agent.provider] : PROVIDERS
  const profiles = (result.config.agentProfiles ?? []).filter((profile) => providers.includes(profile.provider))
  dialog.replace(
    () => (
      <DialogSelect
        title={agent ? `Apply profile to this session · ${providerName(agent.provider)}` : "Agent profiles"}
        emptyText={`No agent profiles for ${providers.map(providerName).join(" or ")} on this daemon`}
        options={profiles.map((profile) => ({ title: profile.name, value: profile.id, description: profileSummary(profile) }))}
        onSelect={(option) => {
          dialog.clear()
          const profile = profiles.find((item) => item.id === option.value)
          if (!profile) return
          if (!agent) {
            rememberDraft(profileDraft(profile, draft()))
            return notify(`Next session uses ${profile.name}`)
          }
          const config = applyConfig(profile, agent)
          if (!Object.keys(config).length) return notify(`${profile.name} sets nothing this session can take`, "warning")
          daemon
            .applyAgentConfig(agent.id, config)
            .then((notice) => notify(notice?.message ?? `Applied ${profile.name}`, notice?.type ?? "success"))
            .catch(showError)
        }}
      />
    ),
    "large",
  )
}
