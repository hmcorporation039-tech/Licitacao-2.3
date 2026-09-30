'use client'

import { use, useEffect, useState } from 'react'
import { useRequireSession } from '@/hooks/useRequireSession'
import { api, ApiRequestError } from '@/lib/api'
import {
  ChecklistItem,
  CompanyDocument,
  ParticipationPlan,
  ParticipationStatus,
  PlanMilestone,
  Tender,
  TenderAnalysis,
  TenderChecklist,
} from '@/lib/types'
import { MODALIDADE_OPTIONS } from '@/lib/modalidades'
import { SITUACAO_OPTIONS } from '@/lib/situacoes'
import { safeHttpUrl } from '@/lib/safeUrl'

// Documento válido (não vencido) do cofre da empresa, indexado por tipo —
// pra marcar automaticamente os itens do checklist que a empresa já tem.
function validDocumentTypes(docs: CompanyDocument[]): Set<string> {
  const now = Date.now()
  const valid = new Set<string>()
  for (const doc of docs) {
    if (!doc.tipo) continue
    if (doc.dataValidade && new Date(doc.dataValidade).getTime() < now) continue
    valid.add(doc.tipo)
  }
  return valid
}

const SEVERIDADE_STYLE: Record<string, string> = {
  alta: 'border-red-300 bg-red-50 text-red-900',
  media: 'border-amber-300 bg-amber-50 text-amber-900',
  baixa: 'border-slate-300 bg-slate-50 text-slate-700',
}

const TABS = [
  { id: 'informacoes', label: 'Informações' },
  { id: 'itens', label: 'Itens' },
  { id: 'analise', label: 'Análise (IA)' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'plano', label: 'Plano de participação' },
] as const

const STATUS_OPTIONS: { value: ParticipationStatus; label: string }[] = [
  { value: 'AVALIANDO', label: 'Avaliando' },
  { value: 'VOU_PARTICIPAR', label: 'Vou participar' },
  { value: 'NAO_VOU_PARTICIPAR', label: 'Não vou participar' },
  { value: 'PARTICIPEI', label: 'Participei' },
]

type TabId = (typeof TABS)[number]['id']

function formatValor(v: string | null) {
  if (!v) return '—'
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatData(v: string | null) {
  if (!v) return '—'
  return new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function groupBySection(items: ChecklistItem[]) {
  const sections = new Map<string, ChecklistItem[]>()
  for (const item of items) {
    if (!sections.has(item.section)) sections.set(item.section, [])
    sections.get(item.section)!.push(item)
  }
  return Array.from(sections.entries())
}

// Campo estilo "grid de rótulos" da tela de informações do processo (BLL)
function InfoField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm text-slate-800">{value ?? '—'}</p>
    </div>
  )
}

