# YNAB SMS Ingestion (Supabase Edge + Gemini AI)

Automatically captures transaction SMS messages from Zambian banks and mobile money services, then imports them into YNAB (You Need A Budget).

**Powered by Google Gemini AI** for intelligent SMS parsing — no brittle regex rules!

## How it works

1. **iOS Shortcut** triggers when you receive an SMS containing `ZMW`.
2. The Shortcut sends the SMS to your **Supabase Edge Function**.
3. **Gemini AI** analyzes the message to determine if it's a real transaction.
4. If it is, the function extracts amount, direction, payee, and category.
5. The transaction is **posted to YNAB** for your review.

## Why AI?

Traditional regex-based parsing has problems:

- ❌ Too strict → misses valid transactions with unusual formats
- ❌ Too loose → imports spam/promos that mention amounts ("WIN ZMW 5,000!")
- ❌ Breaks when banks change message formats

Gemini AI understands **context**:

- ✅ Knows "WIN ZMW 5,000!" is a promo, not a transaction
- ✅ Handles casual mentions of money in conversations
- ✅ Adapts to new message formats automatically
- ✅ Extracts payee names and suggests categories

## Features

- 🤖 **AI-powered parsing** — Gemini understands context, not just patterns
- 💰 **Smart amount extraction** — Gets transaction amount, not balance
- ↔️ **Direction detection** — Knows inflow vs outflow from context
- 👤 **Payee extraction** — Pulls names from messages automatically
- 🏷️ **Category suggestions** — AI suggests categories (Airtime, Groceries, etc.)
- 🏦 **Multi-account routing** — Routes by SMS sender or account ending
- 🔄 **Deduplication** — Same SMS won't create duplicate transactions
- ✋ **Manual approval** — Transactions need your approval in YNAB

## Supported banks/services

Out of the box, this project supports:

- **Airtel Money** (sender: `AirtelMoney`)
- **MTN MoMo** (sender: `MoMo`)
- **Zamtel Money** (sender: `115`)
- **ABSA Bank** (sender: `Absa`, `ABSA_ZM`)
- **Standard Chartered** (sender: `StanChart`, `StanChartZM`)

Add more by editing `config.ts`.

## Repository layout

```
supabase/
├── functions/
│   ├── sms-webhook/
│   │   ├── index.ts          # Main webhook handler
│   │   └── deno.json         # Deno config
│   └── _shared/
│       ├── gemini.ts         # 🤖 Gemini AI client (SMS parsing)
│       ├── config.ts         # ⚙️ Sender→account mappings (edit this!)
│       ├── parsers.ts        # Utility functions (date, import ID)
│       ├── routing.ts        # Account routing logic
│       ├── ynab.ts           # YNAB API client
│       └── ynab-lookup.ts    # Name→ID resolution
└── config.toml               # Supabase project config
```

## Quick start

### 1. Fork and clone

```bash
git clone <your-fork-url>
cd ynab-sms-solution
```

### 2. Set up Supabase

1. Create a [Supabase](https://supabase.com) project
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli)
3. Link your project: `supabase link --project-ref <your-project-ref>`

### 3. Get your API keys

**YNAB:**
1. Create a YNAB personal access token: **YNAB → Settings → Developer Settings → New Token**
2. Find your budget ID in the YNAB web app URL:
   ```
   https://app.ynab.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/budget
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        This is your budget ID
   ```

**Gemini AI:**
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click **Create API Key**
3. Copy the key

### 4. Set secrets in Supabase

```bash
# Generate a random webhook secret
openssl rand -base64 32

# Set all secrets (4 required!)
supabase secrets set WEBHOOK_SECRET=<your-random-secret>
supabase secrets set YNAB_TOKEN=<your-ynab-token>
supabase secrets set YNAB_BUDGET_ID=<your-budget-id>
supabase secrets set GEMINI_API_KEY=<your-gemini-key>
```

### 5. Configure sender mappings

Edit `supabase/functions/_shared/config.ts` to map SMS senders to your YNAB account **names**:

