# Deploy CriptoNovo na VPS com Docker

> Esta é uma aplicação experimental de simulação. Não envia ordens on-chain.

## 1. Preparar
No diretório do projeto na VPS:

```bash
cp .env.example .env
nano .env
```

Revise os parâmetros antes de iniciar. O painel é vinculado a `127.0.0.1:3000` no host, portanto não fica diretamente exposto à internet. Acesse por túnel SSH ou configure um proxy reverso com HTTPS e autenticação.

## 2. Iniciar
```bash
docker compose up -d --build
docker compose logs -f --tail=100
```

## 3. Verificar
```bash
curl http://127.0.0.1:3000/api/health
docker compose ps
```

## 4. Abrir o painel remotamente com túnel SSH
No seu computador, execute (substitua o host):

```bash
ssh -L 3000:127.0.0.1:3000 usuario@IP_DA_VPS
```

Depois abra `http://localhost:3000` no navegador.

## 5. Parar / atualizar
```bash
docker compose down
git pull
docker compose up -d --build
```

Os dados simulados ficam no volume Docker `criptonovo_data`. Não execute `docker compose down -v` a menos que queira apagar esse volume.
