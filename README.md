# Plataforma de Monitoramento de Licitações

Monitora licitações vigentes do **PNCP**, **ComprasNet**, **NOVACAP**, **FIEG**, **SESC GO** e **SEST SENAT** por itens previamente cadastrados, cruza com um cofre de documentos da empresa, analisa editais por IA e organiza um plano de participação por licitação.

Versão **2.3**: toda conta pertence a uma **empresa** (multiusuário, com dono e membros). Itens monitorados, matches, cofre de documentos, checklists e planos são da empresa e ficam compartilhados entre os membros.

---

## Pré-requisitos

- Node.js 20+
- Conta no [Railway](https://railway.app) (banco PostgreSQL + hospedagem da API/workers)
- Conta no [Upstash](https://upstash.com) (Redis gerenciado, usado pelas filas do BullMQ)
- VS Code com extensão **Prisma** instalada

---

## 1. Clonar / abrir o projeto no VS Code

```bash
git clone <seu-repo>
cd licitacao-platform
code .
```

---

## 2. Instalar dependências

```bash
npm install
```

---

## 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` e preencha:

| Variável | Onde obter |
|---|---|
| `DATABASE_URL` | Railway → serviço Postgres → aba Variables → `DATABASE_URL` (use o endpoint com TCP proxy pra acessar de fora do Railway) |
| `REDIS_URL` | Dashboard Upstash → seu banco → `rediss://...` |
| `JWT_SECRET` | Gere com `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `RESEND_API_KEY` | [resend.com](https://resend.com) — opcional, sem ela os e-mails só ficam registrados sem enviar |
| `CORS_ORIGINS` | Origens do frontend separadas por vírgula. **Obrigatória em produção** — vazia lá, nenhum navegador é aceito |
| `AI_ANALYSIS_ENABLED` | `"false"` (padrão) desliga a análise por IA por completo: **nenhuma chamada de API, nenhum crédito gasto** |
| `AI_PROVIDER` | `"claude"` ou `"gemini"` — controla qual IA analisa os editais |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) — necessária se `AI_PROVIDER="claude"` |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — gratuita, necessária se `AI_PROVIDER="gemini"` |

---

## 4. Configurar o banco de dados

```bash
npm run db:generate       # gera o Prisma Client
npm run db:migrate:deploy # aplica as migrations (cria as tabelas)
```

> **Migrando um banco que já existe (v1.0):** leia o [`MIGRACAO.md`](MIGRACAO.md)
> antes. O banco de produção precisa de um `prisma migrate resolve --applied`
> uma única vez, senão o deploy tenta recriar tabelas que já existem.
>
> `prisma db push` não é mais parte do fluxo (ficou como `db:push:danger`): era
> ele que deixava o histórico de migrations defasado em 5 tabelas.

---

## 5. Criar o primeiro usuário administrador

Não existe autocadastro aberto — o primeiro admin é criado direto no banco, e ele cria os demais usuários pela tela "Usuários" (ou via `POST /api/admin/users`). A senha vai por variável de ambiente, para não ficar no histórico do terminal, e precisa ter de 10 a 72 caracteres:

```bash
ADMIN_PASSWORD="sua-senha-com-10+caracteres" npx ts-node scripts/createAdmin.ts seu-email@empresa.com "Seu Nome"
```

O mesmo comando redefine a senha de um admin que já existe (o e-mail é normalizado para minúsculas). Para os demais usuários, use **Admin → Usuários → redefinir senha**, que gera uma senha temporária.

---

## 6. Rodar a API e os workers em desenvolvimento

```bash
npm run dev:api       # API REST em http://localhost:3333
npm run dev:workers   # coletores PNCP/ComprasNet + matcher + rotinas periódicas
```

Em outro terminal, o frontend:

```bash
cd web
npm install
npm run dev            # http://localhost:3000
```

---

## 7. Rodar os testes

```bash
npm run verify   # typecheck + lint + testes unitários
```

Os testes unitários (Vitest) cobrem só função pura — matcher, parsers, geo, hash,
escape de HTML. **Não tocam banco, rede nem API de IA**, então rodam offline e não
gastam crédito nenhum. É a mesma coisa que o CI roda, sem nenhum segredo configurado.

```bash
npm run test         # só os unitários
npm run test:watch   # em modo watch
```

E os de ponta a ponta, que precisam de banco e da API no ar:

```bash
npm run test:e2e
```

Usa o admin criado no passo 5 (configure `CYPRESS_ADMIN_EMAIL`/`CYPRESS_ADMIN_PASSWORD` se usar credenciais diferentes das do `cypress.config.ts`) pra criar usuários de teste via `/api/admin/users`.

---

## Scripts úteis

| Comando | O que faz |
|---|---|
| `npm run build` | Compila TS → `dist/` (usado em produção) |
| `npm run start:api` / `npm run start:workers` | Roda a versão compilada (produção) |
| `npm run matches:rebuild` | Recalcula todos os matches do zero |
| `npm run situacoes:refresh` | Reconsulta a situação real das licitações no PNCP |
| `npm run tenders:cleanup` | Remove licitações encerradas/antigas que ninguém acompanha (retenção) |
| `npm run rawjson:enxugar` | Backfill: reescreve o `raw_json` das licitações já coletadas, guardando só o que é lido |
| `npm run tenders:backfill-norm` | Preenche colunas normalizadas pra busca sem acento |
| `npm run documentos:check-expirations` | Dispara avisos de documento vencendo |
| `npm run empresas:backfill` | Cria uma empresa por usuário sem empresa e propaga `company_id` (usado entre as migrations 0004/0006 e 0005/0007) |
| `npm run clientes:importar-v22` | Copia os clientes de um banco da V2.2 para o banco da 2.3 (ver seção abaixo) |

> `tenders:cleanup` e `rawjson:enxugar` apagam/reescrevem dados. Quando a
> `DATABASE_URL` não é local, os dois param e pedem que você digite o host do
> banco antes de seguir — a `DATABASE_URL` de desenvolvimento costuma apontar
> para produção neste projeto. Use `-- --sim` para pular a pergunta em
> automação (sem terminal interativo, sem a flag, eles abortam).

---

## Estrutura do projeto

```
licitacao-platform/
├── prisma/schema.prisma        ← Schema do banco
├── scripts/                    ← Scripts operacionais (rodados sob demanda)
├── src/
│   ├── api/
│   │   ├── routes/              ← auth, admin, company, tenders, monitored-items, matches, company-documents, participation-plans, dashboard, uasg
│   │   └── authMiddleware.ts    ← requireAuth / requireAdmin
│   ├── lib/                     ← geoService, checklistTemplate, participationPlanTemplate
│   ├── queues/                  ← BullMQ + Redis
│   ├── services/
│   │   ├── llm/                 ← analisadores de edital (claude, gemini) por trás de AI_PROVIDER
│   │   ├── matcherService.ts    ← cruza licitação × item monitorado
│   │   ├── situacaoUpdateService.ts
│   │   ├── retentionService.ts
│   │   └── documentAlertService.ts
│   └── workers/                 ← coletores PNCP/ComprasNet, matcher, notificador, rotinas periódicas
├── web/                         ← Frontend Next.js
├── cypress/e2e/                 ← Testes de API de ponta a ponta
├── .env.example
└── package.json
```

---

## APIs utilizadas

| Fonte | URL base | Auth |
|---|---|---|
| PNCP | `https://pncp.gov.br/api/consulta` | Pública |
| ComprasNet | `https://dadosabertos.compras.gov.br` | Pública |
| CATMAT/CATSER | `https://compras.dados.gov.br` | Pública |
| NOVACAP | `https://app.novacap.df.gov.br` | Pública (HTML) |
| FIEG | `https://www.fieg.com.br/licitacao/site/` | Pública (HTML) |
| SESC GO | `https://www3.sescgo.com.br` | Pública (HTML) |
| SEST SENAT | `https://transparencia.sestsenat.org.br` | Pública |

---

## Documentos do projeto

| Arquivo | O que tem |
|---|---|
| [`PROGRESSO.md`](PROGRESSO.md) | Fases, status de cada item e o que ainda não foi iniciado |
| [`MIGRACAO.md`](MIGRACAO.md) | Runbook da migração v1.0 → v2.0, para executar contra produção |

---

## Produção

| Peça | Onde |
|---|---|
| API + workers | Railway, projeto `licitacoes-platform-clone` — `api-production-c6d4f.up.railway.app` (os dois serviços rodam a branch `main`; `SERVICE_ROLE` decide qual metade sobe) |
| Frontend | Vercel, projeto `licitacao-2-3` — `licitacao-2-3.vercel.app` (Root Directory `web`, preset Next.js, Node 22) |
| Banco | Railway Postgres 18 do mesmo projeto, ligado aos serviços por referência `${{Postgres.DATABASE_URL}}` |
| Filas | Redis do `REDIS_URL` dos serviços |

Configuração dos serviços de código no Railway:

| Campo | Valor |
|---|---|
| Pre-deploy Command | `npm run db:migrate:deploy` (só na API e nos workers, **nunca** no Postgres) |
| Healthcheck Path | `/api/health` |
| `CORS_ORIGINS` (API) | inclui `https://licitacao-2-3.vercel.app` |

### Migração dos clientes da V2.2 (03/10/2026)

Os clientes que usavam a V2.2 (banco próprio, sem empresas) foram copiados para o banco da 2.3 com `npm run clientes:importar-v22`. O script lê a origem em sessão somente leitura e grava no destino numa transação única; com `--dry` desfaz tudo no final. Pode rodar mais de uma vez: o que já existe no destino é ignorado.

```bash
ORIGEM_DATABASE_URL="postgresql://...v22" DESTINO_DATABASE_URL="postgresql://...v23" npm run clientes:importar-v22 -- --dry
ORIGEM_DATABASE_URL="postgresql://...v22" DESTINO_DATABASE_URL="postgresql://...v23" npm run clientes:importar-v22
```

O que ele faz:

- cria uma empresa própria por usuário e copia o usuário com o mesmo hash de senha (a senha não muda);
- copia itens monitorados, matches, checklists, planos, documentos e análises de IA;
- traz as licitações (e os itens delas) que faltarem no destino, casando pela chave `fonte_id`;
- ignora a conta de teste do Cypress e não copia notificações.

Antes de rodar contra produção, faça backup dos dois bancos (`pg_dump -Fc`, mesma versão major do servidor) e ensaie numa cópia local restaurada.