```typescript
export const SENDER_TO_ACCOUNT: Record<string, string> = {
  airtelmoney: "Airtel Money", // ← Use YOUR YNAB account name
  momo: "MTN MoMo",
  absa: "My Bank Account", // ← Whatever you named it in YNAB
};
```

**NOTE:** Use the exact account names from YNAB.

### 6. Deploy

```bash
supabase functions deploy sms-webhook --no-verify-jwt
```

### 7. Configure iOS Automation

See [iOS Setup](#ios-setup) below.

## iOS Setup

This project uses an iOS Shortcut Automation to capture SMS messages and send them to Supabase.

### Step 1: Create the Shortcut Automation

1. Open the **Shortcuts** app
2. Go to the **Automation** tab
3. Tap **New Automation** (or **+**)
4. Scroll down and select **Message**
5. Choose **Message Contains** and enter: `ZMW`
6. Enable **Run Immediately** (so it doesn't ask for confirmation)
7. Tap **Next**
8. Tap **Create New Shortcut**

### Step 2: Add the HTTP action

1. Tap **Search Actions**
2. Search for **"URL"** and select **URL**
3. In the URL field, enter your Supabase function URL:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/sms-webhook
   ```
4. Search for **"Get Contents"** and select **Get Contents of URL**

### Step 3: Configure the HTTP request

1. Tap **Show More** (or the arrow) on the "Get Contents of URL" action
2. Change **Method** to **POST**
3. Tap **Add new header** and add:
   - Key: `Content-Type`
   - Value: `application/json`
4. Tap **Add new header** again:
   - Key: `x-webhook-secret`
   - Value: `<your-webhook-secret>`

### Step 4: Build the JSON body (THIS IS THE KEY STEP!)

1. Under **Request Body**, set it to **JSON**
2. Add these 4 keys:

**Key 1: source**

- Tap **Add new field**
- Key: `source`
- Type: **Text**
- Value: `ios_shortcuts_sms`

**Key 2: sender**

- Tap **Add new field**
- Key: `sender`
- Type: **Text**
- For the value, tap and select **Shortcut Input** → then tap it again → select **Sender**

**Key 3: receivedAt**

- Tap **Add new field**
- Key: `receivedAt`
- Type: **Text**
- For the value, tap and select **Current Date**

**Key 4: text**

- Tap **Add new field**
- Key: `text`
- Type: **Text**
- For the value, tap and select **Shortcut Input** → then tap it again → select **Content**

### Step 5: Finish the automation

1. Tap **Done** at the top right
2. The automation is now active!

## Local development

Requires Docker Desktop.

```bash
# Create local env file
echo "WEBHOOK_SECRET=test-secret" > supabase/.env.local
echo "YNAB_TOKEN=your-token" >> supabase/.env.local
echo "YNAB_BUDGET_ID=your-budget-id" >> supabase/.env.local
echo "GEMINI_API_KEY=your-gemini-key" >> supabase/.env.local

# Start the function
supabase functions serve sms-webhook --no-verify-jwt --env-file supabase/.env.local
```

## Payload format

```json
POST /functions/v1/sms-webhook
Content-Type: application/json
x-webhook-secret: <your-secret>

{
  "source": "ios_shortcuts_sms",
  "sender": "AirtelMoney",
  "receivedAt": "12/24/25, 14:30",
  "text": "Money sent to John Doe. Amount ZMW 100.00. Your bal is ZMW 500.00."
}
```

## Configuration

Account routing is in `supabase/functions/_shared/config.ts`. **Use NAMES, not IDs!**

### Mapping SMS senders to accounts

```typescript
export const SENDER_TO_ACCOUNT: Record<string, string> = {
  airtelmoney: "Airtel Money", // SMS sender → YNAB account NAME
  momo: "MTN MoMo",
  absa: "ABSA Current",
};
```

### Adding account-ending hints

Some banks include "account ending XXXX" in SMS:

```typescript
export const ACCOUNT_ENDING_HINTS: Record<string, string> = {
  "1234": "My Savings", // "ending 1234" → YNAB account NAME
  "5678": "My Current",
};
```

## How AI parsing works

When an SMS arrives, it's sent to Gemini with a prompt that asks:

1. **Is this a real transaction?** (not a promo, balance check, or conversation)
2. **What's the amount?** (the transaction amount, not balance)
3. **What direction?** (inflow = received, outflow = sent/paid)
4. **Who's the payee?** (extracted from message if mentioned)
5. **What category?** (Airtime, Groceries, Transfer, etc.)
6. **Write a clean memo** (human-friendly description for YNAB)

The AI returns structured JSON that we use to create the YNAB transaction.

### AI-generated memos

Instead of dumping the raw SMS into YNAB, the AI writes detailed but organized memos:

| Raw SMS | AI Memo |
|---------|---------|
| "ZMW 5.00 received from Harry Banda NFS on 30/12/2025 at 11:42 AM. New ZamPay balance is ZMW 23.98. 001271716055 completed. Buy Airtime..." | "Received from Harry Banda via Zamtel \| Ref: 001271716055 \| Bal: ZMW 23.98" |
| "Your ZMW 10.00 airtime top-up is successful. Your new Airtel Money balance is ZMW 100.00. Txn ID: RC251230..." | "Airtime top-up \| Txn: RC251230... \| Bal: ZMW 100.00" |
| "Money sent to John Doe on 123456789. Amount ZMW 50.00. Your bal is ZMW 500.00. TID: PP251230..." | "Sent to John Doe \| TID: PP251230... \| Bal: ZMW 500.00" |

Key details (ref numbers, balances) are preserved, but promo text is stripped out.

### Example AI responses

**Real transaction:**
```json
{
  "is_transaction": true,
  "reason": "Money transfer to another person",
  "amount": 100.00,
  "direction": "outflow",
  "payee": "John Doe",
  "category_hint": "Transfer"
}
```

**Promotional message:**
```json
{
  "is_transaction": false,
  "reason": "This is a promotional message about winning money, not an actual transaction",
  "amount": null,
  "direction": null,
  "payee": null,
  "category_hint": null
}
```

### Debugging

All AI responses are logged in Supabase function logs. Check `ai_parsed` and `ai_raw` fields to see what the AI extracted.

## Environment variables

| Variable         | Description                            | Required |
| ---------------- | -------------------------------------- | -------- |
| `WEBHOOK_SECRET` | Random string to authenticate requests | Yes      |
| `YNAB_TOKEN`     | Your YNAB personal access token        | Yes      |
| `YNAB_BUDGET_ID` | The budget to post transactions to     | Yes      |
| `GEMINI_API_KEY` | Google Gemini API key                  | Yes      |

## Gemini free tier

All Gemini models have **free tiers** with input & output free of charge!

| Model | Description | Free Tier |
|-------|-------------|-----------|
| `gemini-3-flash-preview` | Most intelligent, built for speed (default) | ✅ Free |
| `gemini-2.5-flash` | Hybrid reasoning, stable fallback | ✅ Free |
| `gemini-2.5-pro` | Most capable, complex reasoning | ✅ Free |

To change models, edit `gemini.ts`:
```typescript
const GEMINI_MODEL = "gemini-2.5-pro"; // or any model above
```

For personal use, you'll never hit the free tier limits!

## How name-based lookup works

Instead of hardcoding UUIDs that break when you recreate accounts:

1. On first request, we fetch all accounts and categories from YNAB API
2. Results are cached in memory (5 minute TTL)
3. When routing, we look up account/category by NAME
4. If a name isn't found in YNAB, we log a warning

This means:

- ✅ No UUIDs in your config
- ✅ Rename accounts in YNAB? Just update config.ts with new names
- ✅ Delete and recreate accounts? They auto-resolve by name
- ⚠️ First request after cold start is slightly slower (API call)

## Customization ideas

- [ ] Add more sender mappings for your banks
- [ ] Train the AI prompt for your specific message formats
- [ ] Handle transfers between accounts
- [ ] Auto-add fee transactions for mobile money
- [ ] Support other currency codes (not just ZMW)

## License

MIT
