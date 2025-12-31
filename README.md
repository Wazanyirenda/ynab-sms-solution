# YNAB SMS Ingestion (Supabase Edge + Gemini AI)

Automatically captures transaction SMS messages from Zambian banks and mobile money services, then imports them into YNAB (You Need A Budget).

**Powered by Google Gemini AI** for intelligent SMS parsing — no brittle regex rules!

## How it works

1. **iOS Shortcut** triggers when you receive an SMS **starting with "ZMW"**.
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
- 👤 **Smart payee matching** — Matches existing YNAB payees only (never creates new ones)
- 🏷️ **Smart category matching** — Matches against your actual YNAB categories
- 📝 **Clean memos** — AI generates detailed, organized memos
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
│       └── ynab-lookup.ts    # Account/Category/Payee lookup & caching
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

# Optional: Map account endings to YNAB accounts (keeps your account numbers private!)
# Useful when you have multiple accounts at the same bank (savings vs current)
supabase secrets set ACCOUNT_ENDINGS='{"4983":"Absa Current","0878":"Absa Savings","5300":"Stanchart Savings"}'
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
5. **Important:** Set the filter to **"Message Contains: ZMW"**
   - This ensures only transaction alerts are processed (not every text you receive!)
   - Reduces notification pop-ups and keeps Gemini API costs low
