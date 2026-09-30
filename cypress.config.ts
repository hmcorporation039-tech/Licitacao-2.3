import { defineConfig } from 'cypress'

// Mesma normalização de src/lib/geoService.ts (minúsculas, sem acento) —
// duplicada aqui de propósito: esse arquivo roda dentro do processo de
// plugins do Cypress, com seu próprio ts-node embutido, que não compila o
// TS do projeto principal (tem tsconfig/contexto diferente) — então
// evitamos importar código-fonte do projeto aqui, só o @prisma/client
// (que já vem pronto em JS).
function normalize(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3333',
    supportFile: false,
    specPattern: 'cypress/e2e/**/*.cy.ts',
    setupNodeEvents(on) {
      on('task', {
        // Insere uma licitação fixa e determinística pra teste — não dá pra
        // confiar em "provavelmente algo publicado recentemente tem
        // 'notebook' no objeto" (foi exatamente essa suposição que quebrou
        // o suite quando o banco foi trocado e ficou vazio no início).
        async seedFixtureTenders() {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { PrismaClient } = require('@prisma/client')
          const prisma = new PrismaClient()

          // "notebook" no singular, de propósito — o matcher usa casamento
          // literal com borda de palavra (\bnotebook\b não bate dentro de
          // "notebooks"), então o texto do fixture precisa ter exatamente
          // a mesma palavra que os testes usam como keyword.
          const objeto = 'Aquisição de equipamento notebook para uso administrativo — licitação fixture de teste (Cypress)'

          // Só a modalidade DISPENSA_SEM_DISPUTA — de propósito. O teste de
          // "não encontra o match quando a modalidade não bate" depende de
          // NÃO existir nenhuma licitação "notebook" em modalidade CONCURSO
          // (nem fixture nem real — CONCURSO no sentido da Lei 14.133 é
          // concurso de ideias/projeto, não costuma ser usado pra comprar
          // notebook, então o risco residual de colisão é bem baixo).
          await prisma.tender.upsert({
            where: { fonteId: 'CYPRESS-FIXTURE-NOTEBOOK-DISPENSA' },
            update: { objeto, objetoNorm: normalize(objeto), modalidade: 'DISPENSA_SEM_DISPUTA' },
            create: {
              fonte: 'PNCP',
              fonteId: 'CYPRESS-FIXTURE-NOTEBOOK-DISPENSA',
              modalidade: 'DISPENSA_SEM_DISPUTA',
              objeto,
              objetoNorm: normalize(objeto),
              uf: 'DF',
              municipio: 'Brasília',
              orgao: 'ÓRGÃO DE TESTE CYPRESS',
              orgaoCnpj: '00000000000000',
              publicadoAt: new Date(),
              rawJson: { fixture: true },
            },
          })

          // Licitações de enchimento, só pra paginação. O teste de paginação
          // pede uma página cheia de 5 itens, e com um fixture só ele passava
          // por acidente — apenas quando o banco já tinha coleta real dentro.
          // Nenhuma contém "notebook", então não interferem no matching.
          const enchimento = [
            'Contratação de serviço de manutenção predial',
            'Registro de preços para material de expediente',
            'Aquisição de gêneros alimentícios para merenda escolar',
            'Contratação de empresa para coleta de resíduos sólidos',
            'Serviço de vigilância patrimonial armada',
            'Locação de veículos para a frota municipal',
          ]

          for (const [i, texto] of enchimento.entries()) {
            const objetoEnchimento = `${texto} — fixture de paginação (Cypress)`
            await prisma.tender.upsert({
              where: { fonteId: `CYPRESS-FIXTURE-PAGINACAO-${i}` },
              update: { objeto: objetoEnchimento, objetoNorm: normalize(objetoEnchimento) },
              create: {
                fonte: 'PNCP',
                fonteId: `CYPRESS-FIXTURE-PAGINACAO-${i}`,
                modalidade: 'PREGAO_ELETRONICO',
                objeto: objetoEnchimento,
                objetoNorm: normalize(objetoEnchimento),
                uf: 'SP',
                municipio: 'São Paulo',
                orgao: 'ÓRGÃO DE TESTE CYPRESS',
                orgaoCnpj: '00000000000000',
                publicadoAt: new Date(Date.now() - (i + 1) * 60_000),
                rawJson: { fixture: true },
              },
            })
          }

          await prisma.$disconnect()
          return null
        },
      })
    },
  },
  env: {
    // Admin DEDICADO aos testes (não é a conta real do administrador). As
    // credenciais vêm do ambiente (CYPRESS_ADMIN_EMAIL / CYPRESS_ADMIN_PASSWORD);
    // o valor abaixo é só um fallback para rodar localmente e NUNCA deve existir
    // como conta em produção. Crie a conta de teste só no banco de teste:
    //   ADMIN_PASSWORD=<senha> npx ts-node scripts/createAdmin.ts cypress-admin@example.com "Cypress Admin"
    ADMIN_EMAIL: process.env.CYPRESS_ADMIN_EMAIL ?? 'cypress-admin@example.com',
    ADMIN_PASSWORD: process.env.CYPRESS_ADMIN_PASSWORD ?? 'CypressAdminLocal#2026',
  },
})
