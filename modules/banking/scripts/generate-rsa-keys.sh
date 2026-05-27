#!/usr/bin/env bash
# Generate RSA 4096 key pair for ICICI Corporate API registration.
# Run from FINAL_NURSERY_BE root:
#   bash modules/banking/scripts/generate-rsa-keys.sh

set -euo pipefail

CERT_DIR="${1:-config/certs}"
mkdir -p "$CERT_DIR"

echo "Generating RSA 4096 private key..."
openssl genrsa -out "$CERT_DIR/private.key" 4096

echo "Generating self-signed public certificate (365 days)..."
openssl req -new -x509 -key "$CERT_DIR/private.key" \
  -out "$CERT_DIR/public.crt" -days 365 \
  -subj "/C=IN/ST=Maharashtra/L=Pune/O=RamBiotech/OU=ERP/CN=erp-banking"

echo ""
echo "Done. Files created:"
echo "  $CERT_DIR/private.key   — keep secret, never commit"
echo "  $CERT_DIR/public.crt    — upload to ICICI during Registration API"
echo ""
echo "Download icici_public.crt from ICICI portal and save as:"
echo "  $CERT_DIR/icici_public.crt"
echo ""
echo "Set in .env:"
echo "  ICICI_PRIVATE_KEY_PATH=$CERT_DIR/private.key"
echo "  ICICI_PUBLIC_CERT_PATH=$CERT_DIR/public.crt"
echo "  ICICI_BANK_PUBLIC_CERT_PATH=$CERT_DIR/icici_public.crt"