6. Enable **Run Immediately** (so it doesn't ask for confirmation)
7. Tap **Next**
8. Tap **Create New Shortcut**

> ⚠️ **Note:** Some transaction SMS may use "K" or "Kwacha" instead of "ZMW" and will be missed. For most users, filtering by "ZMW" captures the vast majority of transactions while avoiding unnecessary processing.

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

## Testing

### Quick test with the test script

The easiest way to test without triggering a real SMS:

```bash
# Set your webhook secret (one time)
export WEBHOOK_SECRET=your-secret-here

# Run the test script
./test-sms.sh
```

Then just paste any SMS message from your inbox and press Enter twice!

You can also pass the SMS directly:

```bash
./test-sms.sh "Money sent to John. Amount ZMW 100.00. Your bal is ZMW 500.00." "AirtelMoney"
```

### Quick test with curl

```bash
curl -X POST "https://<your-project>.supabase.co/functions/v1/sms-webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-secret" \
  -d '{
    "source": "test",
    "sender": "AirtelMoney",
    "receivedAt": "Dec 30, 2025 at 12:00",
    "text": "Money sent to John. Amount ZMW 100.00. Your bal is ZMW 500.00."
  }'
```

Check the function logs in [Supabase Dashboard](https://supabase.com/dashboard) → Edge Functions → sms-webhook → Logs.

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

Some banks include "account ending XXXX" in SMS. This is configured via **Supabase secrets** (not in code) so your account numbers stay private:

```bash
# Set your account endings (JSON format)
supabase secrets set ACCOUNT_ENDINGS='{"4983":"Absa Current","0878":"Absa Savings","5300":"Stanchart Savings","1500":"Stanchart Current"}'
```

For local development, add to `.env.local`:

```bash
ACCOUNT_ENDINGS={"4983":"Absa Current","0878":"Absa Savings"}
```

When an SMS contains "ending 4983", it will route to your "Absa Current" account instead of using the sender mapping.

## How AI parsing works

When an SMS arrives, it's sent to Gemini **with your actual YNAB data**:

1. **Your YNAB categories** — AI picks the best match or leaves blank
2. **Your YNAB payees** — AI fuzzy-matches or creates new

The AI analyzes the SMS and returns:

| Field | How AI handles it |
|-------|-------------------|
| Is transaction? | Understands context (not fooled by "WIN ZMW 5,000!") |
| Amount | Extracts transaction amount, not balance |
| Direction | Inflow (received) or outflow (sent/paid) |
| Payee | Fuzzy-matches existing payees or suggests new |
| Category | Matches your exact YNAB categories or null |
| Memo | Clean memo with time, ref IDs, and balance |

### Smart matching examples

| SMS Content | AI Payee Match | AI Category Match |
|-------------|----------------|-------------------|
| "Harry Banda" | → "H. Banda" (existing) | — |
| "shoprite" | → "Shoprite" (existing) | "🛒 Groceries" |
| "airtime top-up" | → blank (no match) | "🛜 Data / Airtime" |
| Unknown store | → blank (no match) | null (you categorize) |

**Note:** Payees are NEVER created automatically. If there's no match, the payee field stays blank and the extracted name appears in the memo for your reference.

### AI-generated memos

Instead of dumping the raw SMS into YNAB, the AI writes detailed but organized memos with **timestamps**:

- If the SMS contains a time (e.g., "at 14:30"), that time is used
- If no time is in the SMS, the **received time** from the iOS Shortcut is used as fallback

| Raw SMS | AI Memo |
|---------|---------|
| "ZMW 5.00 received from Harry Banda NFS on 30/12/2025 at 11:42 AM. New ZamPay balance is ZMW 23.98. 001271716055 completed. Buy Airtime..." | "Received from Harry Banda via Zamtel \| 11:42 AM \| Ref: 001271716055 \| Bal: ZMW 23.98" |
| "Your ZMW 10.00 airtime top-up is successful. Your new Airtel Money balance is ZMW 100.00. Txn ID: RC251230..." | "Airtime top-up \| Txn: RC251230... \| Bal: ZMW 100.00" |
| "Money sent to John Doe on 123456789 at 14:30. Amount ZMW 50.00. Your bal is ZMW 500.00. TID: PP251230..." | "Sent to John Doe \| 14:30 \| TID: PP251230... \| Bal: ZMW 500.00" |

Key details (time, ref numbers, balances) are preserved, but promo text is stripped out.

### Example AI responses

**Real transaction:**
```json
{
  "is_transaction": true,
  "reason": "Money transfer to another person",
  "amount": 100.00,
  "direction": "outflow",
  "payee": "John Doe",
  "is_new_payee": false,
  "category": "Transfer",
  "memo": "Sent to John Doe | 14:30 | Ref: PP251230.1234.A12345 | Bal: ZMW 500.00"
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
  "is_new_payee": false,
  "category": null,
  "memo": null
}
```

### Debugging

All AI responses are logged in Supabase function logs. Check `ai_parsed` and `ai_raw` fields to see what the AI extracted.

## Environment variables

| Variable           | Description                                        | Required |
| ------------------ | -------------------------------------------------- | -------- |
| `WEBHOOK_SECRET`   | Random string to authenticate requests             | Yes      |
| `YNAB_TOKEN`       | Your YNAB personal access token                    | Yes      |
| `YNAB_BUDGET_ID`   | The budget to post transactions to                 | Yes      |
| `GEMINI_API_KEY`   | Google Gemini API key                              | Yes      |
| `ACCOUNT_ENDINGS`  | JSON mapping of account endings → YNAB account names | No       |

## Gemini free tier

All Gemini models have **free tiers** with input & output free of charge!

| Model | Description | Free Tier |
|-------|-------------|-----------|
| `gemini-2.0-flash` | Fast, stable, reliable (default) | ✅ Free |
| `gemini-2.5-flash` | Hybrid reasoning, newer | ✅ Free |
| `gemini-2.5-pro` | Most capable, complex reasoning | ✅ Free |

To change models, edit `gemini.ts`:
```typescript
const GEMINI_MODEL = "gemini-2.5-flash"; // or any model above
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

## Future Improvements

### 🔥 High Priority

- [ ] **Payee Aliases** — Map common variations to existing payees (e.g., "Harry Banda" → "H. Banda")
- [ ] **Transaction Fees** — Extract and handle fees as split transactions or separate entries
- [ ] **Raw SMS Logging** — Store all SMS in Supabase for debugging and historical reference
- [ ] **Bank Email Analysis** — Parse transaction emails from banks (e.g., monthly statements, receipts) using AI

### 📊 Nice to Have

- [ ] **Balance Reconciliation** — Alert when SMS balance doesn't match YNAB account balance
- [ ] **Transaction Rules** — Auto-approve trusted recurring transactions
- [ ] **Daily Summary** — Push notification with spending summary and uncategorized items
- [ ] **Simple Dashboard** — Web UI showing recent transactions and AI parsing stats

### 🛡️ Reliability

- [ ] **Retry Logic** — Queue failed transactions for automatic retry with exponential backoff
- [ ] **Health Check Endpoint** — `/health` endpoint to verify YNAB, Gemini, and cache status

### 🧪 Developer Experience

- [ ] **Unit Tests** — Test AI parsing with known SMS examples
- [ ] **SMS Simulator** — CLI tool to test without real SMS messages
- [ ] **Multi-currency Support** — Handle USD and other currencies beyond ZMW

## License

MIT
