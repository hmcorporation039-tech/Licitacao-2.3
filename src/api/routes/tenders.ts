// ============================================================
// api/routes/tenders.ts — Feed público de licitações coletadas
// ============================================================

import { Router } from 'express'
import { z } from 'zod'
import { prisma, saveTenderItemsIfMissing } from '../../services/tenderService'
import { asyncHandler, ApiError } from '../asyncHandler'
import { escritaSensivelLimiter } from '../rateLimit'
import { buildChecklistTemplate, ChecklistItem } from '../../lib/checklistTemplate'
import { analiseHabilitada } from '../../services/editalAnalysisService'
import { analiseQueue } from '../../queues'
import { enfileirarSemTravar } from '../../queues/enfileirar'
import { fetchPNCPItens } from '../../services/pncpItemsService'
import { MODALIDADE_VALUES } from './monitoredItems'
import { normalize } from '../../lib/geoService'
import { buildAutoMilestones, PlanMilestone } from '../../lib/participationPlanTemplate'

export const tendersRouter = Router()

const SITUACAO_VALUES = ['ABERTA', 'ENCERRADA', 'SUSPENSA', 'CANCELADA', 'ANULADA', 'HOMOLOGADA', 'REVOGADA'] as const

const querySchema = z.object({
  uf: z.string().length(2).optional(),
  modalidade: z.enum(MODALIDADE_VALUES).optional(),
  situacao: z.enum(SITUACAO_VALUES).optional(),
  orgao: z.string().trim().min(1).max(200).optional(),
  municipio: z.string().trim().min(1).max(200).optional(),
  // "Nº edital" no estilo BLL — busca pelo número de controle do PNCP/ComprasNet
  numero: z.string().trim().min(1).max(100).optional(),
  publicacaoInicio: z.coerce.date().optional(),
  publicacaoFim: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  // Quando true, restringe o feed às licitações que deram match com algum
  // item monitorado do usuário logado (em vez do feed público completo) —
  // o cruzamento em si é feito pelo matcher (casamento literal de palavra-
  // chave + código CATMAT/CATSER), aqui só filtramos e classificamos.
  somenteRelacionadas: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Agrupa visualmente por Estado e depois por Órgão/Prefeitura, em vez do
  // feed cronológico padrão — muda só a ordenação; o agrupamento em si
  // (inserir os cabeçalhos de UF/Órgão) é feito no front, olhando pra
  // sequência já vindo ordenada assim.
  agrupar: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
})

tendersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      uf,
      modalidade,
      situacao,
      orgao,
      municipio,
      numero,
      publicacaoInicio,
      publicacaoFim,
      q,
      somenteRelacionadas,
      agrupar,
      page,
      pageSize,
    } = querySchema.parse(req.query)
    const companyId = somenteRelacionadas ? req.companyId! : undefined

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {}
    if (uf) where.uf = uf
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (modalidade) where.modalidade = modalidade as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (situacao) where.situacao = situacao as any
    // Busca contra as colunas *_norm (minúsculas, sem acento) em vez das colunas
    // originais — assim "uberlandia" encontra "Uberlândia" sem depender da
    // extensão unaccent do Postgres (ver comentário no schema.prisma).
    if (orgao) where.orgaoNorm = { contains: normalize(orgao) }
    if (municipio) where.municipioNorm = { contains: normalize(municipio) }
    if (numero) where.numeroControle = { contains: numero, mode: 'insensitive' }
    if (publicacaoInicio || publicacaoFim) {
      where.publicadoAt = {
        ...(publicacaoInicio ? { gte: publicacaoInicio } : {}),
        ...(publicacaoFim ? { lte: publicacaoFim } : {}),
      }
    }
    if (q) {
      const qNorm = normalize(q)
      where.OR = [{ objetoNorm: { contains: qNorm } }, { objetoResumidoNorm: { contains: qNorm } }]
    }
    if (companyId) where.tenderMatches = { some: { companyId } }

    const [rows, total] = await Promise.all([
      prisma.tender.findMany({
        where,
        orderBy: agrupar
          ? [{ uf: 'asc' }, { orgao: 'asc' }, { publicadoAt: 'desc' }]
          : { publicadoAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: companyId
          ? { tenderMatches: { where: { companyId }, include: { monitoredItem: { select: { id: true, name: true } } } } }
          : undefined,
      }),
      prisma.tender.count({ where }),
    ])

    // Classifica a relevância do match (maior score entre os itens que bateram
    // com esta licitação) pra dar ao usuário um sinal rápido de prioridade.
    const items = rows.map((t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matches = (t as any).tenderMatches as
        | { score: number; matchedKeywords: string[]; monitoredItem: { id: string; name: string } }[]
        | undefined
      if (!matches) return t

      const bestScore = matches.reduce((max, m) => Math.max(max, m.score), 0)
      const classificacao = bestScore >= 0.99 ? 'exata' : bestScore >= 0.7 ? 'alta' : 'media'

      return {
        ...t,
        tenderMatches: undefined,
        match: {
          score: bestScore,
          classificacao,
          itensRelacionados: matches.map((m) => m.monitoredItem.name),
          palavrasChave: Array.from(new Set(matches.flatMap((m) => m.matchedKeywords))),
        },
      }
    })

    res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) })
  })
)

tendersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    let tender = await prisma.tender.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    })
    if (!tender) {
      res.status(404).json({ error: 'Licitação não encontrada' })
      return
    }

    // Busca sob demanda: a coleta periódica não traz os itens (chamada separada
    // no PNCP) — busca na primeira vez que alguém abre o detalhe e guarda.
    if (tender.items.length === 0 && tender.fonte === 'PNCP') {
      const raw = tender.rawJson as Record<string, unknown>
      const orgaoEntidade = raw.orgaoEntidade as Record<string, unknown> | undefined
      const cnpj = orgaoEntidade?.cnpj as string | undefined
      const ano = raw.anoCompra as number | undefined
      const sequencial = raw.sequencialCompra as number | undefined

      if (cnpj && ano && sequencial) {
        try {
          const itens = await fetchPNCPItens(cnpj, ano, sequencial)
          await saveTenderItemsIfMissing(tender.id, itens)
          tender = await prisma.tender.findUnique({ where: { id: req.params.id }, include: { items: true } })
        } catch (err) {
          console.error('[Tenders] Erro ao buscar itens do PNCP:', err)
        }
      }
    }

    res.json(tender)
  })
)

const checklistItemSchema = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
  checked: z.boolean(),
  custom: z.boolean(),
})

const putChecklistSchema = z.object({
  items: z.array(checklistItemSchema).min(1),
})

// Retorna o checklist do usuário para esta licitação, criando a partir do
// template padrão (guia de habilitação Lei 14.133/2021) na primeira vez.
tendersRouter.get(
  '/:id/checklist',
  asyncHandler(async (req, res) => {
    const companyId = req.companyId!

    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    const existing = await prisma.tenderChecklist.findUnique({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
    })
    if (existing) {
      res.json(existing)
      return
    }

    const created = await prisma.tenderChecklist.create({
      data: {
        companyId,
        userId: req.userId!,
        tenderId: req.params.id,
        items: buildChecklistTemplate() as unknown as object,
      },
    })
    res.json(created)
  })
)

// Salva o estado do checklist (itens marcados + itens customizados adicionados
// pelo usuário) — o frontend envia o array completo a cada alteração.
tendersRouter.put(
  '/:id/checklist',
  asyncHandler(async (req, res) => {
    const { items } = putChecklistSchema.parse(req.body)
    const companyId = req.companyId!

    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    const saved = await prisma.tenderChecklist.upsert({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
      update: { items: items as ChecklistItem[] as unknown as object },
      create: {
        companyId,
        userId: req.userId!,
        tenderId: req.params.id,
        items: items as ChecklistItem[] as unknown as object,
      },
    })
    res.json(saved)
  })
)

// Retorna a análise do edital feita por IA, se já existir.
tendersRouter.get(
  '/:id/analysis',
  asyncHandler(async (req, res) => {
    const analysis = await prisma.tenderAnalysis.findUnique({ where: { tenderId: req.params.id } })
    if (!analysis) {
      res.status(404).json({ error: 'Análise ainda não foi solicitada para esta licitação' })
      return
    }
    res.json(analysis)
  })
)

// Enfileira a análise do edital e responde na hora com o status. O trabalho
// em si (baixar os PDFs do PNCP e chamar o modelo) leva minutos e roda no
// worker — antes era síncrono aqui e o proxy cortava a requisição antes de
// terminar. O cliente acompanha por GET /:id/analysis.
tendersRouter.post(
  '/:id/analyze',
  escritaSensivelLimiter,
  asyncHandler(async (req, res) => {
    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    if (!analiseHabilitada()) {
      throw new ApiError(503, 'A análise de edital por IA está desligada nesta instalação')
    }

    // Reanálise forçada sobrescreve a análise que TODAS as empresas veem e
    // gasta crédito de IA — por isso só admin pode forçar. Usuário comum
    // recebe a análise já existente (ou dispara a primeira, se não houver).
    const force = req.query.force === 'true' && req.isAdmin === true
    const existing = await prisma.tenderAnalysis.findUnique({ where: { tenderId: req.params.id } })

    if (!force) {
      if (existing?.status === 'DONE') {
        res.json(existing)
        return
      }
      if (existing?.status === 'RUNNING' || existing?.status === 'PENDING') {
        res.status(202).json(existing)
        return
      }
    }

    const pendente = await prisma.tenderAnalysis.upsert({
      where: { tenderId: req.params.id },
      update: { status: 'PENDING', errorMsg: null },
      create: { tenderId: req.params.id, status: 'PENDING' },
    })

    const enfileirou = await enfileirarSemTravar(
      analiseQueue,
      'analisar-edital',
      { tenderId: req.params.id },
      'Análise'
    )
    if (!enfileirou) {
      throw new ApiError(503, 'A fila de análise está indisponível no momento — tente de novo em alguns minutos')
    }

    res.status(202).json(pendente)
  })
)

