#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# SMS TESTING SCRIPT
# ═══════════════════════════════════════════════════════════════════════════
# Paste any SMS message to test the full pipeline without triggering a real SMS.
#
# Usage:
#   ./test-sms.sh                    # Interactive mode (prompts for input)
#   ./test-sms.sh "Your SMS here"    # Direct mode (pass SMS as argument)
#
# Requirements:
#   - Set WEBHOOK_SECRET and SUPABASE_URL below (or as environment variables)
#   - curl must be installed
# ═══════════════════════════════════════════════════════════════════════════

# ── CONFIGURATION ──────────────────────────────────────────────────────────
# Set these values OR export them as environment variables before running

SUPABASE_URL="${SUPABASE_URL:-https://ofhapfsiymomrohzrdir.supabase.co/functions/v1/sms-webhook}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"  # Set your webhook secret here or export it

# Default sender (you can change this per test)
DEFAULT_SENDER="TestSender"

# ── VALIDATION ─────────────────────────────────────────────────────────────

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "❌ Error: WEBHOOK_SECRET is not set!"
    echo ""
    echo "Set it by either:"
    echo "  1. Edit this script and add your secret on line 22"
    echo "  2. Export it: export WEBHOOK_SECRET=your-secret-here"
    echo ""
    exit 1
fi

# ── GET SMS TEXT ───────────────────────────────────────────────────────────

if [ -n "$1" ]; then
    # SMS passed as argument
    SMS_TEXT="$1"
    SENDER="${2:-$DEFAULT_SENDER}"
else
    # Interactive mode
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  📱 SMS TESTER — Paste your SMS message below"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    read -p "Sender (press Enter for '$DEFAULT_SENDER'): " SENDER
    SENDER="${SENDER:-$DEFAULT_SENDER}"
    echo ""
    echo "Paste your SMS message (press Enter twice when done):"
    echo "──────────────────────────────────────────────────────"
    
    # Read multiline input until empty line
    SMS_TEXT=""
    while IFS= read -r line; do
        [ -z "$line" ] && break
        SMS_TEXT="$SMS_TEXT$line "
    done
    
    # Trim trailing space
    SMS_TEXT="${SMS_TEXT% }"
fi

if [ -z "$SMS_TEXT" ]; then
    echo "❌ Error: No SMS text provided!"
    exit 1
fi

# ── SEND REQUEST ───────────────────────────────────────────────────────────

echo ""
echo "📤 Sending to: $SUPABASE_URL"
echo "📨 Sender: $SENDER"
echo "📝 Message: $SMS_TEXT"
echo ""

# Build JSON payload (escape quotes in SMS text)
ESCAPED_TEXT=$(echo "$SMS_TEXT" | sed 's/"/\\"/g')
TIMESTAMP=$(date "+%b %d, %Y at %H:%M")

RESPONSE=$(curl -s -X POST "$SUPABASE_URL" \
    -H "Content-Type: application/json" \
    -H "x-webhook-secret: $WEBHOOK_SECRET" \
    -d "{
        \"source\": \"test_script\",
        \"sender\": \"$SENDER\",
        \"receivedAt\": \"$TIMESTAMP\",
        \"text\": \"$ESCAPED_TEXT\"
    }")

# ── SHOW RESULT ────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════════"
echo "  📬 RESPONSE"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Pretty print if jq is available, otherwise raw output
if command -v jq &> /dev/null; then
    echo "$RESPONSE" | jq .
else
    echo "$RESPONSE"
fi

echo ""

