# Mudança para as credenciais do Barraqueiro (procedimento de handover)

> **English abstract.** The switch from the development setup (Tomás's personal accounts)
> to the client's production accounts is pure configuration — no code changes: swap the
> Entra app registration values in Settings, sign in with the office's Microsoft account,
> pick the real OneDrive library folder, and reconnect ChatGPT with the definitive
> subscription.

Quando a app estiver validada e o IT do Barraqueiro tiver criado o registo de aplicação
(pedido em `docs/registo-aplicacao-m365.md` — enviar via Naten), a mudança é só
configuração:

## 1. Microsoft 365

1. Settings → **Microsoft 365** → *Disconnect account* (remove a conta de desenvolvimento).
2. Substituir **Tenant ID / Client ID / Client secret** pelos valores do registo criado no
   tenant do Barraqueiro → *Save registration*. (Os valores ficam cifrados na base de
   dados; o secret nunca é mostrado de volta.)
3. **Sign in with Microsoft** com a conta do utilizador do gabinete Legal & Compliance.
4. **Pick the library folder** → escolher a pasta real da biblioteca no OneDrive dele.
   A troca de pasta reinicia o cursor de sincronização; a primeira sincronização enumera
   a biblioteca completa e o processamento (extração/OCR/classificação) corre documento a
   documento — cada página é paga uma única vez, para sempre.

## 2. ChatGPT

Settings → **ChatGPT connection** → *Disconnect* → *Connect ChatGPT* com a conta/
subscrição definitiva (o fluxo por código de dispositivo funciona de qualquer browser).
A faturação é sempre limitada pela subscrição — não existe chave de API configurada.

## 3. Dados de desenvolvimento

As análises e documentos de teste continuam na base de dados. Para arrancar limpo:
parar o container, apagar o volume `barraqueiro-legal_data`, subir de novo (o bootstrap
admin é recriado a partir do `.env` do servidor) e refazer os passos 1–2. O backup
noturno (`backup.sh`, 03:30, mantém 14) cobre ambos os cenários.

## 4. O que NÃO muda

Código, templates, regras de validação, portas do Caddy, DNS — nada. A app foi construída
para que esta troca fosse um não-evento.
