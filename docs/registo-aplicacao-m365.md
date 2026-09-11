# Pedido de registo de aplicação — Microsoft 365 (Grupo Barraqueiro)

> **English abstract.** Request to Barraqueiro IT: create an app registration in the
> company's Microsoft Entra ID tenant for the Legal Assistant web application, with
> **delegated** permissions `Files.ReadWrite`, `User.Read` and `offline_access` only.
> `Mail.Send` is never requested — the application is deliberately unable to send email.
> Deliverables back to Naten: tenant ID, application (client) ID, and a client secret,
> via a secure channel.

## O que é preciso e porquê

O Assistente Jurídico (aplicação web desenvolvida pela Naten para o gabinete
Legal & Compliance) guarda a biblioteca de documentos **no OneDrive da própria conta do
utilizador do gabinete**, no tenant Microsoft 365 do Grupo Barraqueiro. Para a aplicação
poder ler essa pasta (e mais tarde converter Word→PDF), precisa de um **registo de
aplicação** no Entra ID do Grupo.

A aplicação atua **sempre em nome do utilizador que inicia sessão** (permissões
*delegated*, nunca *application*): só acede ao que esse utilizador já pode aceder.

## Passos (portal Azure / Entra admin center)

1. **Entra ID → App registrations → New registration**
   - Name: `Naten Legal Assistant`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI — platform **Web**, com estes dois URIs:
     - `https://barraqueiro-legal.naten.ai/api/msgraph/callback` (produção/testes)
     - `http://localhost:3000/api/msgraph/callback` (desenvolvimento)

2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**:
   - `Files.ReadWrite` — ler e escrever os ficheiros do OneDrive do utilizador com sessão
     iniciada (a biblioteca de documentos e, mais tarde, a conversão para PDF)
   - `User.Read` — identificar a conta com sessão iniciada (nome e email)
   - `offline_access` — manter a sessão sem pedir login constantemente
   - Se a política do tenant exigir admin consent, conceder **Grant admin consent**.

   > Nota: **não** é pedido `Mail.Send` — a aplicação não pode, por desenho, enviar
   > emails. (Numa fase posterior *poderá* ser pedido `Mail.ReadWrite`, apenas para criar
   > rascunhos no Outlook do utilizador; será um pedido separado e igualmente delegated.)

3. **Certificates & secrets → New client secret**
   - Descrição: `naten-legal-assistant`; expiração recomendada: 12–24 meses.
   - Copiar o **Value** do secret no momento da criação (não volta a ser mostrado).

## O que enviar à Naten (por canal seguro — nunca por email em claro)

- **Directory (tenant) ID**
- **Application (client) ID**
- **Client secret** (o *Value*)
- A data de expiração do secret (para agendarmos a renovação)

## O que acontece depois

A Naten introduz estes três valores nas definições da aplicação (ficam cifrados na base
de dados). O utilizador do gabinete inicia sessão com a sua própria conta Microsoft na
página de Settings e escolhe a pasta do OneDrive que serve de biblioteca. A partir daí a
aplicação sincroniza automaticamente as alterações dessa pasta (delta query — apenas
diferenças, sem download em massa).
