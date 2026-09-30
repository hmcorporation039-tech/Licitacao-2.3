// ============================================================
// services/llm/claudeAnalyzer.ts — Analisa o edital com a API da Claude
// ============================================================

import Anthropic from '@anthropic-ai/sdk'
import {
  ANALYSIS_SCHEMA,
  AnalysisRefusedError,
  EditalAnalysisResult,
  EditalDocumento,
  SYSTEM_PROMPT,
  buildInstrucao,
  validarResultadoAnalise,
} from './types'

let anthropicClient: Anthropic | null = null
function getClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic()
  return anthropicClient
}

// Os tokens de raciocínio contam no mesmo teto da resposta — com 8000, um
// edital denso truncava o JSON no meio e a análise virava erro de parse.
const MAX_TOKENS = 32_000

export async function analyzeEdital(
  objeto: string,
  documentos: EditalDocumento[]
): Promise<EditalAnalysisResult> {
  const blocosDeDocumento: Anthropic.ContentBlockParam[] = documentos.map((doc) =>
    doc.tipo === 'pdf'
      ? {
          type: 'document',
          title: doc.nome,
          source: { type: 'base64', media_type: 'application/pdf', data: doc.data.toString('base64') },
        }
      : {
          type: 'document',
          title: doc.nome,
          source: { type: 'text', media_type: 'text/plain', data: doc.texto },
        }
  )

  // Streaming porque um edital de centenas de páginas com effort alto passa
  // do timeout HTTP padrão do SDK numa chamada não-streaming.
  const message = await getClient()
    .messages.stream({
      model: process.env.CLAUDE_ANALYSIS_MODEL || 'claude-opus-5',
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [...blocosDeDocumento, { type: 'text', text: buildInstrucao(objeto, documentos) }],
        },
      ],
    })
    .finalMessage()

  if (message.stop_reason === 'refusal') {
    throw new AnalysisRefusedError()
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('A resposta do modelo foi cortada antes de terminar — o edital é grande demais para uma análise única.')
  }

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Resposta do modelo não contém o resultado esperado')
  }

  return validarResultadoAnalise(JSON.parse(textBlock.text))
}
