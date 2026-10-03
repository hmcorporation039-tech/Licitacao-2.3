// ============================================================
// api/passwordPolicy.ts — Regra única de senha, usada em todos os pontos
// que definem/trocam senha (login-change, admin, empresa, createAdmin).
// ============================================================

import { z } from 'zod'

// bcrypt só considera os primeiros 72 bytes; acima disso os caracteres extras
// são ignorados silenciosamente, então limitamos o máximo para não dar a falsa
// impressão de que uma senha muito longa está inteira protegida.
export const SENHA_MIN = 10
export const SENHA_MAX = 72

export const senhaSchema = z
  .string()
  .min(SENHA_MIN, `A senha precisa ter pelo menos ${SENHA_MIN} caracteres`)
  .max(SENHA_MAX, `A senha pode ter no máximo ${SENHA_MAX} caracteres`)
