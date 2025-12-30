# YNAB SMS Ingestion (Supabase Edge)

Automatically captures transaction SMS messages from Zambian banks and mobile money services, then imports them into YNAB (You Need A Budget).

## How it works

1. **iOS Shortcut** triggers when you receive an SMS containing `ZMW`.
2. The Shortcut sends the SMS to your **Supabase Edge Function**.
3. The Edge Function **parses** the SMS, extracts transaction data, and **posts to YNAB**.
4. YNAB shows the transaction for your review and categorization.

## Features

- ✅ Automatic amount extraction (e.g., "ZMW 100.00")
- ✅ Smart direction detection (inflow vs outflow based on keywords)
- ✅ Multi-account routing based on SMS sender
- ✅ Account-ending hints (e.g., "ending 1234" → routes to specific account)
- ✅ Airtime auto-categorization and payee assignment
- ✅ Deduplication via deterministic import IDs
- ✅ Balance-only message filtering
- ✅ Spam/ad message filtering (betting promos, ads with currency amounts, etc.)
- ✅ Manual approval for safety

## Supported banks/services

Out of the box, this project supports:

- **Airtel Money** (sender: `AirtelMoney`)
- **MTN MoMo** (sender: `MoMo`)
- **Zamtel Money** (sender: `115`)
- **ABSA Bank** (sender: `Absa`, `ABSA_ZM`)
- **Standard Chartered** (sender: `StanChart`, `StanChartZM`)

You can easily add more by editing `config.ts`.

## Repository layout

```
supabase/
├── functions/
│   ├── sms-webhook/
│   │   ├── index.ts          # Main webhook handler
│   │   └── deno.json         # Deno config
│   └── _shared/
│       ├── config.ts         # ⚙️ Sender/category mappings (edit this!)
│       ├── parsers.ts        # SMS parsing logic
│       ├── routing.ts        # Account routing logic
│       ├── ynab.ts           # YNAB API client
│       └── ynab-lookup.ts    # Name→ID resolution (automatic!)
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

### 3. Get your YNAB credentials

1. Create a YNAB personal access token: **YNAB → Settings → Developer Settings → New Token**
2. Find your budget ID in the YNAB web app URL:
   ```
   https://app.ynab.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/budget
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        This is your budget ID
   ```

### 4. Set secrets in Supabase

```bash
# Generate a random webhook secret
openssl rand -base64 32

# Set all secrets (only 3 required!)
supabase secrets set WEBHOOK_SECRET=<your-random-secret>
supabase secrets set YNAB_TOKEN=<your-ynab-token>
supabase secrets set YNAB_BUDGET_ID=<your-budget-id>
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

All mappings are in `supabase/functions/_shared/config.ts`. **Use NAMES, not IDs!**

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

### Adding category rules

```typescript
export const CATEGORY_RULES: Array<{ pattern: RegExp; categoryName: string }> = [
	{ pattern: /\bairtime|top[- ]?up\b/i, categoryName: "Airtime" },
	{ pattern: /\bfuel|petrol\b/i, categoryName: "Transport" },
];
```

### Spam/ad filtering

Promotional messages are filtered out, even if they contain currency amounts (e.g., "WIN ZMW 5,000!").

**Smart filtering:** A message is only considered spam if it has spam indicators AND **does NOT** contain real transaction verbs (sent, received, credited, debited, etc.). This prevents false positives.

| Message | Result |
|---------|--------|
| "WIN ZMW 5,000! Join today → betting.co.zm" | ❌ Filtered (spam keywords + URL, no transaction verb) |
| "Your first deposit of ZMW 500 was credited" | ✅ Allowed (contains "credited" = real transaction) |

You can customize the spam filter in `config.ts`:

```typescript
export const SPAM_KEYWORDS = [
	"welcome bonus",
	"win big",
	"betting",
	"casino",
	// Add more keywords as needed...
];
```

## Environment variables

| Variable         | Description                            | Required |
| ---------------- | -------------------------------------- | -------- |
| `WEBHOOK_SECRET` | Random string to authenticate requests | Yes      |
| `YNAB_TOKEN`     | Your YNAB personal access token        | Yes      |
| `YNAB_BUDGET_ID` | The budget to post transactions to     | Yes      |

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
- [ ] Expand category rules (groceries, utilities, etc.)
- [ ] Handle transfers between accounts
- [ ] Auto-add fee transactions for mobile money
- [ ] Support other currency codes (not just ZMW)

## License

MIT
