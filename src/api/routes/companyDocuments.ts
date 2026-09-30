// ============================================================
// api/routes/companyDocuments.ts — Cofre de documentos da empresa
// Documentos cadastrados uma vez (não por licitação), cruzados
// automaticamente com o checklist de cada licitação pelo campo `tipo`.
// ============================================================

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../services/tenderService'
import { asyncHandler, ApiError } from '../asyncHandler'

export const companyDocumentsRouter = Router()

const createSchema = z.object({
  tipo: z.string().min(1).max(120).nullable().optional(),
  nome: z.string().min(1).max(200),
  dataEmissao: z.coerce.date().nullable().optional(),
  dataValidade: z.coerce.date().nullable().optional(),
  observacao: z.string().max(2000).nullable().optional(),
})

const updateSchema = createSchema.partial()

async function assertOwnership(docId: string, companyId: string) {
  const doc = await prisma.companyDocument.findUnique({ where: { id: docId } })
  if (!doc) throw new ApiError(404, 'Documento não encontrado')
  if (doc.companyId !== companyId) throw new ApiError(403, 'Este documento não pertence a você')
  return doc
}

companyDocumentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)
    const doc = await prisma.companyDocument.create({
      data: { ...body, companyId: req.companyId!, userId: req.userId! },
    })
    res.status(201).json(doc)
  })
)

companyDocumentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const docs = await prisma.companyDocument.findMany({
      where: { companyId: req.companyId! },
      orderBy: { createdAt: 'desc' },
    })
    res.json(docs)
  })
)

companyDocumentsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    await assertOwnership(req.params.id, req.companyId!)

    const data = updateSchema.parse(req.body)
    const updated = await prisma.companyDocument.update({ where: { id: req.params.id }, data })
    res.json(updated)
  })
)

companyDocumentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await assertOwnership(req.params.id, req.companyId!)

    await prisma.companyDocument.delete({ where: { id: req.params.id } })
    res.status(204).send()
  })
)
