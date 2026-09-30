// ============================================================
// api/routes/admin.ts — Gestão de usuários (só administradores).
// Cadastro de conta com prazo de acesso determinado (dias) — pra dar
// acesso de teste a clientes/empresas sem precisar lembrar de desativar
// manualmente depois.
// ============================================================

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../services/tenderService'
import { generateTempPassword, hashPassword, normalizeEmail } from '../../services/authService'
import { senhaSchema } from '../passwordPolicy'
import { asyncHandler, ApiError } from '../asyncHandler'
import { requireAdmin, requireAuth } from '../authMiddleware'
import { escritaSensivelLimiter } from '../rateLimit'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

function computeExpiresAt(diasValidade: number | null | undefined): Date | null {
  if (!diasValidade) return null
  return new Date(Date.now() + diasValidade * 24 * 60 * 60 * 1000)
}

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  password: senhaSchema.optional(), // se ausente, gera uma temporária
  isAdmin: z.boolean().default(false),
  diasValidade: z.number().int().positive().nullable().optional(), // null/ausente = acesso sem prazo
})

adminRouter.post(
  '/users',
  escritaSensivelLimiter,
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body)
    const email = normalizeEmail(body.email)

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'Já existe um usuário com este e-mail')

    const tempPassword = body.password ?? generateTempPassword()

    const user = await prisma.user.create({
      data: {
        email,
        name: body.name,
        passwordHash: await hashPassword(tempPassword),
        isAdmin: body.isAdmin,
        accessExpiresAt: computeExpiresAt(body.diasValidade),
        // Toda conta precisa de uma Company (ver schema.prisma) — quem se
        // cadastra sozinho ganha uma individual (PESSOA_FISICA), sem
        // precisar de CNPJ. Convidar alguém para uma empresa já existente
        // é a Etapa 1b.
        company: { create: { name: body.name ?? body.email } },
      },
    })

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      accessExpiresAt: user.accessExpiresAt,
      // Só aparece nesta resposta, uma vez — não fica salvo em lugar nenhum
      // além do hash. Se o admin não passou uma senha própria, precisa
      // repassar esta pro usuário (por um canal seguro).
      generatedPassword: body.password ? undefined : tempPassword,
    })
  })
)

adminRouter.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        isAdmin: true,
        active: true,
        accessExpiresAt: true,
        createdAt: true,
        passwordHash: true,
      },
    })
    res.json(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isAdmin: u.isAdmin,
        active: u.active,
        accessExpiresAt: u.accessExpiresAt,
        createdAt: u.createdAt,
        hasPassword: u.passwordHash != null,
      }))
    )
  })
)

const updateUserSchema = z.object({
  active: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  // Redefine o prazo a partir de agora (null = remove o prazo, acesso passa a ser indeterminado)
  diasValidade: z.number().int().positive().nullable().optional(),
})

adminRouter.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const body = updateUserSchema.parse(req.body)
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new ApiError(404, 'Usuário não encontrado')

    const data: {
      active?: boolean
      isAdmin?: boolean
      accessExpiresAt?: Date | null
      tokenVersion?: { increment: number }
      disabledByAdmin?: boolean
    } = {}
    if (body.active !== undefined) {
      data.active = body.active
      // Desativar precisa derrubar a sessão em curso, não só impedir o próximo
      // login — o token de 30 dias sobreviveria até expirar sozinho.
      if (!body.active) data.tokenVersion = { increment: 1 }
      // Marca/limpa a trava de "desativado pelo admin": enquanto ligada, o
      // dono da empresa não consegue reativar a conta (só o admin) — ver
      // company.ts. Reativar pelo admin libera a conta de novo.
      data.disabledByAdmin = !body.active
    }
    if (body.isAdmin !== undefined) data.isAdmin = body.isAdmin
    if (body.diasValidade !== undefined) data.accessExpiresAt = computeExpiresAt(body.diasValidade)

    const updated = await prisma.user.update({ where: { id: req.params.id }, data })
    res.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      isAdmin: updated.isAdmin,
      active: updated.active,
      accessExpiresAt: updated.accessExpiresAt,
    })
  })
)

const resetPasswordSchema = z.object({
  password: senhaSchema.optional(), // se ausente, gera uma temporária
})

adminRouter.post(
  '/users/:id/reset-password',
  escritaSensivelLimiter,
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body)
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new ApiError(404, 'Usuário não encontrado')

    const newPassword = body.password ?? generateTempPassword()

    // Trocar a senha invalida as sessões antigas — mesmo motivo do
    // change-password do próprio usuário: um token roubado não deve
    // continuar valendo depois da troca.
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
    })

    res.json({
      id: updated.id,
      email: updated.email,
      // Só aparece nesta resposta, uma vez — mesmo padrão do POST /users.
      generatedPassword: body.password ? undefined : newPassword,
    })
  })
)
