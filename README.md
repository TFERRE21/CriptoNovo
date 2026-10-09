# CriptoNovo — BNB New Pairs Paper Trader

MVP de simulação para acompanhar novos pares na BNB Chain, aplicar filtros básicos e registrar operações virtuais. **Não envia transações e não precisa de chave privada.**

## Requisitos
- Node.js 20+
- RPC HTTP da BNB Chain (opcional, para descoberta on-chain por logs)
- API de dados de mercado (MVP usa DexScreener public API)

## Iniciar
```bash
npm install
cp .env.example .env
npm start
```
Abra http://localhost:3000.

## Segurança e limitações
- O projeto inicia sempre em paper trading.
- Não existe código de compra/venda real nem suporte a chave privada.
- A disponibilidade de tokens e os dados de terceiros podem atrasar ou falhar.
- Filtros automatizados reduzem alguns riscos, mas não provam que um token seja seguro.
- O preço de tela não garante execução ao preço modelado; simulação de impacto é apenas aproximada.
- A meta de +5% considera taxas e slippage estimados configurados, não um retorno garantido.

## MVP
- Polling de pares recentes da BNB Chain usando DexScreener.
- Filtros configuráveis de liquidez e idade.
- Candidatos registrados como aprovados/rejeitados com motivos.
- Entrada virtual simulada e alvo líquido de 5%.
- Estado e histórico gravados em JSON local.
- Dashboard básico com botão de iniciar/parar o monitoramento.

## Próximas melhorias recomendadas
- Indexação de eventos on-chain por WebSocket/RPC, com reconexão e deduplicação.
- GoPlus/Honeypot checks com limites de requisição e tratamento de falhas.
- Persistência PostgreSQL, autenticação e métricas para serviço 24/7.
- Backtest e comparação do preço estimado com cotações executáveis.
