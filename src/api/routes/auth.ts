// ============================================================
// api/routes/auth.ts — Login e troca de senha
// (criação de usuário é feita pelo admin — ver routes/admin.ts)
// ============================================================

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../services/tenderService'
import {
  hashPassword,
  normalizeEmail,
  signSessionToken,
  verifyPasswordConstantTime,
} from '../../services/authService'
import { senhaSchema } from '../passwordPolicy'
import { asyncHandler, ApiError } from '../asyncHandler'
import { requireAuth } from '../authMiddleware'
import { loginLimiter, changePasswordLimiter } from '../rateLimit'

export const authRouter = Router()

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.parse(req.body)
    const email = normalizeEmail(parsed.email)
    const { password } = parsed

    const user = await prisma.user.findUnique({ where: { email } })
    // Mesma mensagem de erro pra e-mail inexistente, conta sem senha e senha
    // errada — e sempre pagando o custo de um bcrypt.compare (mesmo sem hash
    // real), pra que nem a mensagem nem o tempo de resposta revelem quais
    // e-mails têm conta. Ver verifyPasswordConstantTime.
    const invalid = () => new ApiError(401, 'E-mail ou senha inválidos')

    const senhaConfere = await verifyPasswordConstantTime(
      password,
      user && user.active ? user.passwordHash : null
    )
    if (!user || !user.active || !senhaConfere) throw invalid()
    if (user.accessExpiresAt && user.accessExpiresAt.getTime() < Date.now()) {
      throw new ApiError(403, 'O acesso desta conta expirou — fale com o administrador')
    }

    const token = signSessionToken(user.id, user.tokenVersion)
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin },
    })
  })
)

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: senhaSchema,
})

authRouter.post(
  '/change-password',
  requireAuth,
  changePasswordLimiter,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body)

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } })
    if (!(await verifyPasswordConstantTime(currentPassword, user.passwordHash))) {
      throw new ApiError(401, 'Senha atual incorreta')
    }

    // Trocar a senha invalida as sessões antigas — senão um token roubado
    // continuaria valendo por até 30 dias mesmo depois da troca.
    const atualizado = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
    })

    res.json({ token: signSessionToken(atualizado.id, atualizado.tokenVersion) })
  })
)

// Logout de verdade: incrementa o tokenVersion, o que invalida no servidor
// TODOS os tokens já emitidos para esta conta (o authMiddleware confere o
// tokenVersion do token contra o do banco). Sem isto, "sair" só apagava o
// token do navegador e um token copiado antes seguia valendo até expirar.
authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.user.update({
      where: { id: req.userId! },
      data: { tokenVersion: { increment: 1 } },
    })
    res.status(204).end()
  })
)

// Retorna os dados do usuário autenticado (pra revalidar a sessão salva no
// navegador ao carregar a página, sem precisar logar de novo).
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } })
    res.json({ id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin })
  })
)
