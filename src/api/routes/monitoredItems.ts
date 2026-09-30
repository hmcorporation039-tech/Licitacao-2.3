// ============================================================
// api/routes/monitoredItems.ts — CRUD de itens monitorados + rematch
// ============================================================

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../services/tenderService'
import { findMatchingTendersForItem } from '../../services/matcherService'
import { findMunicipioByNomeUf } from '../../lib/geoService'
import { notificadorQueue } from '../../queues'
import { enfileirarSemTravar } from '../../queues/enfileirar'
import { asyncHandler, ApiError } from '../asyncHandler'

export const monitoredItemsRouter = Router()

// Precisa bater exatamente com o enum ModalidadeEnum do schema.prisma —
// é contra esses valores que o matcher compara tenders.modalidade.
export const MODALIDADE_VALUES = [
  'PREGAO_ELETRONICO',
  'PREGAO_PRESENCIAL',
  'CONCORRENCIA',
  'DISPENSA_COM_DISPUTA',
  'DISPENSA_SEM_DISPUTA',
  'INEXIGIBILIDADE',
  'CONVITE',
  'TOMADA_DE_PRECOS',
  'CONCURSO',
  'CREDENCIAMENTO',
  'DIALOGO_COMPETITIVO',
  'OUTROS',
] as const

// Tetos de tamanho: sem eles um único item podia chegar com dezenas de
// milhares de palavras-chave (cada uma vira uma regex avaliada no rematch de
// 90 dias) ou strings enormes — custo de CPU/memória desproporcional. Os
// limites são bem acima de qualquer uso real.
const MAX_ITENS_LISTA = 200
const MAX_TAM_TERMO = 120

const createSchema = z.object({
  name: z.string().min(1).max(200),
  keywords: z.array(z.string().min(1).max(MAX_TAM_TERMO)).max(MAX_ITENS_LISTA).default([]),
  catmatCodes: z.array(z.string().max(MAX_TAM_TERMO)).max(MAX_ITENS_LISTA).default([]),
  catserCodes: z.array(z.string().max(MAX_TAM_TERMO)).max(MAX_ITENS_LISTA).default([]),
  ufs: z.array(z.string().length(2)).max(27).default([]),
  valorMin: z.number().nonnegative().nullable().optional(),
  valorMax: z.number().nonnegative().nullable().optional(),
  modalidades: z.array(z.enum(MODALIDADE_VALUES)).max(MODALIDADE_VALUES.length).default([]),
  // Filtro por órgão — nome específico ou trecho (categoria, ex: "PREFEITURA")
  orgaos: z.array(z.string().min(1).max(MAX_TAM_TERMO)).max(MAX_ITENS_LISTA).default([]),
  // Filtro por código UASG — só bate com licitações do ComprasNet (ver
  // uasgMatches em matcherService.ts). Selecionado via busca em /api/uasg/search.
  uasgCodes: z.array(z.string().min(1).max(MAX_TAM_TERMO)).max(MAX_ITENS_LISTA).default([]),
  // Filtro por raio de distância — alternativa ao filtro por UF
  raioKm: z.number().int().positive().nullable().optional(),
  origemMunicipio: z.string().min(1).max(200).nullable().optional(),
  origemUf: z.string().length(2).nullable().optional(),
})

const updateSchema = createSchema.partial()

// Resolve nome+UF de cidade em lat/lng usando a base do IBGE
function geocodeOrigem(municipio: string, uf: string): { lat: number; lng: number } {
  const geo = findMunicipioByNomeUf(municipio, uf)
  if (!geo) {
    throw new ApiError(400, `Cidade de referência "${municipio}/${uf.toUpperCase()}" não encontrada — confira o nome e a UF`)
  }
  return { lat: geo.lat, lng: geo.lng }
}

async function assertOwnership(itemId: string, companyId: string) {
  const item = await prisma.monitoredItem.findUnique({ where: { id: itemId } })
  if (!item) throw new ApiError(404, 'Item monitorado não encontrado')
  if (item.companyId !== companyId) throw new ApiError(403, 'Este item não pertence a você')
  return item
}

monitoredItemsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)

    if (body.keywords.length === 0 && body.catmatCodes.length === 0 && body.catserCodes.length === 0) {
      throw new ApiError(400, 'Informe ao menos uma palavra-chave ou código CATMAT/CATSER')
    }

    let origemLat: number | null = null
    let origemLng: number | null = null
    if (body.raioKm) {
      if (!body.origemMunicipio || !body.origemUf) {
        throw new ApiError(400, 'Informe a cidade e a UF de referência para usar o filtro de raio de distância')
      }
      const geo = geocodeOrigem(body.origemMunicipio, body.origemUf)
      origemLat = geo.lat
      origemLng = geo.lng
    }

    const item = await prisma.monitoredItem.create({
      data: { ...body, companyId: req.companyId!, userId: req.userId!, origemLat, origemLng },
    })
    res.status(201).json(item)
  })
)

monitoredItemsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await prisma.monitoredItem.findMany({
      where: { companyId: req.companyId! },
      orderBy: { createdAt: 'desc' },
    })
    res.json(items)
  })
)

monitoredItemsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await assertOwnership(req.params.id, req.companyId!)
    res.json(item)
  })
)

monitoredItemsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await assertOwnership(req.params.id, req.companyId!)

    const data = updateSchema.parse(req.body)

    // Campos ausentes no PATCH mantêm o valor atual; campos presentes (mesmo
    // que null) substituem — por isso o merge explícito com "!== undefined".
    const effectiveRaioKm = data.raioKm !== undefined ? data.raioKm : existing.raioKm
    const effectiveMunicipio = data.origemMunicipio !== undefined ? data.origemMunicipio : existing.origemMunicipio
    const effectiveUf = data.origemUf !== undefined ? data.origemUf : existing.origemUf

    let origemLat: number | null = null
    let origemLng: number | null = null
    if (effectiveRaioKm) {
      if (!effectiveMunicipio || !effectiveUf) {
        throw new ApiError(400, 'Informe a cidade e a UF de referência para usar o filtro de raio de distância')
      }
      const geo = geocodeOrigem(effectiveMunicipio, effectiveUf)
      origemLat = geo.lat
      origemLng = geo.lng
    }

    const updated = await prisma.monitoredItem.update({
      where: { id: req.params.id },
      data: { ...data, origemLat, origemLng },
    })
    res.json(updated)
  })
)

monitoredItemsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await assertOwnership(req.params.id, req.companyId!)

    await prisma.monitoredItem.delete({ where: { id: req.params.id } })
    res.status(204).send()
  })
)

// Varre licitações já coletadas (não espera o próximo ciclo do worker) em busca
// de matches para este item — útil logo após o cadastro.
monitoredItemsRouter.post(
  '/:id/rematch',
  asyncHandler(async (req, res) => {
    const item = await assertOwnership(req.params.id, req.companyId!)

    const candidates = await findMatchingTendersForItem(
      {
        keywords: item.keywords,
        catmatCodes: item.catmatCodes,
        catserCodes: item.catserCodes,
        ufs: item.ufs,
        modalidades: item.modalidades,
        orgaos: item.orgaos,
        uasgCodes: item.uasgCodes,
        valorMin: item.valorMin ? Number(item.valorMin) : null,
        valorMax: item.valorMax ? Number(item.valorMax) : null,
        raioKm: item.raioKm,
        origemLat: item.origemLat,
        origemLng: item.origemLng,
      },
      90
    )

    if (candidates.length === 0) {
      res.json({ matchesFound: 0 })
      return
    }

    const tenderIds = candidates.map((c) => c.tenderId)
    const existing = await prisma.tenderMatch.findMany({
      where: { monitoredItemId: item.id, tenderId: { in: tenderIds } },
      select: { tenderId: true },
    })
    const existingSet = new Set(existing.map((e) => e.tenderId))
    const newCandidates = candidates.filter((c) => !existingSet.has(c.tenderId))

    if (newCandidates.length === 0) {
      res.json({ matchesFound: 0 })
      return
    }

    await prisma.tenderMatch.createMany({
      data: newCandidates.map((c) => ({
        tenderId: c.tenderId,
        monitoredItemId: item.id,
        companyId: item.companyId,
        userId: item.userId,
        score: c.score,
        matchedKeywords: c.matchedKeywords,
      })),
      skipDuplicates: true,
    })

    const created = await prisma.tenderMatch.findMany({
      where: { monitoredItemId: item.id, tenderId: { in: newCandidates.map((c) => c.tenderId) } },
      select: { id: true },
    })

    // Enfileirar o e-mail é um efeito colateral, não o objetivo do rematch —
    // se o Redis estiver indisponível (ex: cota do plano gratuito estourada),
    // isso não pode derrubar a resposta com os matches que já foram achados.
    for (const match of created) {
      await enfileirarSemTravar(notificadorQueue, 'notify-match', { tenderMatchId: match.id }, 'Rematch')
    }

    res.json({ matchesFound: created.length })
  })
)
