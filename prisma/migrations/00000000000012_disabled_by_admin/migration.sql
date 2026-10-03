-- Aditivo puro: coluna nova com default, nenhum dado existente é tocado.
-- Marca contas desativadas pelo admin da plataforma, para que o dono da
-- empresa não consiga reativá-las (ver api/routes/company.ts e admin.ts).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "disabled_by_admin" BOOLEAN NOT NULL DEFAULT false;
