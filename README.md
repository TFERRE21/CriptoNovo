# CriptoNovo — BNB New Pairs Paper Trader

MVP de simulação para monitorar pares encontrados pela API pública do DexScreener, aplicar filtros básicos e abrir/encerrar posições virtuais. **Não envia transações e não usa carteira ou chave privada.**

## Requisitos e execução
- Node.js 20+
- `npm install`
- `cp .env.example .env`
- `npm start`
- Acesse `http://localhost:3000`

## Segurança e limitações
- O serviço inicia parado e exige clicar em **Iniciar simulação**.
- A descoberta atual usa busca pública por WBNB no DexScreener; isso **não é um feed completo nem garante detectar todos os pares novos imediatamente**.
- Os filtros nesta versão cobrem dados básicos, idade e liquidez. Eles não auditam o contrato e não provam que a venda é possível.
- Compras e vendas são virtuais. O preço de tela, impacto de preço, slippage e taxas reais podem diferir.
- O alvo líquido de 5% é calculado usando um custo de ida e volta estimado, configurável por ambiente; não é um retorno garantido.
- Esta versão é um protótipo, não deixe exposto publicamente sem autenticação.

## Configuração
As variáveis ficam em `.env.example`: capital simulado, tamanho de posição, liquidez mínima, idade máxima, custo estimado, alvo líquido, tempo máximo e limite de posições simultâneas.

## Próximas melhorias antes de confiar no resultado
- Feed de criação de pools via eventos on-chain/WebSocket e RPC confiável.
- Integração GoPlus/Honeypot para sinais de risco, com tratamento explícito de falhas.
- Persistência robusta (PostgreSQL), autenticação e monitoramento do processo.
- Simulação de slippage por profundidade do pool e testes comparativos de execução.


## Teste de atualização automática

Marcador de teste: `DEPLOY-WEBHOOK-TEST-2026-10-09`.

Este texto foi atualizado para verificar se um `push` na branch `main` aciona o webhook do painel de hospedagem. Após o commit, confira os logs do container e confirme que o deploy foi iniciado. A indicação de webhook ativo, por si só, não comprova que a imagem foi reconstruída e o container reiniciado.
