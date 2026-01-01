-- ═══════════════════════════════════════════════════════════════════════════
-- SMS CONTEXT TABLE — For correlating multi-SMS transactions (e.g., ABSA)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Some banks send multiple SMS for a single transaction:
-- - SMS1: "ZMW 5,000 debited from account" (has amount, no recipient type)
-- - SMS2: "ZECHL payment to 260770..." (has phone number, no amount)
--
-- This table stores recent transaction context so we can:
-- 1. Correlate follow-up SMS with the original transaction
-- 2. Update the transaction with additional details (like transfer type fees)
--
-- Records are auto-deleted after 1 hour (no long-term storage needed).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sms_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- SMS metadata
    sender TEXT NOT NULL,              -- SMS sender (e.g., "Absa", "AirtelMoney")
    sms_text TEXT NOT NULL,            -- Full SMS text
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Transaction details (from AI parsing)
    amount DECIMAL(15, 2),             -- Transaction amount (null if not extracted)
    direction TEXT,                     -- "inflow" or "outflow"
    account_ending TEXT,               -- Last 4 digits of account (e.g., "4983")
    
    -- YNAB transaction reference
    ynab_transaction_id TEXT,          -- YNAB transaction ID (for updates)
    ynab_account_id TEXT,              -- YNAB account ID
    import_id TEXT,                    -- Our import_id for deduplication
    
    -- Correlation status
    is_primary BOOLEAN DEFAULT TRUE,   -- TRUE = main transaction, FALSE = follow-up
    correlated_with UUID REFERENCES sms_context(id), -- Link to primary SMS
    fee_applied BOOLEAN DEFAULT FALSE, -- Whether transfer-type fee was applied
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast correlation queries (find recent SMS from same sender)
CREATE INDEX idx_sms_context_sender_time ON sms_context (sender, received_at DESC);

-- Index for finding unprocessed primary transactions
CREATE INDEX idx_sms_context_primary ON sms_context (sender, is_primary, fee_applied, received_at DESC);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_sms_context_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sms_context_updated_at
    BEFORE UPDATE ON sms_context
    FOR EACH ROW
    EXECUTE FUNCTION update_sms_context_timestamp();

-- Auto-delete old records (older than 1 hour) — run via pg_cron or manually
-- This keeps the table small and only stores recent context
CREATE OR REPLACE FUNCTION cleanup_old_sms_context()
RETURNS void AS $$
BEGIN
    DELETE FROM sms_context WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Enable Row Level Security (RLS) for edge functions
ALTER TABLE sms_context ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role full access (edge functions use service role)
CREATE POLICY "Service role has full access" ON sms_context
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Comment on table
COMMENT ON TABLE sms_context IS 'Temporary storage for correlating multi-SMS transactions (e.g., ABSA sends 2 SMS per transaction)';