export default function TenderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const user = useRequireSession()

  const [tender, setTender] = useState<Tender | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newItemLabel, setNewItemLabel] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('informacoes')

  const [analysis, setAnalysis] = useState<TenderAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [ownedDocTypes, setOwnedDocTypes] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<ParticipationPlan | null>(null)
  const [planSaving, setPlanSaving] = useState(false)
  const [newMilestoneLabel, setNewMilestoneLabel] = useState('')
  const [newMilestoneDate, setNewMilestoneDate] = useState('')

  useEffect(() => {
    if (!user) return
    setLoading(true)
    Promise.all([
      api.get<Tender>(`/api/tenders/${id}`),
      api.get<TenderChecklist>(`/api/tenders/${id}/checklist`),
    ])
      .then(([tenderData, checklistData]) => {
        setTender(tenderData)
        setItems(checklistData.items)
      })
      .finally(() => setLoading(false))

    api
      .get<CompanyDocument[]>('/api/company-documents')
      .then((docs) => setOwnedDocTypes(validDocumentTypes(docs)))
      .catch((err) => console.error(err))

    api
      .get<TenderAnalysis>(`/api/tenders/${id}/analysis`)
      .then(setAnalysis)
      .catch((err) => {
        if (!(err instanceof ApiRequestError && err.status === 404)) {
          console.error(err)
        }
      })

    api
      .get<ParticipationPlan>(`/api/tenders/${id}/plano`)
      .then(setPlan)
      .catch((err) => console.error(err))
  }, [id, user])

  // A análise agora roda num worker (baixar vários PDFs e chamar o modelo leva
  // minutos, e o proxy cortava a requisição antes de terminar). O POST só
  // enfileira; o estado vem daqui.
  async function runAnalysis(force: boolean) {
    setAnalyzing(true)
    try {
      const enfileirada = await api.post<TenderAnalysis>(
        `/api/tenders/${id}/analyze${force ? '?force=true' : ''}`
      )
      setAnalysis(enfileirada)

      if (enfileirada.status !== 'DONE') {
        await aguardarAnalise()
      }

      // A análise pode ter trazido prazo de impugnação/esclarecimento —
      // busca o plano de novo pra esses marcos aparecerem sem precisar recarregar.
      if (user) {
        api
          .get<ParticipationPlan>(`/api/tenders/${id}/plano`)
          .then(setPlan)
          .catch((err) => console.error(err))
      }
    } catch (err) {
      alert(err instanceof ApiRequestError ? err.message : 'Erro ao analisar o edital')
    } finally {
      setAnalyzing(false)
    }
  }

  async function aguardarAnalise() {
    const INTERVALO_MS = 4000
    const TENTATIVAS_MAX = 150 // ~10 minutos

    for (let tentativa = 0; tentativa < TENTATIVAS_MAX; tentativa++) {
      await new Promise((resolve) => setTimeout(resolve, INTERVALO_MS))

      try {
        const atual = await api.get<TenderAnalysis>(`/api/tenders/${id}/analysis`)
        setAnalysis(atual)
        if (atual.status !== 'PENDING' && atual.status !== 'RUNNING') return
      } catch (err) {
        if (!(err instanceof ApiRequestError && err.status === 404)) throw err
      }
    }
  }

  function addChecklistItem(label: string) {
    if (items.some((i) => i.label === label)) return
    const next = [
      ...items,
      {
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        section: 'Documentos Adicionais do Seu Edital',
        label,
        checked: false,
        custom: true,
      },
    ]
    setItems(next)
    persist(next)
  }

  async function persist(nextItems: ChecklistItem[]) {
    if (!user) return
    setSaving(true)
    try {
      await api.put(`/api/tenders/${id}/checklist`, { items: nextItems })
    } finally {
      setSaving(false)
    }
  }

  function toggleItem(itemId: string) {
    const next = items.map((i) => (i.id === itemId ? { ...i, checked: !i.checked } : i))
    setItems(next)
    persist(next)
  }

  function addCustomItem(e: React.FormEvent) {
    e.preventDefault()
    if (!newItemLabel.trim()) return
    const next = [
      ...items,
      {
        id: `custom-${Date.now()}`,
        section: 'Documentos Adicionais do Seu Edital',
        label: newItemLabel.trim(),
        checked: false,
        custom: true,
      },
    ]
    setItems(next)
    setNewItemLabel('')
    persist(next)
  }

  function removeCustomItem(itemId: string) {
    const next = items.filter((i) => i.id !== itemId)
    setItems(next)
    persist(next)
  }

  async function persistPlan(nextStatus: ParticipationStatus, nextMilestones: PlanMilestone[]) {
    if (!user) return
    setPlanSaving(true)
    try {
      const result = await api.put<ParticipationPlan>(`/api/tenders/${id}/plano`, {
        status: nextStatus,
        milestones: nextMilestones,
      })
      setPlan(result)
    } finally {
      setPlanSaving(false)
    }
  }

  function changePlanStatus(status: ParticipationStatus) {
    if (!plan) return
    setPlan({ ...plan, status })
    persistPlan(status, plan.milestones)
  }

  function toggleMilestone(milestoneId: string) {
    if (!plan) return
    const next = plan.milestones.map((m) => (m.id === milestoneId ? { ...m, done: !m.done } : m))
    setPlan({ ...plan, milestones: next })
    persistPlan(plan.status, next)
  }

  function addMilestone(e: React.FormEvent) {
    e.preventDefault()
    if (!plan || !newMilestoneLabel.trim()) return
    const next = [
      ...plan.milestones,
      {
        id: `custom-${Date.now()}`,
        label: newMilestoneLabel.trim(),
        date: newMilestoneDate ? new Date(newMilestoneDate).toISOString() : null,
        detalhe: null,
        done: false,
        custom: true,
      },
    ]
    setPlan({ ...plan, milestones: next })
    setNewMilestoneLabel('')
    setNewMilestoneDate('')
    persistPlan(plan.status, next)
  }

  function removeMilestone(milestoneId: string) {
    if (!plan) return
    const next = plan.milestones.filter((m) => m.id !== milestoneId)
    setPlan({ ...plan, milestones: next })
    persistPlan(plan.status, next)
  }

  if (!user || loading) return <p className="text-sm text-slate-500">Carregando...</p>
  if (!tender) return <p className="text-sm text-red-600">Licitação não encontrada.</p>

  const total = items.length
  const done = items.filter((i) => i.checked).length

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded border border-slate-200 bg-white p-4">
        <h1 className="text-lg font-semibold">{tender.objetoResumido ?? tender.objeto}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {tender.fonte} · {tender.orgao ?? 'órgão n/d'} · {tender.uf ?? 'UF n/d'} · {formatValor(tender.valorEstimado)}
        </p>
      </section>

      <div className="flex flex-col gap-4 sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col sm:gap-2 sm:overflow-visible">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap rounded px-3 py-2 text-left text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'bg-indigo-700 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              {tab.label}
              {tab.id === 'checklist' && (
                <span className={activeTab === tab.id ? 'ml-1 text-indigo-100' : 'ml-1 text-slate-400'}>
                  ({done}/{total})
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {activeTab === 'informacoes' && (
            <section className="rounded border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-lg font-semibold">Informações do processo</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <InfoField label="Órgão" value={tender.orgao} />
                <InfoField label="Nº edital / processo" value={tender.numeroControle} />
                <InfoField label="Fonte" value={tender.fonte} />
                <InfoField
                  label="Modalidade"
                  value={MODALIDADE_OPTIONS.find((o) => o.value === tender.modalidade)?.label ?? tender.modalidade}
                />
                <InfoField
                  label="Situação"
                  value={SITUACAO_OPTIONS.find((o) => o.value === tender.situacao)?.label ?? tender.situacao}
                />
                <InfoField label="Cidade/UF" value={tender.municipio ? `${tender.municipio}/${tender.uf ?? ''}` : tender.uf} />
                <InfoField label="Valor estimado" value={formatValor(tender.valorEstimado)} />
                {tender.valorHomologado && (
                  <InfoField label="Valor homologado" value={formatValor(tender.valorHomologado)} />
                )}
                {tender.fonte === 'PNCP' && tender.srp != null && (
                  <InfoField label="Registro de Preços" value={tender.srp ? 'Sim' : 'Não'} />
                )}
                <InfoField label="Publicação" value={formatData(tender.publicadoAt)} />
                <InfoField label="Abertura" value={formatData(tender.aberturaAt)} />
              </div>

              {safeHttpUrl(tender.linkEdital) && (
                <a
                  href={safeHttpUrl(tender.linkEdital)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-block text-sm text-indigo-700 hover:underline"
                >
                  Ver edital original
                </a>
              )}

              <details className="mt-4 text-sm text-slate-600">
                <summary className="cursor-pointer text-slate-500">Objeto completo</summary>
                <p className="mt-2 whitespace-pre-wrap">{tender.objeto}</p>
              </details>
            </section>
          )}

          {activeTab === 'itens' && (
            <section className="rounded border border-slate-200 bg-white p-4">
              <h2 className="mb-1 text-lg font-semibold">Itens da licitação</h2>
              {!tender.items || tender.items.length === 0 ? (
                <p className="text-sm text-slate-500">Nenhum item detalhado disponível para esta licitação.</p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-slate-500">
                    Códigos CATMAT/CATSER de cada item — use pra cadastrar um item monitorado com match exato,
                    sem depender de palavra-chave.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                          <th className="py-1 pr-3">Descrição</th>
                          <th className="py-1 pr-3">CATMAT</th>
                          <th className="py-1 pr-3">CATSER</th>
                          <th className="py-1 pr-3">Qtd.</th>
                          <th className="py-1">Valor unit.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tender.items.map((it) => (
                          <tr key={it.id} className="border-b border-slate-100 align-top last:border-0">
                            <td className="py-2 pr-3">{it.descricao}</td>
                            <td className="py-2 pr-3 font-mono text-xs">{it.catmatCode ?? '—'}</td>
                            <td className="py-2 pr-3 font-mono text-xs">{it.catserCode ?? '—'}</td>
                            <td className="py-2 pr-3">
                              {it.quantidade ?? '—'} {it.unidadeMedida ?? ''}
                            </td>
                            <td className="py-2">{formatValor(it.valorUnitario)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          )}

          {activeTab === 'analise' && (
            <section className="rounded border border-slate-200 bg-white p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Análise do edital (IA)</h2>
                {analysis?.status === 'DONE' && (
                  <button
                    onClick={() => runAnalysis(true)}
                    disabled={analyzing}
                    className="text-sm text-indigo-700 hover:underline disabled:opacity-50"
                  >
                    Reanalisar
                  </button>
                )}
              </div>

              {!analysis && !analyzing && (
                <div>
                  <p className="mb-3 text-sm text-slate-500">
                    Baixa o edital publicado no PNCP e usa IA para resumir valor, prazo, critério de julgamento,
                    exigências técnicas e pontos de atenção — pode levar até 30 segundos.
                  </p>
                  <button
                    onClick={() => runAnalysis(false)}
                    className="rounded bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800"
                  >
                    Analisar edital com IA
                  </button>
                </div>
              )}

              {analyzing && <p className="text-sm text-slate-500">Baixando e analisando o edital...</p>}

              {!analyzing && analysis?.status === 'NO_DOCUMENTS' && (
                <p className="text-sm text-slate-500">{analysis.errorMsg ?? 'Nenhum documento disponível para análise.'}</p>
              )}

              {!analyzing && analysis?.status === 'FAILED' && (
                <div>
                  <p className="mb-3 text-sm text-red-600">{analysis.errorMsg ?? 'A análise falhou.'}</p>
                  <button
                    onClick={() => runAnalysis(true)}
                    className="rounded bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800"
                  >
                    Tentar novamente
                  </button>
                </div>
              )}

              {!analyzing && analysis?.status === 'DONE' && analysis.resultado && (
                <div className="flex flex-col gap-4">
                  {analysis.documentoNome && (
                    <p className="text-xs text-slate-400">Documento analisado: {analysis.documentoNome}</p>
                  )}
                  <p className="text-sm text-slate-700">{analysis.resultado.resumo}</p>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded border border-slate-200 p-3">
                      <p className="text-xs text-slate-400">Valor estimado</p>
                      <p className="text-sm">{analysis.resultado.valorEstimado}</p>
                    </div>
                    <div className="rounded border border-slate-200 p-3">
                      <p className="text-xs text-slate-400">Prazo de entrega</p>
                      <p className="text-sm">{analysis.resultado.prazoEntrega}</p>
                    </div>
                    <div className="rounded border border-slate-200 p-3">
                      <p className="text-xs text-slate-400">Critério de julgamento</p>
                      <p className="text-sm">{analysis.resultado.criterioJulgamento}</p>
                    </div>
                    <div className="rounded border border-slate-200 p-3">
                      <p className="text-xs text-slate-400">Prazo para esclarecimento</p>
                      <p className="text-sm">{analysis.resultado.prazoEsclarecimento}</p>
                    </div>
                    <div className="rounded border border-slate-200 p-3">
                      <p className="text-xs text-slate-400">Prazo para impugnação</p>
                      <p className="text-sm">{analysis.resultado.prazoImpugnacao}</p>
                    </div>
                  </div>

                  {analysis.resultado.exigenciasTecnicas.length > 0 && (
                    <div>
                      <p className="mb-1 text-sm font-medium text-slate-800">Exigências técnicas</p>
                      <ul className="list-inside list-disc text-sm text-slate-600">
                        {analysis.resultado.exigenciasTecnicas.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {analysis.resultado.documentosExigidos.length > 0 && (
                    <div>
                      <p className="mb-1 text-sm font-medium text-slate-800">
                        Documentos específicos deste edital (além do checklist padrão)
                      </p>
                      <ul className="flex flex-col gap-1 text-sm text-slate-600">
                        {analysis.resultado.documentosExigidos.map((doc, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <span>{doc}</span>
                            <button
                              onClick={() => addChecklistItem(doc)}
                              className="text-xs text-indigo-700 hover:underline"
                            >
                              + adicionar ao checklist
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {analysis.resultado.riscos.length > 0 && (
                    <div>
                      <p className="mb-1 text-sm font-medium text-slate-800">Pontos de atenção</p>
                      <div className="flex flex-col gap-2">
                        {analysis.resultado.riscos.map((r, i) => (
                          <div key={i} className={`rounded border p-3 text-sm ${SEVERIDADE_STYLE[r.severidade] ?? SEVERIDADE_STYLE.baixa}`}>
                            <p className="font-medium">
                              ⚠ {r.titulo} <span className="text-xs font-normal">({r.severidade})</span>
                            </p>
                            <p className="mt-1">{r.descricao}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {activeTab === 'checklist' && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Checklist de habilitação</h2>
                <span className="text-sm text-slate-500">
                  {done}/{total} documentos {saving && '· salvando...'}
                </span>
              </div>
              <p className="mb-4 text-sm text-slate-500">
                Baseado no guia de habilitação da Lei 14.133/2021. Personalize adicionando os documentos
                específicos exigidos neste edital.
              </p>

              <div className="flex flex-col gap-5">
                {groupBySection(items).map(([section, sectionItems]) => (
                  <div key={section} className="rounded border border-slate-200 bg-white p-4">
                    <h3 className="mb-2 font-medium text-slate-800">{section}</h3>
                    <ul className="flex flex-col gap-2">
                      {sectionItems.map((item) => {
                        const owned = !item.custom && ownedDocTypes.has(item.id)
                        return (
                          <li key={item.id} className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={item.checked}
                              onChange={() => toggleItem(item.id)}
                              className="mt-0.5"
                            />
                            <span>
                              {item.label}
                              {item.hint && <span className="text-slate-400"> — {item.hint}</span>}
                              {owned && (
                                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                  ✓ você já tem
                                </span>
                              )}
                            </span>
                            {item.custom && (
                              <button
                                onClick={() => removeCustomItem(item.id)}
                                className="ml-auto text-xs text-red-600 hover:underline"
                              >
                                remover
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>

              <form onSubmit={addCustomItem} className="mt-4 flex gap-2">
                <input
                  placeholder="Adicionar documento específico deste edital"
                  value={newItemLabel}
                  onChange={(e) => setNewItemLabel(e.target.value)}
                  className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
                />
                <button type="submit" className="rounded bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800">
                  Adicionar
                </button>
              </form>
            </section>
          )}

          {activeTab === 'plano' && (
            <section className="rounded border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Plano de participação</h2>
                {planSaving && <span className="text-xs text-slate-400">salvando...</span>}
              </div>

              {!plan ? (
                <p className="text-sm text-slate-500">Carregando...</p>
              ) : (
                <>
                  <div className="mb-4">
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                      Status
                    </label>
                    <select
                      value={plan.status}
                      onChange={(e) => changePlanStatus(e.target.value as ParticipationStatus)}
                      className="rounded border border-slate-300 px-3 py-2 text-sm"
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!analysis && (
                    <p className="mb-4 text-xs text-slate-400">
                      Rode a "Análise (IA)" pra trazer os prazos de impugnação e esclarecimento pra essa linha do
                      tempo — eles não vêm nos dados estruturados do PNCP.
                    </p>
                  )}

                  <ul className="flex flex-col gap-2">
                    {plan.milestones.map((m) => (
                      <li key={m.id} className="flex items-start gap-2 rounded border border-slate-200 p-3 text-sm">
                        <input type="checkbox" checked={m.done} onChange={() => toggleMilestone(m.id)} className="mt-0.5" />
                        <div className="flex-1">
                          <p className="font-medium text-slate-800">{m.label}</p>
                          {m.date && <p className="text-xs text-slate-500">{formatData(m.date)}</p>}
                          {m.detalhe && <p className="text-xs text-slate-500">{m.detalhe}</p>}
                        </div>
                        {m.custom && (
                          <button onClick={() => removeMilestone(m.id)} className="text-xs text-red-600 hover:underline">
                            remover
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  <form onSubmit={addMilestone} className="mt-4 flex flex-wrap gap-2">
                    <input
                      placeholder="Adicionar etapa própria (ex: reunião interna de decisão)"
                      value={newMilestoneLabel}
                      onChange={(e) => setNewMilestoneLabel(e.target.value)}
                      className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
                    />
                    <input
                      type="date"
                      value={newMilestoneDate}
                      onChange={(e) => setNewMilestoneDate(e.target.value)}
                      className="rounded border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button type="submit" className="rounded bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800">
                      Adicionar
                    </button>
                  </form>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
