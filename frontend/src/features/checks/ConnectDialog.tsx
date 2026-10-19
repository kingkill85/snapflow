import { useQuery } from '@tanstack/react-query'
import { Plug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Candidate, Finding } from '@/api/generated/model'
import { connectionCandidates, useCreateConnection } from '@/api/generated/wiring/wiring'
import { Badge, Button, Dialog, ErrorMessage, Loading, Notice } from '@/components/ui'

import { useFindingText, useReasonText } from './format'
import { type ChannelRef, needKey, useRefreshWiring, type WiringModel } from './wiring'

/** What the picker connects: a need (lists channels) or a channel (lists needs). */
export type ConnectTarget = { kind: 'need'; needPlanId: string; needId: string } | ({ kind: 'channel' } & ChannelRef)

type Props = {
  versionId: string
  wiring: WiringModel
  target: ConnectTarget | null
  onOpenChange: (open: boolean) => void
  /** After a connection was made, with its warnings (limit unknown, minimum load). */
  onConnected?: (warnings: Finding[]) => void
}

const shownProblems = 8

/**
 * The connect picker (step 3d): the candidates the API computes for a need (compatible channels, in-room
 * devices first) or for a channel (needs with unconnected units), each with the units it takes; when none
 * fits, the reason and the rule each candidate breaks.
 */
export function ConnectDialog({ versionId, wiring, target, onOpenChange, onConnected }: Props) {
  const { t } = useTranslation('checks')
  const { t: tCommon } = useTranslation()
  const findingText = useFindingText()
  const reasonText = useReasonText()
  const refresh = useRefreshWiring(versionId)
  const create = useCreateConnection()
  const [pending, setPending] = useState<string | null>(null)
  const body =
    target?.kind === 'need'
      ? { needPlanId: target.needPlanId, needId: target.needId }
      : target
        ? { targetPlanId: target.targetPlanId, targetItemId: target.targetItemId, outputKindId: target.outputKindId, channelNo: target.channelNo }
        : null
  const candidates = useQuery({
    queryKey: ['connectionCandidates', versionId, body],
    queryFn: ({ signal }) => connectionCandidates(versionId, body!, signal),
    enabled: body !== null,
    gcTime: 0,
  })
  const need = target?.kind === 'need' ? wiring.needs.get(needKey(target.needPlanId, target.needId)) : undefined
  const title =
    target?.kind === 'need'
      ? t('connect.titleNeed', { need: wiring.needText(need) })
      : target
        ? t('connect.titleChannel', { channel: wiring.channelText(target) })
        : ''
  const items = candidates.data?.items ?? []
  const fitting = items.filter((c) => !c.problem)
  const broken = items.filter((c) => c.problem)
  const describe = (c: Candidate) => {
    if (target?.kind === 'need') return wiring.channelText(c)
    const n = wiring.needs.get(needKey(c.needPlanId, c.needId))
    return n ? `${wiring.needText(n)} — ${wiring.needPlace(n)}` : t('fallback.need')
  }
  const connect = async (c: Candidate) => {
    const key = `${c.needId}/${c.targetItemId}/${c.outputKindId}/${c.channelNo}`
    setPending(key)
    try {
      const result = await create.mutateAsync({
        versionId,
        data: {
          needPlanId: c.needPlanId,
          needId: c.needId,
          units: c.units,
          targetPlanId: c.targetPlanId,
          targetItemId: c.targetItemId,
          outputKindId: c.outputKindId,
          channelNo: c.channelNo,
        },
      })
      await refresh()
      onConnected?.(result.warnings)
      onOpenChange(false)
    } catch {
      // shown by ErrorMessage
    } finally {
      setPending(null)
    }
  }
  // Refused candidates: limits worded as what the connection would draw (no channel name), so identical
  // refusals are grouped ("12 channels: would draw 17.39 A at 230 V (at most 16 A)"); others name the candidate.
  const refusals: { key: string; text: string; names: string[] }[] = []
  for (const c of broken) {
    const names = {
      channel: wiring.channelText(c),
      need: wiring.needText(wiring.needs.get(needKey(c.needPlanId, c.needId))),
      item: wiring.itemName(wiring.items.get(`${c.targetPlanId}/${c.targetItemId}`)),
    }
    const words = findingText({ code: c.problem!.code, params: c.problem!.params }, names, true)
    const name = describe(c)
    const short = target?.kind === 'need' ? name : names.need
    const prev = refusals.find((g) => g.key === words)
    if (prev) prev.names.push(name)
    // The rule's sentence mostly names the candidate already (D417).
    else refusals.push({ key: words, text: words.includes(short) ? words : `${name}: ${words}`, names: [name] })
  }
  for (const g of refusals) {
    if (g.names.length > 1) g.text = t(target?.kind === 'need' ? 'candidate.groupChannels' : 'candidate.groupNeeds', { count: g.names.length, text: g.key })
  }
  const functionType = need ? wiring.functionTypeName(need.functionTypeId) : undefined
  const reason = candidates.data?.reason
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) create.reset()
        onOpenChange(open)
      }}
      title={title}
      description={target?.kind === 'need' ? t('connect.descriptionNeed') : t('connect.descriptionChannel')}
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {tCommon('action.cancel')}
        </Button>
      }
    >
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <ErrorMessage error={create.error ?? candidates.error} />
        {candidates.isPending && body !== null ? (
          <Loading />
        ) : (
          <>
            {reason && (
              <Notice tone="warning">{reason === 'complete' ? t(target?.kind === 'need' ? 'connect.complete' : 'connect.noNeeds') : reasonText(reason, functionType)}</Notice>
            )}
            {fitting.length > 0 && (
              <ul className="divide-y divide-line rounded-control border border-line" aria-label={t('connect.fitting')}>
                {fitting.map((c) => {
                  const key = `${c.needId}/${c.targetItemId}/${c.outputKindId}/${c.channelNo}`
                  const text = describe(c)
                  return (
                    <li key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate">{text}</p>
                        <p className="flex flex-wrap gap-1 text-xs text-muted">
                          <span>{t('connect.units', { count: c.units })}</span>
                          {c.inZone && <Badge variant="primary">{t('connect.inZone')}</Badge>}
                          {!c.free && <Badge>{t('connect.circuit')}</Badge>}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t('connect.connectTo', { name: text })}
                        disabled={!wiring.canUpdate || pending !== null}
                        onClick={() => void connect(c)}
                      >
                        <Plug aria-hidden />
                        {t('connect.connect')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
            {broken.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted">{t('connect.notPossible', { count: broken.length })}</p>
                <ul className="space-y-1 text-sm text-muted">
                  {refusals.slice(0, shownProblems).map((g) => (
                    <li key={g.key} title={g.names.length > 1 ? g.names.join('\n') : undefined}>
                      {g.text}
                    </li>
                  ))}
                  {refusals.length > shownProblems && <li>{t('connect.more', { count: refusals.length - shownProblems })}</li>}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