export const PARTICIPATION_STATUS_VALUES = ['AVALIANDO', 'VOU_PARTICIPAR', 'NAO_VOU_PARTICIPAR', 'PARTICIPEI'] as const

interface PlanState {
  doneIds: string[]
  custom: PlanMilestone[]
}

async function buildPlanResponse(tenderId: string, status: string, state: PlanState) {
  const tender = await prisma.tender.findUnique({
    where: { id: tenderId },
    select: { publicadoAt: true, encerramentoAt: true, aberturaAt: true },
  })
  const analysis = await prisma.tenderAnalysis.findUnique({ where: { tenderId } })
  const analysisPrazos =
    analysis?.status === 'DONE' && analysis.resultado
      ? (analysis.resultado as unknown as { prazoImpugnacao: string; prazoEsclarecimento: string })
      : null

  const auto = buildAutoMilestones(tender ?? { publicadoAt: null, encerramentoAt: null, aberturaAt: null }, analysisPrazos).map(
    (m) => ({ ...m, done: m.done || state.doneIds.includes(m.id) })
  )

  return { status, milestones: [...auto, ...state.custom] }
}

// Retorna o plano de participação, criando um vazio na primeira vez. Os
// marcos automáticos (datas da licitação + prazos da análise por IA) são
// recalculados a cada consulta — ver participationPlanTemplate.ts.
tendersRouter.get(
  '/:id/plano',
  asyncHandler(async (req, res) => {
    const companyId = req.companyId!

    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    const existing = await prisma.tenderParticipationPlan.findUnique({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
    })

    const state = (existing?.state as unknown as PlanState) ?? { doneIds: [], custom: [] }
    const status = existing?.status ?? 'AVALIANDO'

    res.json(await buildPlanResponse(req.params.id, status, state))
  })
)

const putPlanoSchema = z.object({
  status: z.enum(PARTICIPATION_STATUS_VALUES),
  milestones: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      date: z.string().nullable(),
      detalhe: z.string().nullable(),
      done: z.boolean(),
      custom: z.boolean(),
    })
  ),
})

// Salva o status de decisão + quais marcos foram marcados como feitos +
// marcos customizados — o frontend envia a lista completa (automáticos +
// customizados) a cada alteração, igual ao checklist.
tendersRouter.put(
  '/:id/plano',
  asyncHandler(async (req, res) => {
    const { status, milestones } = putPlanoSchema.parse(req.body)
    const companyId = req.companyId!

    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    const state: PlanState = {
      doneIds: milestones.filter((m) => !m.custom && m.done).map((m) => m.id),
      custom: milestones.filter((m) => m.custom),
    }

    await prisma.tenderParticipationPlan.upsert({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
      update: { status, state: state as unknown as object },
      create: {
        companyId,
        userId: req.userId!,
        tenderId: req.params.id,
        status,
        state: state as unknown as object,
      },
    })

    res.json(await buildPlanResponse(req.params.id, status, state))
  })
)

const putPlanoStatusSchema = z.object({ status: z.enum(PARTICIPATION_STATUS_VALUES) })

// Troca só o status de decisão (ex: "marcar como interessado" a partir da
// lista de matches), sem precisar reenviar a lista inteira de marcos —
// diferente do PUT completo acima, não corre o risco de apagar progresso
// já salvo (itens marcados, marcos customizados) por causa de um corpo
// enviado sem eles.
tendersRouter.patch(
  '/:id/plano/status',
  asyncHandler(async (req, res) => {
    const { status } = putPlanoStatusSchema.parse(req.body)
    const companyId = req.companyId!

    const tender = await prisma.tender.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!tender) throw new ApiError(404, 'Licitação não encontrada')

    const existing = await prisma.tenderParticipationPlan.findUnique({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
    })
    const state = (existing?.state as unknown as PlanState) ?? { doneIds: [], custom: [] }

    await prisma.tenderParticipationPlan.upsert({
      where: { companyId_tenderId: { companyId, tenderId: req.params.id } },
      update: { status },
      create: {
        companyId,
        userId: req.userId!,
        tenderId: req.params.id,
        status,
        state: state as unknown as object,
      },
    })

    res.json(await buildPlanResponse(req.params.id, status, state))
  })
)
